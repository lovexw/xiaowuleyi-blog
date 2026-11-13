import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

/* ── 第二批逻辑修复的回归断言（2026-11-04）──
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
