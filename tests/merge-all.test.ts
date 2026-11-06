import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createD1 } from '../docker-poc/shims/d1.ts'
import { mergeAllDuplicates } from '../src/audit.ts'
import type { Env } from '../src/types.ts'

/* 一键合并全部重复（2026-11-06）
 *
 * 为什么用真 SQL（node:sqlite）而不是 audit.test.ts 里的迷你桩：这段逻辑有三处只靠真库才能验证——
 * GROUP BY ... HAVING COUNT(*)>1 的分组、子查询数剩余组数、以及合并后引用改写是否真的落库。
 * 桩把 SQL 语义简化过，正是上次 db.batch 事故的温床。
 */

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const H3 = 'c'.repeat(64)

function fakeR2(failKeys: string[] = []) {
  const deleted: string[] = []
  const bucket = {
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]
      const hit = list.find((k) => failKeys.includes(k))
      if (hit) throw new Error('模拟删除失败: ' + hit)
      deleted.push(...list)
    },
  } as unknown as R2Bucket
  return { bucket, deleted }
}

async function setup() {
  const db = createD1(':memory:')
  await db.exec(`
    CREATE TABLE uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      hash TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '');
    CREATE TABLE pages (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL DEFAULT '');
    CREATE TABLE weibo (id INTEGER PRIMARY KEY AUTOINCREMENT, images TEXT NOT NULL DEFAULT '', video TEXT NOT NULL DEFAULT '');
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, avatar TEXT NOT NULL DEFAULT '');
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, avatar TEXT NOT NULL DEFAULT '');
    CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, avatar TEXT NOT NULL DEFAULT '');
    CREATE TABLE friend_links (id INTEGER PRIMARY KEY AUTOINCREMENT, icon TEXT NOT NULL DEFAULT '');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE tg_buffer (media_group_id TEXT, content TEXT DEFAULT '', images TEXT DEFAULT '');
  `)
  return db
}

/** day 只是让 created_at 好读：值是第几天 */
async function addUpload(
  db: ReturnType<typeof createD1>,
  key: string,
  hash: string,
  day: number,
  size = 1000
) {
  await db
    .prepare('INSERT INTO uploads (key, name, mime, size, created_at, hash) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(key, key.split('/').pop()!, 'image/jpeg', size, Date.UTC(2026, 0, day), hash)
    .run()
}

async function content(db: ReturnType<typeof createD1>, id: number) {
  const r = await db.prepare('SELECT content FROM posts WHERE id = ?').bind(id).first<{ content: string }>()
  return r?.content ?? ''
}

test('一键合并：引用中的优先保留，同样状态时留上传最早的', async () => {
  const db = await setup()
  const r2 = fakeR2()
  try {
    // 第 1 组：A 没人用（早）、B 被正文引用（晚）→ 留 B
    await addUpload(db, 'u/202601/a1.jpg', H1, 1)
    await addUpload(db, 'u/202601/b1.jpg', H1, 9)
    await db.prepare('INSERT INTO posts (content) VALUES (?)').bind('正文 <img src="/images/u/202601/b1.jpg">').run()
    // 第 2 组：C、D 都没人用，D 更早 → 留 D
    await addUpload(db, 'u/202601/c1.jpg', H2, 5)
    await addUpload(db, 'u/202601/d1.jpg', H2, 2)

    const res = await mergeAllDuplicates({ DB: db, IMAGES: r2.bucket } as unknown as Env, 20)

    assert.equal(res.processed, 2)
    assert.equal(res.remaining, 0)
    assert.equal(res.removed, 2)
    const left = (await db.prepare('SELECT key FROM uploads ORDER BY key').all<{ key: string }>()).results.map((r) => r.key)
    assert.deepEqual(left, ['u/202601/b1.jpg', 'u/202601/d1.jpg'])
    assert.equal(await content(db, 1), '正文 <img src="/images/u/202601/b1.jpg">', '引用的那张没被改写走')
  } finally {
    db.close()
  }
})

test('一键合并：两组都在用时，正文里的旧地址被改写到保留项', async () => {
  const db = await setup()
  const r2 = fakeR2()
  try {
    await addUpload(db, 'u/202601/e1.jpg', H3, 3)
    await addUpload(db, 'u/202601/f1.jpg', H3, 8)
    await db.prepare('INSERT INTO posts (content) VALUES (?)').bind('A <img src="/images/u/202601/e1.jpg"> B <img src="/images/u/202601/f1.jpg">').run()
    await db.prepare('INSERT INTO weibo (images) VALUES (?)').bind('["/images/u/202601/f1.jpg"]').run()

    const res = await mergeAllDuplicates({ DB: db, IMAGES: r2.bucket } as unknown as Env, 20)

    assert.equal(res.processed, 1)
    assert.equal(res.updated, 2, '文章正文 + 微博配图各改写一处')
    assert.equal(
      await content(db, 1),
      'A <img src="/images/u/202601/e1.jpg"> B <img src="/images/u/202601/e1.jpg">',
      '两处地址都指向保留的那张'
    )
    const w = await db.prepare('SELECT images FROM weibo WHERE id = 1').first<{ images: string }>()
    assert.equal(w?.images, '["/images/u/202601/e1.jpg"]')
    assert.ok(r2.deleted.includes('u/202601/f1.jpg'), '被合并的副本连同变体一起从图床删除')
    assert.ok(r2.deleted.some((k) => k.startsWith('u/202601/f1.jpg@')), '变体派生文件也在删除口径里')
  } finally {
    db.close()
  }
})

test('一键合并：按批发，limit 生效，remaining 递减到 0', async () => {
  const db = await setup()
  const r2 = fakeR2()
  try {
    for (let i = 0; i < 3; i++) {
      await addUpload(db, `u/202601/g${i}-1.jpg`, String(i).repeat(64), 10 + i)
      await addUpload(db, `u/202601/g${i}-2.jpg`, String(i).repeat(64), 20 + i)
    }
    const env = { DB: db, IMAGES: r2.bucket } as unknown as Env

    const first = await mergeAllDuplicates(env, 2)
    assert.equal(first.processed, 2)
    assert.equal(first.remaining, 1, '剩 1 组留给下一批')

    const second = await mergeAllDuplicates(env, 2)
    assert.equal(second.processed, 1)
    assert.equal(second.remaining, 0)

    const third = await mergeAllDuplicates(env, 2)
    assert.equal(third.groups, 0, '没有重复时直接返回，不白跑引用扫描')
    assert.equal(third.remaining, 0)
  } finally {
    db.close()
  }
})

test('一键合并：一组删文件失败不牵连其他组，失败的留在剩余里', async () => {
  const db = await setup()
  const r2 = fakeR2(['u/202601/h1-2.jpg'])
  try {
    // 第 1 组会失败（删 h1-2 时炸）
    await addUpload(db, 'u/202601/h1-1.jpg', H1, 1)
    await addUpload(db, 'u/202601/h1-2.jpg', H1, 2)
    // 第 2 组正常
    await addUpload(db, 'u/202601/h2-1.jpg', H2, 3)
    await addUpload(db, 'u/202601/h2-2.jpg', H2, 4)

    const res = await mergeAllDuplicates({ DB: db, IMAGES: r2.bucket } as unknown as Env, 20)

    assert.equal(res.processed, 1, '另一组照常完成')
    assert.equal(res.failed.length, 1)
    assert.match(res.failed[0].error, /模拟删除失败/)
    assert.equal(res.remaining, 1, '失败的那组还在，重试即可')
    const left = (await db.prepare('SELECT key FROM uploads ORDER BY key').all<{ key: string }>()).results.map((r) => r.key)
    // 第 2 组合并完成只剩保留的那张；第 1 组因删文件失败整组原样留着（引用已改写，重试幂等）
    assert.deepEqual(left, ['u/202601/h1-1.jpg', 'u/202601/h1-2.jpg', 'u/202601/h2-1.jpg'])
  } finally {
    db.close()
  }
})

test('一键合并：微博视频（weibo.video）里的地址也会被改写，不留断链', async () => {
  const db = await setup()
  const r2 = fakeR2()
  try {
    // 同一条视频的两个副本：一个在正文里，一个在微博视频 JSON 里，两个都在用 → 留上传早的
    await addUpload(db, 'u/202601/v1.mp4', H1, 2, 3_000_000)
    await addUpload(db, 'u/202601/v2.mp4', H1, 7, 3_000_000)
    await db.prepare('INSERT INTO posts (content) VALUES (?)').bind('<video src="/images/u/202601/v1.mp4">').run()
    await db
      .prepare('INSERT INTO weibo (video) VALUES (?)')
      .bind(JSON.stringify({ url: '/images/u/202601/v2.mp4', poster: '/images/u/202601/poster.jpg' }))
      .run()

    const res = await mergeAllDuplicates({ DB: db, IMAGES: r2.bucket } as unknown as Env, 20)

    assert.equal(res.processed, 1, '改写干净才允许删除')
    assert.equal(res.removed, 1)
    const w = await db.prepare('SELECT video FROM weibo WHERE id = 1').first<{ video: string }>()
    // 2026-11-06 的坑：引用识别认 weibo.video、改写不认 → 合并后微博视频指向已删文件
    assert.match(w!.video, /\/images\/u\/202601\/v1\.mp4/)
    assert.doesNotMatch(w!.video, /v2\.mp4/)
  } finally {
    db.close()
  }
})

test('一键合并：指纹没回填（hash 为空）的文件不参与', async () => {
  const db = await setup()
  const r2 = fakeR2()
  try {
    await addUpload(db, 'u/202601/x1.jpg', '', 1)
    await addUpload(db, 'u/202601/x2.jpg', '', 1)
    const res = await mergeAllDuplicates({ DB: db, IMAGES: r2.bucket } as unknown as Env, 20)
    assert.equal(res.groups, 0)
    assert.equal(res.remaining, 0)
  } finally {
    db.close()
  }
})
