import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { formatInviteCode, genInviteCode, INVITE_CODE_RE, inviteRemaining, inviteStatus, normalizeInviteCode, normalizeMaxUses } from '../src/invite'
import { saveSettings } from '../src/db'

/* ── 注册邀请码（src/invite.ts）：码形态 / 归一化 / 一码一人 / 关闭注册时凭码可进 ── */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')
const ORIGIN = 'https://x.example.com'

// api.ts 经 render.ts 引主题（.css）——先挂顶替 hook 再动态加载（同 tests/member-tiers.test.ts）
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))

function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, import('node:sqlite').StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      const info = stmtOf(sql).run(...(binds as never[]))
      return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } }
    },
    all: async <T>() => ({ results: stmtOf(sql).all(...(binds as never[])) as T[] }),
    first: async <T>() => ((stmtOf(sql).get(...(binds as never[])) as T | undefined) ?? null),
  })
  return {
    prepare: (sql: string) => {
      const unbound = handlers(sql, [])
      return { ...unbound, bind: (...binds: unknown[]) => handlers(sql, binds) }
    },
    batch: async (stmts: { run: () => Promise<{ meta: { changes: number } }> }[]) => {
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  } as unknown as D1Database
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function setupDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  const { ensureSchema } = await import('../src/db')
  await ensureSchema(d1)
  await saveSettings(d1, { membersEnabled: '1', memberRegOpen: '1' })
  const now = Date.now()
  await d1
    .prepare("INSERT INTO users (username, password_hash, salt, display_name, role, created_at, updated_at) VALUES ('admin', 'x', 'y', '站长', 'admin', ?, ?)")
    .bind(now, now)
    .run()
  const adminId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number }).id
  const { createSession } = await import('../src/auth')
  const adminToken = await createSession(d1, adminId)
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
  const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never
  return { db, d1, env, ec, adminToken }
}

const adminHeaders = (token: string) => ({ ...JSON_HEADERS, Cookie: `bloghao_session=${token}` })

test('码形态：8 位 Crockford、随机不重复、展示分组、输入归一化', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const c = genInviteCode()
    assert.match(c, INVITE_CODE_RE)
    assert.equal(c.length, 8)
    seen.add(c)
  }
  assert.ok(seen.size >= 198, '200 次生成基本不重复（32^8 的空间，碰撞可忽略）')
  assert.equal(formatInviteCode('ABCD2345'), 'ABCD-2345')
  assert.equal(formatInviteCode(''), '')
  // 用户手输：小写、空格、连字符、下划线都容忍
  assert.equal(normalizeInviteCode(' abcd-2345 '), 'ABCD2345')
  assert.equal(normalizeInviteCode('abcd 2345'), 'ABCD2345')
  assert.equal(normalizeInviteCode('ABCD2345'), 'ABCD2345')
  // 长度不对 / 含易混字符（O、I 不在字母表里）→ 视为没填/码不对
  assert.equal(normalizeInviteCode('ABCD'), '')
  assert.equal(normalizeInviteCode('ABCDO123'), '')
  assert.equal(normalizeInviteCode('ABCDI123'), '')
  assert.equal(normalizeInviteCode(null), '')
  assert.equal(normalizeInviteCode(undefined), '')
})

test('邀请码状态与次数：可用 / 已用完 / 已过期三态的判定顺序与边界', () => {
  const now = 1_000_000
  // 一码一人：没用过 = 可用，用过 = 已用完
  assert.equal(inviteStatus({ max_uses: 1, used_count: 0 }, now), 'usable')
  assert.equal(inviteStatus({ max_uses: 1, used_count: 1 }, now), 'usedup')
  // 限量：没用完仍是可用，用满才 usedup
  assert.equal(inviteStatus({ max_uses: 3, used_count: 2 }, now), 'usable')
  assert.equal(inviteStatus({ max_uses: 3, used_count: 3 }, now), 'usedup')
  // 不限：用多少次都还是可用（max_uses = 0 不参与比较）
  assert.equal(inviteStatus({ max_uses: 0, used_count: 999 }, now), 'usable')
  // 过期：未用满 + 已过 expires_at = expired；恰好等于 now 也算过期（<= 口径）
  assert.equal(inviteStatus({ max_uses: 1, used_count: 0, expires_at: now - 1 }, now), 'expired')
  assert.equal(inviteStatus({ max_uses: 1, used_count: 0, expires_at: now }, now), 'expired')
  assert.equal(inviteStatus({ max_uses: 1, used_count: 0, expires_at: now + 1 }, now), 'usable')
  // 已用完优先于已过期：用光了就不关心它是不是还过期
  assert.equal(inviteStatus({ max_uses: 1, used_count: 1, expires_at: now - 1 }, now), 'usedup')
  // 老库刚 ALTER 出 used_count 列、还没回填的那一瞬间：只能按 used_at 推
  assert.equal(inviteStatus({ max_uses: 1, used_at: 123 }, now), 'usedup')
  assert.equal(inviteStatus({ max_uses: 1, used_at: null }, now), 'usable')
  // 脏值不炸：缺字段按「一码一人、未使用」处理
  assert.equal(inviteStatus({}, now), 'usable')

  // 剩余次数：不限量 = Infinity（展示层写「不限」）
  assert.equal(inviteRemaining({ max_uses: 0, used_count: 5 }), Infinity)
  assert.equal(inviteRemaining({ max_uses: 3, used_count: 1 }), 2)
  assert.equal(inviteRemaining({ max_uses: 3, used_count: 9 }), 0, '扣成负数没有意义，夹到 0')

  // 次数归一化：0 合法（不限），负数 / 超上限 / 非数字一律 null
  assert.equal(normalizeMaxUses(1), 1)
  assert.equal(normalizeMaxUses('0'), 0)
  assert.equal(normalizeMaxUses(1000), 1000)
  assert.equal(normalizeMaxUses(undefined), 1, '缺省按一码一人')
  assert.equal(normalizeMaxUses(-1), null)
  assert.equal(normalizeMaxUses(1001), null)
  assert.equal(normalizeMaxUses('abc'), null)
})

test('邀请码链路：生成 → 凭码注册拿档位 → 一码一人 → 关注册后凭码仍可进', async () => {
  const { db, d1, env, ec, adminToken } = await setupDb()
  const { api } = await import('../src/api')

  // 后台生成两个优质会员码
  const gen = await api.request(
    `${ORIGIN}/admin/invites`,
    { method: 'POST', headers: adminHeaders(adminToken), body: JSON.stringify({ tier: 'premium', count: 2, days: 0, note: '测试批' }) },
    env,
    ec
  )
  assert.equal(gen.status, 200, await gen.clone().text())
  const gj = (await gen.json()) as { codes: string[]; count: number; tier: string }
  assert.equal(gj.count, 2)
  assert.equal(gj.tier, 'premium')
  const [code1, code2] = gj.codes

  // 列表能看到（可用 2 个）
  const list = await api.request(`${ORIGIN}/admin/invites`, { headers: adminHeaders(adminToken) }, env, ec)
  const lj = (await list.json()) as { usable: number; usedup: number; expired: number; items: { code: string; tier: string }[] }
  assert.equal(lj.usable, 2)
  assert.equal(lj.usedup, 0)
  assert.equal(lj.expired, 0)
  assert.ok(lj.items.some((x) => x.code === code1 && x.tier === 'premium'))

  // 凭码注册：带连字符输入也能认（前端展示形态与存库形态不同）
  const reg = await api.request(
    `${ORIGIN}/member/register`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'vip1', password: 'pass12345', inviteCode: formatInviteCode(code1) }) },
    env,
    ec
  )
  assert.equal(reg.status, 200, await reg.clone().text())
  const row = db.prepare("SELECT tier, tier_expires_at FROM members WHERE username = 'vip1'").get() as { tier: string; tier_expires_at: number | null }
  assert.equal(row.tier, 'premium', '持码注册直接拿到码上指定的档位')
  assert.equal(row.tier_expires_at, null, '优质会员是永久档，不写有效期')

  // 同一个码再用一次 → 400（一次性）
  const again = await api.request(
    `${ORIGIN}/member/register`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'vip2', password: 'pass12345', inviteCode: code1 }) },
    env,
    ec
  )
  assert.equal(again.status, 400)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members WHERE username = 'vip2'").get<{ n: number }>()?.n ?? 0, 0, '失败不留半成品会员')

  // 关闭开放注册：无码 403，有码照进
  await saveSettings(d1, { memberRegOpen: '0' })
  const noCode = await api.request(
    `${ORIGIN}/member/register`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'vip3', password: 'pass12345' }) },
    env,
    ec
  )
  assert.equal(noCode.status, 403, '关注册后没码进不来')
  const withCode = await api.request(
    `${ORIGIN}/member/register`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'vip4', password: 'pass12345', inviteCode: code2 }) },
    env,
    ec
  )
  assert.equal(withCode.status, 200, '邀请码是关闭注册后的唯一入口')
  const row4 = db.prepare("SELECT tier FROM members WHERE username = 'vip4'").get() as { tier: string }
  assert.equal(row4.tier, 'premium')

  // 已使用的码不能撤销；未使用的可以
  const items = db.prepare('SELECT id, code, used_count FROM invite_codes ORDER BY id').all() as { id: number; code: string; used_count: number }[]
  const usedId = items.find((x) => x.used_count > 0)!.id
  const delUsed = await api.request(`${ORIGIN}/admin/invites/${usedId}`, { method: 'DELETE', headers: adminHeaders(adminToken) }, env, ec)
  assert.equal(delUsed.status, 409, '已核销的码是账，删不掉')

  // 生成时挡脏档位与超量
  const badTier = await api.request(
    `${ORIGIN}/admin/invites`,
    { method: 'POST', headers: adminHeaders(adminToken), body: JSON.stringify({ tier: 'ghost', count: 1 }) },
    env,
    ec
  )
  assert.equal(badTier.status, 400)
  const tooMany = await api.request(
    `${ORIGIN}/admin/invites`,
    { method: 'POST', headers: adminHeaders(adminToken), body: JSON.stringify({ tier: 'premium', count: 99 }) },
    env,
    ec
  )
  assert.equal(tooMany.status, 400)
})

test('邀请码过期：过了码有效期再注册 → 400', async () => {
  const { db, d1, env, ec } = await setupDb()
  const { api } = await import('../src/api')
  const now = Date.now()
  // 直接落一个昨天就过期的码
  await d1
    .prepare("INSERT INTO invite_codes (code, tier, note, created_at, expires_at) VALUES ('QRTY2345', 'premium', '', ?, ?)")
    .bind(now - 86_400_000 * 2, now - 86_400_000)
    .run()
  const res = await api.request(
    `${ORIGIN}/member/register`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'late1', password: 'pass12345', inviteCode: 'QRTY2345' }) },
    env,
    ec
  )
  assert.equal(res.status, 400)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members WHERE username = 'late1'").get<{ n: number }>()?.n ?? 0, 0)
})

/** 注册一次的薄封装：返回状态码，省掉重复的 request 样板。
 *  每个 username 走不同 IP——注册限流是「每 IP 10 分钟 5 次」，一码多人的用例必然超这个额度，
 *  撞的是限流而不是被测逻辑（真实场景一码多人也来自不同 IP） */
function registerWith(
  api: { request: (u: string, i: RequestInit, env: unknown, ec: unknown) => Promise<Response> },
  env: unknown,
  ec: unknown,
  username: string,
  code?: string
) {
  const ip = `10.0.${username.length}.${username.charCodeAt(username.length - 1)}`
  return api.request(
    `${ORIGIN}/member/register`,
    {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'CF-Connecting-IP': ip },
      body: JSON.stringify({ username, password: 'pass12345', ...(code ? { inviteCode: code } : {}) }),
    },
    env,
    ec
  )
}

test('限量邀请码：限 3 次的码能进 3 个人，第 4 个被挡；核销明细逐条可查', async () => {
  const { db, d1, env, ec, adminToken } = await setupDb()
  const { api } = await import('../src/api')
  const gen = await api.request(
    `${ORIGIN}/admin/invites`,
    { method: 'POST', headers: adminHeaders(adminToken), body: JSON.stringify({ tier: 'premium', count: 1, days: 0, maxUses: 3, note: '会员群福利' }) },
    env,
    ec
  )
  assert.equal(gen.status, 200, await gen.clone().text())
  const gj = (await gen.json()) as { codes: string[]; maxUses: number }
  assert.equal(gj.maxUses, 3)
  const code = gj.codes[0]

  for (let i = 1; i <= 3; i++) {
    const r = await registerWith(api, env, ec, `batch${i}`, code)
    assert.equal(r.status, 200, `第 ${i} 位凭码注册应当成功：${await r.clone().text()}`)
  }
  const fourth = await registerWith(api, env, ec, 'batch4', code)
  assert.equal(fourth.status, 400, '次数用尽后第 4 个进不来')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members WHERE username = 'batch4'").get<{ n: number }>()?.n ?? 0, 0)

  const row = db.prepare('SELECT used_count, max_uses FROM invite_codes WHERE code = ?').get(code) as { used_count: number; max_uses: number }
  assert.equal(row.used_count, 3)
  assert.equal(row.max_uses, 3)

  // 明细：三条，一人一条，码快照与档位都在
  const detail = await api.request(`${ORIGIN}/admin/invites/${(db.prepare('SELECT id FROM invite_codes WHERE code = ?').get(code) as { id: number }).id}/uses`, { headers: adminHeaders(adminToken) }, env, ec)
  assert.equal(detail.status, 200)
  const dj = (await detail.json()) as { uses: { member_name: string; tier: string }[]; tiers: unknown[] }
  assert.equal(dj.uses.length, 3, '每次核销一条明细，一码多人靠它回查')
  assert.deepEqual(dj.uses.map((u) => u.member_name).sort(), ['batch1', 'batch2', 'batch3'])
  assert.ok(dj.uses.every((u) => u.tier === 'premium'))
  assert.ok(Array.isArray(dj.tiers) && dj.tiers.length >= 3, '明细接口带上档位定义，弹窗里能把 key 翻成名字')
})

test('不限次数邀请码：max_uses = 0 可无限次注册，且永远算「可用」', async () => {
  const { db, env, ec, adminToken } = await setupDb()
  const { api } = await import('../src/api')
  const gen = await api.request(
    `${ORIGIN}/admin/invites`,
    { method: 'POST', headers: adminHeaders(adminToken), body: JSON.stringify({ tier: 'premium', count: 1, days: 0, maxUses: 0 }) },
    env,
    ec
  )
  const gj = (await gen.json()) as { codes: string[]; maxUses: number }
  assert.equal(gj.maxUses, 0)
  const code = gj.codes[0]
  for (let i = 1; i <= 5; i++) {
    const r = await registerWith(api, env, ec, `forever${i}`, code)
    assert.equal(r.status, 200, `不限次数的码第 ${i} 次也应当能进`)
  }
  const row = db.prepare('SELECT used_count, max_uses FROM invite_codes WHERE code = ?').get(code) as { used_count: number; max_uses: number }
  assert.equal(row.used_count, 5)
  // 已用 5 次但上限为 0（不限）→ 仍然「可用」，后台不该把它归进已用完
  const list = await api.request(`${ORIGIN}/admin/invites?status=usable`, { headers: adminHeaders(adminToken) }, env, ec)
  const lj = (await list.json()) as { usable: number; items: { code: string }[] }
  assert.equal(lj.usable, 1)
  assert.equal(lj.items[0].code, code)
})

test('次数上限与次数为负：生成接口拒绝脏值', async () => {
  const { env, ec, adminToken } = await setupDb()
  const { api } = await import('../src/api')
  for (const bad of [-1, 1001, 'abc']) {
    const r = await api.request(
      `${ORIGIN}/admin/invites`,
      { method: 'POST', headers: adminHeaders(adminToken), body: JSON.stringify({ tier: 'premium', count: 1, maxUses: bad }) },
      env,
      ec
    )
    assert.equal(r.status, 400, `maxUses=${bad} 应当被拒`)
  }
})
