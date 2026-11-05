import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

/* ── 第二批逻辑修复的回归断言（2026-11-04）──
 * 1) 会员浏览足迹：一次请求只判一次 shouldCountView，去重键带 host
 * 2) 过期会员降权：会话 SQL 带出 tier_expires_at
 * 3) TG 幂等：只记「处理完」的 update_id，异常重投必须放行
 * 4) 积分扣款：批内原子，不依赖批外补偿 DELETE（幽灵账本行）
 * 5) 邀请码数据：进每晚备份与整站包
 * 6) 会员开关：/member/* 统一守卫，logout 例外
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8')
const ORIGIN = 'https://x.example.com'

// api.ts / external.ts 经 render.ts 引主题 .css（wrangler 有 Text rule，tsx 没有）
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))

function d1FromSqlite(raw: DatabaseSync, onPrepare?: (sql: string) => void): D1Database {
  const cache = new Map<string, import('node:sqlite').StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = raw.prepare(sql)))
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
      onPrepare?.(sql)
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

function newDb(): DatabaseSync {
  const raw = new DatabaseSync(':memory:')
  raw.exec(SCHEMA)
  return raw
}

const pointsOf = (raw: DatabaseSync) => (raw.prepare('SELECT points FROM members WHERE id = 1').get() as { points: number }).points
const logRows = (raw: DatabaseSync) => (raw.prepare('SELECT COUNT(*) AS n FROM member_points_log').get() as { n: number }).n

test('会员浏览足迹：一次请求只判一次 shouldCountView，去重键按 host 隔离', () => {
  const src = readFileSync(join(ROOT, 'src/pages.ts'), 'utf8')
  // 函数定义 1 次 + renderPost 里调用 1 次。旧版调 2 次：第二次恒为 false，
  // recordMemberVisit 因此从来没执行过。
  assert.equal([...src.matchAll(/shouldCountView\(/g)].length, 2)
  assert.ok(/const countThisView =/.test(src), '应当把判定结果存成变量')
  assert.ok(/member && !pwLocked && countThisView/.test(src), '会员足迹要复用同一次判定')
  assert.ok(src.includes('${host}:${ip}:${postId}'), 'Node 多租户共进程，去重键不带 host 会跨站误伤')
})

test('过期会员降权：会话带出 tier_expires_at，付费墙按生效档位拒读', async () => {
  const raw = newDb()
  const db = d1FromSqlite(raw)
  const { ensureSchema } = await import('../src/db')
  await ensureSchema(db)
  const now = Date.now()
  raw
    .prepare(
      `INSERT INTO members (username, password_hash, salt, tier, tier_expires_at, points, status, created_at, updated_at)
       VALUES ('fan', 'x', 'y', 'coffee', ?, 0, 'active', ?, ?)`
    )
    .run(now - 60_000, now, now)
  const { createMemberSession, getMemberUser, MEMBER_SESSION_COOKIE } = await import('../src/auth')
  const token = await createMemberSession(db, 1)
  const req = new Request(`${ORIGIN}/member/me`, { headers: { Cookie: `${MEMBER_SESSION_COOKIE}=${token}` } })
  const member = await getMemberUser(db, req)
  assert.ok(member)
  assert.equal(member.tier, 'coffee')
  assert.equal(member.tier_expires_at, now - 60_000, '会话必须带出档位到期时间')
  const { canReadTiers, parseMemberTiers } = await import('../src/tiers')
  const defs = parseMemberTiers('')
  assert.equal(canReadTiers(defs, 'coffee', member, now), false, '过期咖啡会员按基础档处理，读不了咖啡档文章')
  // 对照：未过期的同档会员仍然放行（不能为了修过期把正常会员一起锁掉）
  raw.prepare('UPDATE members SET tier_expires_at = ? WHERE id = 1').run(now + 60_000)
  const fresh = await getMemberUser(db, req)
  assert.equal(canReadTiers(defs, 'coffee', fresh, now), true)
})

test('TG 幂等：只有标记过「已处理完」的 update_id 才挡重投；幂等键按租户（env）隔离（P1-2）', async () => {
  const { tgUpdateDone, tgMarkUpdateDone } = await import('../src/external')
  const now = 1_700_000_000_000
  const id = 8_888_881
  const scope = {}
  assert.equal(tgUpdateDone(scope, id, now), false, '没处理过不能挡')
  assert.equal(tgUpdateDone(scope, id, now + 60_000), false, '处理中抛错后 TG 重投必须放行')
  tgMarkUpdateDone(scope, id, now)
  assert.equal(tgUpdateDone(scope, id, now + 60_000), true, '成功处理后 5 分钟内挡住重投')
  assert.equal(tgUpdateDone(scope, id, now + 5 * 60_000), false, '超过 5 分钟窗口不再挡')
  assert.equal(tgUpdateDone(scope, id + 1, now), false, '别的 update 不受影响')
  // 跨租户隔离：update_id 是 per-bot 序列，A 租户处理完 N 不能挡 B 租户自己的 N
  const otherTenant = {}
  assert.equal(tgUpdateDone(otherTenant, id, now + 60_000), false, 'B 租户同 update_id 不被 A 租户挡掉')
  tgMarkUpdateDone(otherTenant, id, now + 60_000)
  assert.equal(tgUpdateDone(otherTenant, id, now + 90_000), true, 'B 租户自己的记账独立生效')
})

test('扣积分：余额不足不留幽灵账本行，且实现里不再有批外补偿 DELETE', async () => {
  const raw = newDb()
  const db = d1FromSqlite(raw, (sql) => {
    // 旧实现靠批外 DELETE 收拾失败插入的账本行；新实现不该再 prepare 这种语句，
    // 一旦出现就直接让测试失败（也顺带模拟「补偿 DELETE 执行不了」的真实故障）。
    if (/DELETE\s+FROM\s+member_points_log/i.test(sql)) throw new Error('批外补偿 DELETE 已被移除')
  })
  const now = Date.now()
  raw
    .prepare(
      `INSERT INTO members (username, password_hash, salt, tier, points, status, created_at, updated_at)
       VALUES ('fan', 'x', 'y', 'normal', ?, 'active', ?, ?)`
    )
    .run(100, now, now)
  const { spendPoints } = await import('../src/points')
  const poor = await spendPoints(db, 1, 200, 'redeemTier', '', 1)
  assert.equal(poor.ok, false)
  assert.equal(poor.reason, 'poor')
  assert.equal(pointsOf(raw), 100, '一分不扣')
  assert.equal(logRows(raw), 0, '失败不落账本')
  // 补足积分后仍要能兑换：旧实现的幽灵行会占住 (member,reason,refId) 唯一索引，永久换不了
  raw.prepare('UPDATE members SET points = 300 WHERE id = 1').run()
  const ok = await spendPoints(db, 1, 200, 'redeemTier', '', 1)
  assert.equal(ok.ok, true)
  assert.equal(pointsOf(raw), 100)
  assert.equal(logRows(raw), 1)
  const dup = await spendPoints(db, 1, 200, 'redeemTier', '', 1)
  assert.equal(dup.reason, 'dup', '同一 refId 只认一次')
  assert.equal(pointsOf(raw), 100, '重复兑换不二次扣分')
})

test('邀请码与核销明细进每晚备份和整站包', () => {
  const backup = readFileSync(join(ROOT, 'src/backup.ts'), 'utf8')
  const bundle = readFileSync(join(ROOT, 'src/sitebundle.ts'), 'utf8')
  const tablesOf = (src: string, re: RegExp) => [...(src.match(re)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1])
  const bt = tablesOf(backup, /const BACKUP_TABLES = \[([^\]]*)\]/)
  const st = tablesOf(bundle, /export const BUNDLE_TABLES = \[([^\]]*)\]/)
  assert.ok(bt.length > 0 && st.length > 0, '清单解析失败')
  for (const t of ['invite_codes', 'invite_uses']) {
    assert.ok(bt.includes(t), `${t} 必须进每晚备份`)
    assert.ok(st.includes(t), `${t} 必须进整站包`)
  }
  assert.equal(st.includes('users'), false, '管理员账号仍不进整站包')
})

test('会员开关统一守卫：关闭后 /member/* 全挡，logout 仍能清 Cookie', async () => {
  const raw = newDb()
  const db = d1FromSqlite(raw)
  const { ensureSchema, saveSettings } = await import('../src/db')
  await ensureSchema(db)
  await saveSettings(db, { membersEnabled: '0' })
  const { api } = await import('../src/api')
  const env = { DB: db, IMAGES: {}, ASSETS: {} } as never
  const ec = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  const me = await api.request(`${ORIGIN}/member/me`, {}, env, ec)
  assert.equal(me.status, 404, '会员功能关闭时 /member/me 不可用')
  const logout = await api.request(`${ORIGIN}/member/logout`, { method: 'POST' }, env, ec)
  assert.equal(logout.status, 200, 'logout 是清 Cookie 的口子，不该被开关挡住')
  await saveSettings(db, { membersEnabled: '1' })
  const open = await api.request(`${ORIGIN}/member/me`, {}, env, ec)
  assert.equal(open.status, 200, '打开开关后恢复可用')
})

test('TG webhook 中间件：只有 2xx 才记账，401/403 的重投仍能进正常链路', async () => {
  const raw = newDb()
  const db = d1FromSqlite(raw)
  const { ensureSchema, saveSettings } = await import('../src/db')
  await ensureSchema(db)
  await saveSettings(db, { telegramBotToken: 'fake-token', telegramWebhookSecret: 's3cret' })
  const { telegramRoutes } = await import('../src/external')
  const env = { DB: db, IMAGES: {}, ASSETS: {} } as never
  const ec = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  const url = `${ORIGIN}/webhook`
  // 故意不带 message：handler 只回 ok，不触发任何外发/TG API
  const send = (updateId: number, secret: string) =>
    telegramRoutes.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
        body: JSON.stringify({ update_id: updateId }),
      },
      env,
      ec
    )

  // ① secret 错 → 401，不能被记成「已完成」
  const bad = await send(7_777_001, 'wrong')
  assert.equal(bad.status, 401)
  // ② 关掉 botToken 后用正确 secret 重投同一 update_id：若 401 被误记账，这里会被短路成
  //    200；没被记账则走进 handler 拿到 403。用状态差异判定是否真的进了正常链路。
  await saveSettings(db, { telegramBotToken: '' })
  const retry = await send(7_777_001, 's3cret')
  assert.equal(retry.status, 403, '401 不该记账，重投必须能进正常链路')

  // ③ 重新打开，正常处理一次 → 2xx 后才记账
  await saveSettings(db, { telegramBotToken: 'fake-token' })
  const first = await send(7_777_002, 's3cret')
  assert.equal(first.status, 200)
  // ④ 再关掉 botToken：已被记账的重投应短路成 200，而不是重新走到 403
  await saveSettings(db, { telegramBotToken: '' })
  const again = await send(7_777_002, 's3cret')
  assert.equal(again.status, 200, '成功处理过的 update_id 重投要被挡住')
})
