import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createD1 } from '../docker-poc/shims/d1.ts'
import { SCHEMA_INDEXES, getSettings } from '../src/db.ts'

/* ── 第三批性能修复的回归断言（2026-11-04）──
 * 1) docker-poc/shims/d1.ts 语句缓存：同一 SQL 不重复解析、不同 bind 不串参、DDL 后失效
 * 2) 索引：comments.qq / sessions.user_id / member_sessions.member_id 三条查询真走索引、不扫全表
 * 3) 索引归位：会话两条双份登记，comments.qq 只进 SCHEMA_INDEXES（老库运行时补列）
 * 4) getSettings：并发读返回各自副本，后台把密钥改掩码不会污染别的请求
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 给 node:sqlite 的 prepare 打点：验证 SQL 语句到底被解析了几次 */
function withPrepareCounter<T>(fn: (count: () => number) => Promise<T> | T): Promise<T> | T {
  const proto = DatabaseSync.prototype as unknown as { prepare: (sql: string) => unknown }
  const original = proto.prepare
  let n = 0
  proto.prepare = function (this: DatabaseSync, sql: string) {
    n += 1
    return original.call(this, sql)
  }
  const done = () => {
    proto.prepare = original
  }
  try {
    const out = fn(() => n)
    return out instanceof Promise ? out.finally(done) : (done(), out)
  } catch (e) {
    done()
    throw e
  }
}

test('D1 shim：同一条 SQL 只解析一次，不同 bind 不串参', async () => {
  await withPrepareCounter(async (count) => {
    const d1 = createD1(':memory:')
    try {
      await d1.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      const before = count()
      for (let i = 0; i < 20; i++) await d1.prepare('INSERT INTO t (v) VALUES (?)').bind(`v${i}`).run()
      assert.equal(count() - before, 1, '20 次插入同一条 SQL 只应 prepare 一次')
      const a = await d1.prepare('SELECT v FROM t WHERE id = ?').bind(3).all<{ v: string }>()
      const b = await d1.prepare('SELECT v FROM t WHERE id = ?').bind(5).all<{ v: string }>()
      assert.equal(a.results[0].v, 'v2', '第一次 bind 的结果正确')
      assert.equal(b.results[0].v, 'v4', '复用 statement 后第二次 bind 不能被上一次的参数污染')
      const rows = await d1.prepare('SELECT * FROM t').all<{ v: string }>()
      assert.equal(rows.results.length, 20)
      assert.equal(Object.getPrototypeOf(rows.results[0]), Object.prototype, '行必须是普通对象（业务代码会解构 / JSON 序列化）')
    } finally {
      d1.close()
    }
  })
})

test('D1 shim：DDL 清空语句缓存，schema 变更后不复用旧编译结果', async () => {
  await withPrepareCounter(async (count) => {
    const d1 = createD1(':memory:')
    try {
      await d1.exec('CREATE TABLE t (a TEXT)')
      await d1.prepare('SELECT * FROM t').all()
      await d1.prepare('SELECT * FROM t').all()
      assert.equal(count(), 1, '缓存命中期间不重复 prepare')
      // 走 prepare().run() 的 DDL（ensureSchema 就是这么建表 / 建索引的）
      await d1.prepare('ALTER TABLE t ADD COLUMN b TEXT').run()
      await d1.prepare('SELECT * FROM t').all()
      assert.equal(count(), 3, 'DDL 与之后的查询都要重新 prepare（缓存已清）')
      await d1.prepare('INSERT INTO t (a, b) VALUES (?, ?)').bind('x', 'y').run()
      const r = await d1.prepare('SELECT * FROM t').all<{ a: string; b: string }>()
      assert.equal(r.results[0].b, 'y', 'ALTER 加的列能正常读写')
    } finally {
      d1.close()
    }
  })
})

function seededDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  // 生产冷启动形态：schema.sql + ensureSchema 的 SCHEMA_INDEXES
  for (const ddl of SCHEMA_INDEXES) db.exec(ddl)
  const c = db.prepare(
    'INSERT INTO comments (post_id, nickname, qq, avatar, content, status, created_at) VALUES (0, ?, ?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < 300; i++) {
    c.run(`访客${i}`, i % 2 ? '10001' : '', i % 3 ? '/images/a.png' : '', '内容', 'approved', 1700000000000 + i)
  }
  const s = db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
  const ms = db.prepare('INSERT INTO member_sessions (token, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
  for (let i = 0; i < 120; i++) {
    s.run(`t${i}`, i % 7 + 1, 1800000000000 + i, 1700000000000 + i)
    ms.run(`m${i}`, i % 7 + 1, 1800000000000 + i, 1700000000000 + i)
  }
  return db
}

function planOf(db: DatabaseSync, sql: string): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String((r as { detail: unknown }).detail))
    .join(' | ')
}

test('EXPLAIN：游客 QQ 头像反查走 idx_comments_qq，不扫全表评论', () => {
  const db = seededDb()
  const plan = planOf(db, "SELECT avatar FROM comments WHERE qq = ? AND avatar != '' ORDER BY created_at DESC LIMIT 1")
  assert.ok(plan.includes('USING INDEX idx_comments_qq'), `未走 idx_comments_qq：${plan}`)
  assert.ok(!/SCAN comments(?! USING INDEX)/.test(plan), `全表扫评论：${plan}`)
  assert.ok(!plan.includes('TEMP B-TREE'), `ORDER BY 触发临时排序：${plan}`)
  db.close()
})

test('EXPLAIN：管理员 / 会员会话按账号统计与清理都走新索引', () => {
  const db = seededDb()
  // COUNT 只取索引列时 SQLite 会给出 USING COVERING INDEX（比 USING INDEX 更好，连表都不回）
  const uses = (plan: string, index: string) => new RegExp(`USING (?:COVERING )?INDEX ${index}\\b`).test(plan)
  const s1 = planOf(db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
  assert.ok(uses(s1, 'idx_sessions_user'), `会话计数未走索引：${s1}`)
  assert.ok(!/SCAN sessions/.test(s1), `会话计数全表扫：${s1}`)
  const s2 = planOf(db, 'DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?')
  assert.ok(uses(s2, 'idx_sessions_user'), `过期会话清理未走索引：${s2}`)
  const m1 = planOf(db, 'SELECT COUNT(*) AS n FROM member_sessions WHERE member_id = ?')
  assert.ok(uses(m1, 'idx_member_sessions_member'), `会员会话计数未走索引：${m1}`)
  assert.ok(!/SCAN member_sessions/.test(m1), `会员会话计数全表扫：${m1}`)
  const m2 = planOf(db, 'DELETE FROM member_sessions WHERE member_id = ? AND expires_at <= ?')
  assert.ok(uses(m2, 'idx_member_sessions_member'), `会员过期会话清理未走索引：${m2}`)
  db.close()
})

test('索引归位：会话索引双份登记，comments.qq 只进 SCHEMA_INDEXES', () => {
  const sql = norm(SCHEMA_SQL)
  for (const ddl of [
    'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_member_sessions_member ON member_sessions (member_id, expires_at)',
  ]) {
    assert.ok(sql.includes(norm(ddl)), `schema.sql 缺：${ddl}`)
    assert.ok(SCHEMA_INDEXES.includes(ddl), `SCHEMA_INDEXES 缺：${ddl}`)
  }
  const qqDdl = 'CREATE INDEX IF NOT EXISTS idx_comments_qq ON comments (qq, created_at DESC)'
  assert.ok(SCHEMA_INDEXES.includes(qqDdl), 'SCHEMA_INDEXES 缺 idx_comments_qq')
  assert.ok(!sql.includes(norm(qqDdl)), 'comments.qq 是老库运行时 ALTER 补的列，索引不得进 schema.sql')
})

test('getSettings：并发读各拿副本，后台改掩码不污染别的请求', async () => {
  const g = globalThis as { caches?: unknown }
  const saved = g.caches
  const had = Object.prototype.hasOwnProperty.call(g, 'caches')
  delete g.caches
  const db = {
    prepare: () => ({
      all: async () => ({ results: [{ key: 'siteTitle', value: '原值' }] }),
      first: async () => null,
      run: async () => ({ success: true }),
      bind: () => { throw new Error('本用例不应走到 bind') },
    }),
  } as unknown as D1Database
  try {
    const [a, b] = await Promise.all([getSettings(db), getSettings(db)])
    a.siteTitle = 'MASK'
    assert.equal(b.siteTitle, '原值', '并发共享 in-flight 结果时，一个调用改写不能影响另一个')
    assert.equal((await getSettings(db)).siteTitle, '原值', '后续读也不能拿到被改过的对象')
  } finally {
    if (had) g.caches = saved
  }
})
