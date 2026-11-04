import { test } from 'node:test'
import assert from 'node:assert/strict'
import { htmlConditionalResponse } from '../src/html-etag.ts'

/* HTML 条件请求（第一批优化）：200 的 text/html 补强 ETag，命中 If-None-Match 回 304。
 * 直接测纯函数，不必拉起整个 app / caches.default。 */

function html(body: string, opts: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: opts.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-cache',
      ...(opts.headers || {}),
    },
  })
}

test('HTML 200 补强 ETag：同内容稳定、不同内容不同、原 body 不被消耗', async () => {
  const a = await htmlConditionalResponse(html('<html>A</html>'), null)
  const b = await htmlConditionalResponse(html('<html>A</html>'), null)
  const c = await htmlConditionalResponse(html('<html>B</html>'), null)
  const ea = a.headers.get('ETag')!
  assert.match(ea, /^"[0-9a-f]{16}"$/)
  assert.equal(ea, b.headers.get('ETag'))
  assert.notEqual(ea, c.headers.get('ETag'))
  assert.equal(await a.text(), '<html>A</html>')
})

test('If-None-Match 精确命中 → 304 零 body，保留 ETag / Cache-Control，不带 Content-Type', async () => {
  const first = await htmlConditionalResponse(html('<html>hello</html>'), null)
  const etag = first.headers.get('ETag')!
  const res = await htmlConditionalResponse(html('<html>hello</html>'), etag)
  assert.equal(res.status, 304)
  assert.equal(await res.text(), '')
  assert.equal(res.headers.get('ETag'), etag)
  assert.equal(res.headers.get('Cache-Control'), 'no-cache')
  assert.equal(res.headers.get('content-type'), null)
})

test('If-None-Match：不匹配 / 逗号列表 / 弱校验 W/ / 通配符 * 的判定', async () => {
  const first = await htmlConditionalResponse(html('<html>x</html>'), null)
  const etag = first.headers.get('ETag')!
  assert.equal((await htmlConditionalResponse(html('<html>x</html>'), '"deadbeefdeadbeef"')).status, 200)
  assert.equal((await htmlConditionalResponse(html('<html>x</html>'), `"nope", ${etag}`)).status, 304)
  assert.equal((await htmlConditionalResponse(html('<html>x</html>'), `W/${etag}`)).status, 304)
  assert.equal((await htmlConditionalResponse(html('<html>x</html>'), '*')).status, 304)
})

test('已有 ETag 的响应（边缘缓存副本）直接复用，不重算也不读 body', async () => {
  const cached = html('<html>cached</html>', { headers: { ETag: '"fixed-etag"', 'X-Page-Cache': 'hit' } })
  const res = await htmlConditionalResponse(cached, '"fixed-etag"')
  assert.equal(res.status, 304)
  assert.equal(res.headers.get('ETag'), '"fixed-etag"')
  assert.equal(res.headers.get('X-Page-Cache'), 'hit')
})

test('非 HTML / 非 200 / 带 Set-Cookie 的响应原样放行（不加 ETag、不 304）', async () => {
  const json = new Response('{}', { headers: { 'content-type': 'application/json' } })
  const r1 = await htmlConditionalResponse(json, '*')
  assert.equal(r1.status, 200)
  assert.equal(r1.headers.get('ETag'), null)

  const r2 = await htmlConditionalResponse(html('<html>missing</html>', { status: 404 }), '*')
  assert.equal(r2.status, 404)
  assert.equal(r2.headers.get('ETag'), null)

  const r3 = await htmlConditionalResponse(html('<html>login</html>', { headers: { 'Set-Cookie': 'sid=1; Path=/' } }), '*')
  assert.equal(r3.status, 200)
  assert.equal(r3.headers.get('ETag'), null)
})
