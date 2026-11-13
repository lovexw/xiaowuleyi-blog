import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

/* ── 老库升级顺序守卫（2026-11 审计 P1-1）：docker-poc/server.ts 的建表流程必须是
 *    「exec(schema.sql) 失败 → ensureSchema 补列 → 幂等重放」。
 *    背景：核心九表唯一来源是 schema.sql（ensureSchema 单独跑会被 no such table: settings
 *    炸掉，所以 exec 必须先行），但 schema.sql 的部分索引引用 deleted_at / weibo.pinned
 *    这类「老库靠 ALTER 补」的列——老库直接 exec 会崩掉 loadTenants。
 *    本文件用「trash 功能之前的库」复刻两种库形态，钉死 server.ts 的实际序列。 ── */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

// api.ts 经 render.ts 引主题（.css）——先挂顶替 hook 再动态加载（同 tests/themes.test.ts）
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))

/** 最小 D1 适配（同 tests/member-tiers.test.ts 的 d1FromSqlite 口径） */
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
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  } as unknown as D1Database
}

/** 造一个「trash 功能之前」的老库：三表没有 deleted_at，weibo 没有 pinned/video */
function makeOldDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, summary TEXT DEFAULT '', status TEXT DEFAULT 'draft',
      published_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE weibo (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, images TEXT DEFAULT '',
      status TEXT DEFAULT 'published', created_at INTEGER NOT NULL
    );
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT DEFAULT 'published',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  return db
}

/** server.ts createTenantFor 的建表序列（1:1 镜像，改动两处必须同步） */
async function bootstrapLikeServer(db: DatabaseSync, d1: D1Database): Promise<void> {
  const { ensureSchema } = await import('../src/db')
  try {
    db.exec(SCHEMA_SQL)
  } catch {
    await ensureSchema(d1)
    db.exec(SCHEMA_SQL)
  }
  await ensureSchema(d1)
}

test('P1-1：老库上直接 exec schema.sql 必炸（证明守卫的必要性）', () => {
  const db = makeOldDb()
  assert.throws(() => db.exec(SCHEMA_SQL), /deleted_at|no such column/, '旧顺序（exec 先行无兜底）在老库上必须抛错')
})

test('P1-1：老库走「失败→补列→重放」成功升级，业务表与索引可用', async () => {
  const db = makeOldDb()
  const d1 = d1FromSqlite(db)
  await bootstrapLikeServer(db, d1)
  // 业务列与部分索引全部就位
  const cols = (db.prepare('PRAGMA table_info(posts)').all() as { name: string }[]).map((c) => c.name)
  assert.ok(cols.includes('deleted_at'), 'posts.deleted_at 已补齐')
  const wcols = (db.prepare('PRAGMA table_info(weibo)').all() as { name: string }[]).map((c) => c.name)
  assert.ok(wcols.includes('pinned'), 'weibo.pinned 已补齐')
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_posts_feed','idx_weibo_feed','idx_posts_deleted')")
    .all() as { name: string }[]
  assert.ok(idx.length >= 3, `关键部分索引就位：${idx.map((i) => i.name).join(',')}`)
  // 业务写入可用（软删口径照常）
  const now = Date.now()
  db.prepare(
    "INSERT INTO posts (slug, title, content, status, deleted_at, published_at, created_at, updated_at) VALUES ('ok-1', '升级后可写', '<p>x</p>', 'published', NULL, ?, ?, ?)"
  ).run(now, now, now)
  const row = db.prepare("SELECT id, deleted_at FROM posts WHERE slug = 'ok-1'").get() as { id: number; deleted_at: null }
  assert.equal(row.deleted_at, null)
})

test('P1-1：全新库走「exec 先行快速路」成功，且 ensureSchema 兜底幂等', async () => {
  const db = new DatabaseSync(':memory:')
  const d1 = d1FromSqlite(db)
  await bootstrapLikeServer(db, d1)
  db.exec(SCHEMA_SQL) // 幂等重放不抛
  const tables = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('posts','weibo','pages','settings','posts_fts')"
    )
    .get() as { n: number }
  assert.equal(tables.n, 5, '关键表（含 FTS 虚表）全部就位——核心九表来自 schema.sql、后加表来自 SCHEMA_TABLES')
})

test('P1-1：现代库（已含全部列）重放幂等，不误触发补列路', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  const { ensureSchema } = await import('../src/db')
  await ensureSchema(d1) // 现代库上 ensureSchema 静默通过
  db.exec(SCHEMA_SQL) // 幂等重放
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_posts_feed'").get() as { n: number }
  assert.equal(row.n, 1)
})
