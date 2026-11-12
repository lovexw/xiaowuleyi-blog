import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { ftsMatchExpr, searchPages, searchPosts, searchWeibo } from '../src/fts.ts'
import { ensureSchema } from '../src/db.ts'

// ── FTS5 全文搜索（src/fts.ts，ROADMAP B4）──
// 用 node:sqlite 执行真实的 schema.sql 建库（docker-poc 与测试共用这份文件，
// 顺带守住它对普通 SQLite 的可执行性），两条升级路径各测一遍：
// A 增量：ensureSchema 建好触发器后写入 → 触发器同步索引；
// B 存量升级：先有数据后跑 ensureSchema → ftsSeeded 记账位驱动 rebuild 全量补索引。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

// schema.sql 的一条执行路径（demo.ts ensureTables）按分号朴素切分 SQL——
// 触发器的 BEGIN...END 体切不开，只允许挂在 db.ts 的 SCHEMA_TRIGGERS（ensureSchema 里）。
test('schema.sql：不含 CREATE TRIGGER，FTS 虚表在列', () => {
  assert.ok(!SCHEMA_SQL.includes('CREATE TRIGGER'), '触发器只准在 db.ts SCHEMA_TRIGGERS，schema.sql 出现会打瘫 demo 冷启动')
  assert.ok(SCHEMA_SQL.includes("CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5"))
  assert.ok(SCHEMA_SQL.includes("tokenize='trigram'"))
})

test('ftsMatchExpr：多词 AND、短语双引号包裹', () => {
  assert.equal(ftsMatchExpr('docker deploy guide'), '"docker" AND "deploy" AND "guide"')
  assert.equal(ftsMatchExpr('部署教程入门'), '"部署教程入门"')
})

test('ftsMatchExpr：词内双引号翻倍转义，FTS5 查询语法到不了引擎', () => {
  assert.equal(ftsMatchExpr('docker "compose" guide'), '"docker" AND """compose""" AND "guide"')
})

test('ftsMatchExpr：任一分词短于 3 字符整体退回 LIKE（trigram 成不了窗）', () => {
  assert.equal(ftsMatchExpr('博客'), null, '2 字中文词是最常见的查询，必须走 LIKE 老路')
  assert.equal(ftsMatchExpr('docker 博客'), null)
  assert.equal(ftsMatchExpr('  '), null)
  assert.equal(ftsMatchExpr(''), null)
})

test('ftsMatchExpr：全角空格也当切词边界；emoji 按码点计数', () => {
  assert.equal(ftsMatchExpr('docker\u3000deploy'), '"docker" AND "deploy"')
  assert.equal(ftsMatchExpr('🦄🦄🦄'), '"🦄🦄🦄"')
})

// ── node:sqlite 实库集成（node < 22.5 无 node:sqlite 时整体跳过）──

/** 极简 D1 适配：prepare().bind().run/all/first + batch（ensureSchema 的播种用），
 *  SQL 按串缓存 StatementSync（node:sqlite 与 D1 一样按串幂等） */
function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      stmtOf(sql).run(...(binds as never[]))
      return { success: true }
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
      for (const s of stmts) await s.run()
      return []
    },
  } as unknown as D1Database
}

function seedPost(db: DatabaseSync, slug: string, title: string, content: string, extra = '') {
  db.exec(
    `INSERT INTO posts (slug, title, content, status, created_at, updated_at${extra ? ', password_hash, deleted_at' : ''}) VALUES ('${slug}','${title}','${content}','published',1,1${extra ? `,${extra}` : ''})`
  )
}

test('searchPosts：FTS 命中 + bm25 相关度排序 + 加密文/回收站排除（增量路径 A）', async (t) => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1) // 建触发器 + 空库 rebuild（幂等）

  seedPost(db, 'p1', '部署教程入门', '这是部署教程正文，讲清楚第一步')
  seedPost(db, 'p2', '进阶篇', '部署教程重复出现，部署教程再提，部署教程三现')
  seedPost(db, 'p3', '加密文', '部署教程也在加密文里', "'salt:hash', NULL")
  seedPost(db, 'p4', '回收站文', '部署教程已删', "'', 99")
  db.exec("INSERT INTO posts (slug, title, content, status, created_at, updated_at) VALUES ('p5','草稿','部署教程草稿','draft',1,1)")

  const r = await searchPosts(d1, '部署教程', { perPage: 50 })
  assert.deepEqual(
    r.items.map((p) => p.slug),
    ['p2', 'p1'],
    'bm25：命中次数多的排前；加密文(p3)/回收站(p4)/草稿(p5)整体退出关键词搜索'
  )
  assert.equal(r.total, 2)

  // 二次 ensureSchema：ftsSeeded 记账位已置，不重复 rebuild，索引照常可搜
  await ensureSchema(d1)
  assert.equal((await searchPosts(d1, '部署教程', { perPage: 50 })).total, 2)
})

test('searchPosts：存量库升级路径 B——先有数据后 ensureSchema，rebuild 全量补索引', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  seedPost(db, 'p1', '部署教程入门', '这是部署教程正文，讲清楚第一步')
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  const r = await searchPosts(d1, '部署教程', { perPage: 50 })
  assert.deepEqual(r.items.map((p) => p.slug), ['p1'])
})

test('searchPosts：2 字短词退回 listPosts LIKE 老路，口径与旧搜索一致', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  seedPost(db, 'p1', '部署教程入门', '讲清楚第一步')
  seedPost(db, 'p2', '生活随笔', '今天把博客的部署弄好了')
  const r = await searchPosts(d1, '部署', { perPage: 50 })
  assert.deepEqual(r.items.map((p) => p.slug).sort(), ['p1', 'p2'])
  assert.equal(r.page, 1)
  assert.ok(r.totalPages >= 1)
})

test('searchPosts：词内双引号的用户输入不炸 MATCH', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  seedPost(db, 'p1', '部署教程', '正文里有 a"b 这样的字符')
  const r = await searchPosts(d1, 'a"b 部署教程', { perPage: 50 })
  assert.ok(Array.isArray(r.items))
})

/** 带发布时间的种子（排序测试要能控制「谁更新」） */
function seedPostAt(db: DatabaseSync, slug: string, title: string, content: string, ts: number) {
  db.prepare(
    `INSERT INTO posts (slug, title, content, status, created_at, updated_at, published_at) VALUES (?,?,?,'published',?,?,?)`
  ).run(slug, title, content, ts, ts, ts)
}

test('searchPosts：分页——先 COUNT 再取页，越界页码回落到最后一页', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  for (let i = 1; i <= 12; i++) seedPost(db, `s${i}`, `第${i}篇`, '分页测试正文，关键词只出现一次')

  const p1 = await searchPosts(d1, '分页测试', { page: 1, perPage: 5 })
  assert.equal(p1.total, 12, 'total 是全量命中数，不是当前页条数')
  assert.equal(p1.totalPages, 3)
  assert.equal(p1.items.length, 5)
  assert.equal(p1.page, 1)

  const p3 = await searchPosts(d1, '分页测试', { page: 3, perPage: 5 })
  assert.equal(p3.items.length, 2, '最后一页只剩 2 条')

  const over = await searchPosts(d1, '分页测试', { page: 99, perPage: 5 })
  assert.equal(over.page, 3, '手输 ?page=99 回落到最后一页，不吐「空列表 + 越界页码器」')
  assert.equal(over.items.length, 2)

  const tiny = await searchPosts(d1, '分页测试', { perPage: 0, page: 2 })
  assert.equal(tiny.totalPages, 2, 'perPage 传 0/脏值回落默认 10（与 settings.postsPerPage 的 clampInt 同口径）')
  assert.equal(tiny.items.length, 2, '默认 10 条一页，第 2 页剩 2 条')

  const miss = await searchPosts(d1, '压根没有这个词组', { page: 3, perPage: 5 })
  assert.deepEqual([miss.total, miss.page, miss.totalPages], [0, 1, 1], '零命中恒回第 1 页')
})

test('searchPosts：短词 LIKE 路径同样把越界页码夹回最后一页', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  seedPost(db, 'a', '部署一', '正文甲')
  seedPost(db, 'b', '部署二', '正文乙')
  seedPost(db, 'c', '部署三', '正文丙')

  const over = await searchPosts(d1, '部署', { page: 9, perPage: 1 })
  assert.equal(over.total, 3)
  assert.equal(over.page, 3, '2 字词不走 FTS，但页码口径必须与 FTS 路径一致')
  assert.equal(over.items.length, 1)
})

test('searchPosts：sort=time 按发布时间倒序，默认按 bm25 相关度', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  // 新文只提一次、旧文提三次：相关度排序旧文在前，时间排序新文在前
  seedPostAt(db, 'new', '新文', '排序测试正文，只提一次排序测试', 2_000)
  seedPostAt(db, 'old', '旧文', '排序测试排序测试排序测试，反复提', 1_000)

  const rel = await searchPosts(d1, '排序测试', { perPage: 10 })
  assert.deepEqual(rel.items.map((p) => p.slug), ['old', 'new'], '默认相关度：命中多的在前')

  const byTime = await searchPosts(d1, '排序测试', { perPage: 10, sort: 'time' })
  assert.deepEqual(byTime.items.map((p) => p.slug), ['new', 'old'], 'sort=time：按发布时间倒序')

  // 排序不影响总数：两条都在
  assert.equal(byTime.total, rel.total)
})

test('searchPosts：afterTs 可见窗口把窗口外文章挡在搜索之外', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  seedPostAt(db, 'recent', '近期文', '窗口测试正文，可搜到', 2_000)
  seedPostAt(db, 'ancient', '往年文', '窗口测试正文，应被挡', 1_000)

  const all = await searchPosts(d1, '窗口测试', { perPage: 10 })
  assert.equal(all.total, 2)
  const windowed = await searchPosts(d1, '窗口测试', { perPage: 10, afterTs: 1_500 })
  assert.deepEqual(windowed.items.map((p) => p.slug), ['recent'], '窗口外文章不参与搜索（命中本身即泄露）')
  assert.equal(windowed.total, 1)
})

test('searchPages：只搜已发布、未回收的独立页面，标题与正文都算命中', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  const ins = (title: string, slug: string, content: string, status: string, sort: number) =>
    db
      .prepare('INSERT INTO pages (title, slug, content, status, sort, created_at, updated_at) VALUES (?,?,?,?,?,1,1)')
      .run(title, slug, content, status, sort)
  ins('项目清单', 'projects', '这里放做过的开源项目', 'published', 10)
  ins('隐私政策', 'privacy', '项目相关的数据处理说明', 'published', 20)
  ins('草稿页', 'draft-page', '项目还没写完', 'draft', 30)
  db.exec(
    "INSERT INTO pages (title, slug, content, status, sort, created_at, updated_at, deleted_at) VALUES ('回收页','trash-page','项目已删','published',40,1,1,99)"
  )

  const r = await searchPages(d1, '项目')
  assert.deepEqual(r.items.map((p) => p.slug), ['projects', 'privacy'], '按 sort 升序；草稿与回收站不出现')
  assert.equal(r.total, 2)

  const byTitle = await searchPages(d1, '隐私政策')
  assert.deepEqual(byTitle.items.map((p) => p.slug), ['privacy'], '标题命中')

  const none = await searchPages(d1, '压根没有的词组')
  assert.deepEqual([none.items.length, none.total], [0, 0])

  const capped = await searchPages(d1, '项目', 1)
  assert.equal(capped.items.length, 1, 'limit 收口')
  assert.equal(capped.total, 2, 'total 仍是全量命中数')
})

test('searchWeibo：FTS 命中已发布微博，草稿与回收站不出现；短词走 LIKE', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  db.exec("INSERT INTO weibo (content, status, created_at, updated_at) VALUES ('今天天气不错出门走走 #生活#','published',1,1)")
  db.exec("INSERT INTO weibo (content, status, created_at, updated_at) VALUES ('天气不错去爬山','published',2,2)")
  db.exec("INSERT INTO weibo (content, status, created_at, updated_at) VALUES ('天气不错但是草稿','draft',3,3)")
  db.exec("INSERT INTO weibo (content, status, created_at, updated_at, deleted_at) VALUES ('天气不错但已删','published',4,4,99)")

  const r = await searchWeibo(d1, '天气不错', 20)
  assert.equal(r.total, 2)
  const short = await searchWeibo(d1, '生活', 20)
  assert.equal(short.total, 1, '2 字词走 LIKE 扫微博表（微博行数少，扫表够快）')
  const miss = await searchWeibo(d1, '不存在的词组', 20)
  assert.deepEqual(miss.items, [])
})
