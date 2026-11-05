import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryCacheStats, nodeMemoryCache, resetMemoryCache } from '../src/memory-cache'

const cache = nodeMemoryCache()

/** 造一个响应；默认带 30 分钟 max-age（与 PAGE_CACHE_TTL_S 一致） */
function makeRes(body: string, cacheControl = 'public, max-age=1800', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html', 'cache-control': cacheControl } })
}

test('存入后能取回：状态 / 头 / 正文一致', async () => {
  resetMemoryCache()
  const url = 'https://x.invalid/__page/0/host.test/'
  await cache.put(url, makeRes('<h1>hi</h1>'))
  const hit = await cache.match(url)
  assert.ok(hit, '应命中')
  assert.equal(hit.status, 200)
  assert.equal(hit.headers.get('content-type'), 'text/html')
  assert.equal(await hit.text(), '<h1>hi</h1>')
})

test('match 返回 body 副本：连续两次命中都能完整读出', async () => {
  resetMemoryCache()
  const url = 'https://x.invalid/__page/0/host.test/copy'
  const payload = 'payload-' + 'x'.repeat(1000)
  await cache.put(url, makeRes(payload))
  const a = await cache.match(url)
  const b = await cache.match(url)
  assert.equal(await a!.text(), payload, '第一次命中应完整')
  assert.equal(await b!.text(), payload, '第二次命中应完整（同一 ArrayBuffer 不会被消费）')
})

test('未命中返回 undefined', async () => {
  resetMemoryCache()
  assert.equal(await cache.match('https://x.invalid/nothing'), undefined)
})

test('TTL 到期后不再命中（max-age=1）', async () => {
  resetMemoryCache()
  const url = 'https://x.invalid/__page/0/host.test/ttl'
  await cache.put(url, makeRes('short', 'public, max-age=1'))
  assert.ok(await cache.match(url), '刚存入应命中')
  await new Promise((r) => setTimeout(r, 1100))
  assert.equal(await cache.match(url), undefined, '过期后应视为未命中')
})

test('no-store / no-cache 一律不存', async () => {
  resetMemoryCache()
  await cache.put('https://x.invalid/a', makeRes('x', 'no-store'))
  await cache.put('https://x.invalid/b', makeRes('x', 'no-cache'))
  assert.equal(await cache.match('https://x.invalid/a'), undefined)
  assert.equal(await cache.match('https://x.invalid/b'), undefined)
  assert.equal(memoryCacheStats().entries, 0)
})

test('缺省 Cache-Control 时用默认 30 分钟（与 PAGE_CACHE_TTL_S 同源）', async () => {
  resetMemoryCache()
  const url = 'https://x.invalid/__page/0/host.test/default'
  const r = new Response('no-cc', { headers: { 'content-type': 'text/html' } })
  await cache.put(url, r)
  assert.ok(await cache.match(url), '没有 Cache-Control 也应存（默认 TTL）')
})

test('单条超 2MB 不存（图床大图 / 视频不占内存）', async () => {
  resetMemoryCache()
  const url = 'https://x.invalid/images/big.jpg'
  const big = 'x'.repeat(2 * 1024 * 1024 + 1)
  await cache.put(url, makeRes(big, 'public, max-age=31536000, immutable'))
  assert.equal(await cache.match(url), undefined, '超限应直接不存')
  assert.equal(memoryCacheStats().entries, 0)
})

test('delete 后不再命中（purge 路径）', async () => {
  resetMemoryCache()
  const url = 'https://x.invalid/__page/0/host.test/del'
  await cache.put(url, makeRes('bye'))
  assert.ok(await cache.match(url))
  await cache.delete(url)
  assert.equal(await cache.match(url), undefined)
})

test('条目数超上限时淘汰最旧的（LRU）', async () => {
  resetMemoryCache()
  for (let i = 0; i < 301; i++) {
    await cache.put(`https://x.invalid/__page/0/host.test/${i}`, makeRes('x', 'public, max-age=1800'))
  }
  assert.equal(await cache.match('https://x.invalid/__page/0/host.test/0'), undefined, '第 0 条应被淘汰')
  assert.ok(await cache.match('https://x.invalid/__page/0/host.test/300'), '最新的应还在')
  assert.ok(memoryCacheStats().entries <= 300, '条目数不应超过上限')
})

test('命中会把键移到队尾：热键不会被先淘汰', async () => {
  resetMemoryCache()
  // 填满 300 条
  for (let i = 0; i < 300; i++) {
    await cache.put(`https://x.invalid/p/${i}`, makeRes('x', 'public, max-age=1800'))
  }
  // 触碰第 0 条，把它移到队尾
  assert.ok(await cache.match('https://x.invalid/p/0'))
  // 再插一条，淘汰的应是最旧的第 1 条，而不是刚被访问过的第 0 条
  await cache.put('https://x.invalid/p/new', makeRes('x', 'public, max-age=1800'))
  assert.ok(await cache.match('https://x.invalid/p/0'), '刚访问过的键应保留')
  assert.equal(await cache.match('https://x.invalid/p/1'), undefined, '真正的旧键应被淘汰')
})

test('resetMemoryCache 清空全部', async () => {
  await cache.put('https://x.invalid/keep', makeRes('x'))
  assert.ok(memoryCacheStats().entries > 0)
  resetMemoryCache()
  assert.equal(memoryCacheStats().entries, 0)
  assert.equal(memoryCacheStats().bytes, 0)
})

test('同一键重复 put 以新内容为准（不累加占用）', async () => {
  resetMemoryCache()
  const url = 'https://x.invalid/overwrite'
  await cache.put(url, makeRes('old'))
  const afterFirst = memoryCacheStats().bytes
  await cache.put(url, makeRes('new'))
  const hit = await cache.match(url)
  assert.equal(await hit!.text(), 'new')
  assert.equal(memoryCacheStats().entries, 1)
  assert.equal(memoryCacheStats().bytes, afterFirst, '覆盖不应让占用翻倍')
})
