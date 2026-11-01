import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { saveSettings } from '../src/db'

/* ── 积分兑换优质会员（2026-11 会员第五批）：
 *    价格 0 = 未开放 / 余额不足整笔不生效 / 一次兑换永久有效 / 已在该档及以上不白扣分 ── */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')
const ORIGIN = 'https://x.example.com'

// api.ts 经 render.ts 引主题（.css）——先挂顶替 hook 再动态加载（同 tests/invite.test.ts）
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

/** 建库 + 一个已登录会员。points 直接写库（积分怎么攒的不是这个用例要验的） */
async function setup(opts: { points: number; tier?: string; cost?: string }) {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  const { ensureSchema } = await import('../src/db')
  await ensureSchema(d1)
  await saveSettings(d1, { membersEnabled: '1', memberRegOpen: '1', premiumPointsCost: opts.cost ?? '0' })
  const now = Date.now()
  await d1
    .prepare(
      "INSERT INTO members (username, password_hash, salt, email, display_name, avatar, tier, points, status, created_at, updated_at) VALUES ('fan', 'x', 'y', '', '阿粉', '', ?, ?, 'active', ?, ?)"
    )
    .bind(opts.tier ?? 'normal', opts.points, now, now)
    .run()
  const memberId = (db.prepare("SELECT id FROM members WHERE username = 'fan'").get() as { id: number }).id
  const { createMemberSession, MEMBER_SESSION_COOKIE } = await import('../src/auth')
  const token = await createMemberSession(d1, memberId)
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
  const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never
  const headers = { ...JSON_HEADERS, Cookie: `${MEMBER_SESSION_COOKIE}=${token}` }
  return { db, d1, env, ec, headers, memberId }
}

const redeem = (api: { request: (u: string, i: RequestInit, env: unknown, ec: unknown) => Promise<Response> }, env: unknown, ec: unknown, headers: Record<string, string>) =>
  api.request(`${ORIGIN}/member/redeem-premium`, { method: 'POST', headers }, env, ec)

test('积分兑换：价格 0 = 未开放，接口直接拒（默认状态）', async () => {
  const { env, ec, headers } = await setup({ points: 9999, cost: '0' })
  const { api } = await import('../src/api')
  const r = await redeem(api, env, ec, headers)
  assert.equal(r.status, 400)
  assert.match(((await r.json()) as { error: string }).error, /暂未开放/)
})

test('积分兑换：余额不足整笔不生效（积分不动、档位不动、账本不留脏行）', async () => {
  const { db, env, ec, headers } = await setup({ points: 100, cost: '200' })
  const { api } = await import('../src/api')
  const r = await redeem(api, env, ec, headers)
  assert.equal(r.status, 400)
  assert.match(((await r.json()) as { error: string }).error, /还差 100 分/)
  const row = db.prepare("SELECT tier, points FROM members WHERE username = 'fan'").get() as { tier: string; points: number }
  assert.equal(row.points, 100, '积分一分不扣')
  assert.equal(row.tier, 'normal', '档位不变')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM member_points_log').get<{ n: number }>()?.n ?? 0, 0, '失败不留账本行')
})

test('积分兑换：余额够 → 扣分 + 升优质会员 + 记来源，且只允许兑换一次', async () => {
  const { db, env, ec, headers } = await setup({ points: 300, cost: '200' })
  const { api } = await import('../src/api')
  const r = await redeem(api, env, ec, headers)
  assert.equal(r.status, 200, await r.clone().text())
  const j = (await r.json()) as { points: number; tier: string; tierName: string }
  assert.equal(j.points, 100, '扣掉 200 分')
  assert.equal(j.tier, 'premium')
  assert.equal(j.tierName, '优质会员')
  const row = db.prepare("SELECT tier, tier_source, tier_expires_at, points FROM members WHERE username = 'fan'").get() as {
    tier: string
    tier_source: string
    tier_expires_at: number | null
    points: number
  }
  assert.equal(row.points, 100)
  assert.equal(row.tier, 'premium')
  assert.equal(row.tier_source, 'points', '后台列表能看出这个优质会员是积分换来的')
  assert.equal(row.tier_expires_at, null, '优质会员是永久档')
  const log = db.prepare("SELECT delta, reason, ref_id FROM member_points_log WHERE reason = 'redeemTier'").all() as { delta: number; reason: string; ref_id: number }[]
  assert.equal(log.length, 1)
  assert.equal(log[0].delta, -200, '账本记负数')
  assert.equal(log[0].ref_id, 1, '一次性动作的幂等键固定为 1')

  // 再兑换一次：已经是优质会员 → 拒
  const again = await redeem(api, env, ec, headers)
  assert.equal(again.status, 400)
  assert.match(((await again.json()) as { error: string }).error, /已经是/)
  assert.equal(db.prepare("SELECT points FROM members WHERE username = 'fan'").get()?.points, 100, '第二次不扣分')
})

test('积分兑换：已经是咖啡会员（更高档）就不出兑换口，调用也被拒', async () => {
  const { db, env, ec, headers } = await setup({ points: 9999, cost: '200', tier: 'coffee' })
  const { api } = await import('../src/api')
  const r = await redeem(api, env, ec, headers)
  assert.equal(r.status, 400)
  assert.equal(db.prepare("SELECT points FROM members WHERE username = 'fan'").get()?.points, 9999, '一分不扣')
})

test('积分兑换：未登录 401（不能让路过的请求白扣分）', async () => {
  const { env, ec } = await setup({ points: 9999, cost: '200' })
  const { api } = await import('../src/api')
  const r = await redeem(api, env, ec, JSON_HEADERS)
  assert.equal(r.status, 401)
})

test('积分兑换：会员中心渲染出兑换卡，价格 0 时整块不出', async () => {
  const { api } = await import('../src/api')
  const { memberCardHtml } = await import('../src/render')
  const base = { nickname: '阿粉', tier: 'normal', tierName: '注册会员', tierIsBase: true, points: 300, tierExpiresAt: null } as never

  // 价格 0（未开放）：没有升级卡
  const off = memberCardHtml({ ...base, upgradeTargetName: '优质会员' } as never)
  assert.ok(!off.includes('data-member-upgrade'), '价格 0 时不该出现兑换入口')

  // 价格 200、余额 300：出卡、按钮可用
  const on = memberCardHtml({ ...base, upgradeTargetName: '优质会员', upgradeCost: 200 } as never)
  assert.ok(on.includes('data-member-upgrade'))
  assert.ok(on.includes('data-member-redeem'))
  assert.ok(!on.includes('disabled'), '积分够时按钮不该 disabled')

  // 价格 500、余额 300：按钮禁用并写明还差多少
  const poor = memberCardHtml({ ...base, upgradeTargetName: '优质会员', upgradeCost: 500 } as never)
  assert.ok(poor.includes('disabled'))
  assert.ok(poor.includes('还差 200 积分'))

  // 已经是优质会员（服务端不下发 upgradeTargetName）：整块不出
  const done = memberCardHtml({ ...base, upgradeCost: 200 } as never)
  assert.ok(!done.includes('data-member-upgrade'))

  // 付费说明：没有积分兑换也能只靠一段文案出卡
  const paid = memberCardHtml({ ...base, upgradeTargetName: '优质会员', paidNote: '加微信 xxx 转账 ¥99' } as never)
  assert.ok(paid.includes('data-member-upgrade'))
  assert.ok(paid.includes('加微信 xxx 转账 ¥99'))
  assert.ok(!paid.includes('data-member-redeem'), '只有付费说明时不出兑换按钮')
  void api
})
