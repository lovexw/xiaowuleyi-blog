import { test } from 'node:test'
import assert from 'node:assert/strict'
import { responsiveContentImages } from '../src/render.ts'

// ── 正文图片响应式化：srcset 指向宿主机预生成的 WebP 变体（<原图>@480.webp），
//    没生成时 /images 路由回退原图，所以这里只保证「站内图才加、外链不加、作者手写的不覆盖」 ──

test('responsiveContentImages：站内图补 srcset/sizes/loading/decoding', () => {
  const out = responsiveContentImages('<p><img src="/images/u/202610/a.jpg" alt="x"></p>')
  assert.match(out, /srcset="\/images\/u\/202610\/a\.jpg@480\.webp 480w, \/images\/u\/202610\/a\.jpg@960\.webp 960w"/)
  assert.match(out, /sizes="\(max-width: 780px\) 100vw, 720px"/)
  assert.match(out, /loading="lazy"/)
  assert.match(out, /decoding="async"/)
  // 原属性一个不能丢
  assert.match(out, /alt="x"/)
})

test('responsiveContentImages：外链图只补懒加载，不改 src、不加 srcset', () => {
  const out = responsiveContentImages('<img src="https://cdn.example.com/a.jpg">')
  assert.doesNotMatch(out, /srcset=/)
  assert.match(out, /loading="lazy"/)
  assert.match(out, /src="https:\/\/cdn\.example\.com\/a\.jpg"/)
})

test('responsiveContentImages：作者手写 srcset 优先，原样返回', () => {
  const html = '<img src="/images/u/a.jpg" srcset="/images/u/a.jpg@480.webp 480w">'
  assert.equal(responsiveContentImages(html), html)
})

test('responsiveContentImages：已经是变体地址、或懒加载占位，不再叠 srcset', () => {
  const variant = '<img src="/images/u/a.jpg@480.webp">'
  assert.doesNotMatch(responsiveContentImages(variant), /srcset=/)

  const lazy = '<img src="/images/u/a.jpg" data-srcset="/x 480w">'
  assert.doesNotMatch(responsiveContentImages(lazy), / srcset=/)
})

test('responsiveContentImages：已有 loading/decoding 不重复写；自闭合斜杠保留', () => {
  const out = responsiveContentImages('<img src="/images/u/a.png" loading="eager" decoding="sync" />')
  assert.equal((out.match(/loading=/g) ?? []).length, 1)
  assert.equal((out.match(/decoding=/g) ?? []).length, 1)
  assert.match(out, /\/>$/)
})

test('responsiveContentImages：没有 img 的 HTML 原样返回（含空串）', () => {
  assert.equal(responsiveContentImages(''), '')
  assert.equal(responsiveContentImages('<p>纯文本</p>'), '<p>纯文本</p>')
  // 没有 src 的 img（占位符）不动，避免拼出无意义属性
  assert.equal(responsiveContentImages('<img alt="占位">'), '<img alt="占位">')
})

test('mediaDeleteKeys：原图展开全部变体槽位；变体 key 幂等回原图；多 key 去重（P1-7）', async () => {
  const { mediaDeleteKeys } = await import('../src/store.ts')
  assert.deepEqual(
    [...mediaDeleteKeys(['u/202611/abc.jpg'])].sort(),
    ['u/202611/abc.jpg', 'u/202611/abc.jpg@192.webp', 'u/202611/abc.jpg@480.webp', 'u/202611/abc.jpg@960.webp'].sort()
  )
  // 传变体 key 进来按原图展开（幂等）
  assert.deepEqual(
    [...mediaDeleteKeys(['u/x.png@480.webp'])].sort(),
    ['u/x.png', 'u/x.png@192.webp', 'u/x.png@480.webp', 'u/x.png@960.webp'].sort()
  )
  // 多 key 去重
  assert.equal(new Set(mediaDeleteKeys(['u/a.jpg', 'u/a.jpg@480.webp'])).size, 4)
})
