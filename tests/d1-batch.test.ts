import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createD1 } from '../docker-poc/shims/d1.ts'

/* db.batch 的返回结构（2026-11-06 线上事故回归）
 *
 * 事故：docker-poc 的 shim 对 batch 里**每一条**语句都调 run()，SELECT 只拿到
 * `{success, meta:{changes,last_row_id}}`——没有 results，而且 changes 还是上一条语句的残留值。
 * 线上表现：媒体体检「未引用」把全库 6176 个文件都列了出来（引用源一条正文都没读到），
 * 点「全选 → 删除所选」就会把图床删空。同族受害者：邀请码核销的 changes 判定、
 * 往年今日的两个 SELECT、回收站彻底删除的 changes 判定。
 *
 * 真 D1 的 batch 语义：读语句返回 results，写语句返回 meta.changes，逐条按顺序执行。
 */

test('D1 shim batch：读语句必须带 results，写语句带真实 changes', async () => {
  const db = createD1(':memory:')
  try {
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    await db.prepare("INSERT INTO t (v) VALUES ('/images/u/a.jpg')").bind().run()

    const res = (await db.batch([
      db.prepare("SELECT v FROM t WHERE v LIKE '%/images/%'"),
      db.prepare('UPDATE t SET v = ? WHERE id = ?').bind('/images/u/b.jpg', 1),
      db.prepare('UPDATE t SET v = ? WHERE id = ?').bind('/images/u/x.jpg', 999),
      db.prepare('SELECT v FROM t'),
      db.prepare('DELETE FROM t WHERE id = ?').bind(999),
    ])) as unknown as {
      results?: { v: string }[]
      meta?: { changes?: number }
    }[]

    assert.deepEqual(res[0].results, [{ v: '/images/u/a.jpg' }], '第一条 SELECT 必须带回结果集')
    assert.equal(res[1].meta?.changes, 1, '命中一行的 UPDATE 报 1')
    assert.equal(res[2].meta?.changes, 0, '没命中报 0（不能继承上一条的 1）')
    assert.deepEqual(res[3].results, [{ v: '/images/u/b.jpg' }], '写后读能看到本批次前一条的写入')
    assert.equal(res[4].meta?.changes, 0, '删不存在的行报 0')
  } finally {
    db.close()
  }
})

test('D1 shim batch：INSERT ... RETURNING 也算结果集', async () => {
  const db = createD1(':memory:')
  try {
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const res = (await db.batch([
      db.prepare('INSERT INTO t (v) VALUES (?) RETURNING id, v').bind('x'),
    ])) as unknown as { results?: { id: number; v: string }[] }[]
    assert.deepEqual(res[0].results, [{ id: 1, v: 'x' }])
  } finally {
    db.close()
  }
})

test('D1 shim batch：纯读批次不占写事务（读的同时另一条连接能写进去）', async () => {
  const file = `${process.env.TMPDIR || '/tmp'}/d1-batch-readonly-${process.pid}.db`
  const a = createD1(file)
  let b: ReturnType<typeof createD1> | null = null
  try {
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    b = createD1(file)
    const batches = await a.batch([a.prepare('SELECT count(*) AS c FROM t'), a.prepare('SELECT count(*) AS c FROM t')])
    assert.equal((batches[0].results as { c: number }[])[0].c, 0)
    // 读批次结束后写入立刻可用（若读批次开过 IMMEDIATE 写事务且没释放，这里会 SQLITE_BUSY）
    await b.prepare('INSERT INTO t (v) VALUES (?)').bind('ok').run()
    const after = await a.batch([a.prepare('SELECT count(*) AS c FROM t')])
    assert.equal((after[0].results as { c: number }[])[0].c, 1)
  } finally {
    a.close()
    b?.close()
  }
})
