import { test } from 'node:test'
import assert from 'node:assert/strict'
import { page } from '../src/render.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'

/* 第一批优化：列表分页/筛选页的 canonical 与 og:url 自指当前 URL；
 * 404 不输出 canonical/og:url，且空主题 CSS 时不吐空 <style>。 */

const settings = { ...DEFAULT_SETTINGS, siteName: '示例站', siteUrl: 'https://blog.example.com' }
const base = { settings, css: 'body{}', title: '文', path: '/', body: '' }

test('page()：默认 canonical / og:url 用 path（回归）', () => {
  const html = page({ ...base, path: '/post/hello' })
  assert.ok(html.includes('<link rel="canonical" href="https://blog.example.com/post/hello">'))
  assert.ok(html.includes('<meta property="og:url" content="https://blog.example.com/post/hello">'))
})

test('page()：canonicalPath 让分页/筛选页自指当前 URL，canonical 与 og:url 同步', () => {
  const html = page({ ...base, path: '/', canonicalPath: '/?page=3&sort=views' })
  const want = 'https://blog.example.com/?page=3&amp;sort=views'
  assert.ok(html.includes(`<link rel="canonical" href="${want}">`))
  assert.ok(html.includes(`<meta property="og:url" content="${want}">`))
  // 不再把第 2、3 页的 canonical 指回第一页
  assert.ok(!html.includes('<link rel="canonical" href="https://blog.example.com/">'))
})

test('page()：noCanonical 不输出 canonical 与 og:url（404 / 错误页）', () => {
  const html = page({ ...base, path: '/404', noCanonical: true })
  assert.ok(!html.includes('rel="canonical"'))
  assert.ok(!html.includes('property="og:url"'))
})

test('page()：noCanonical 优先于 canonicalPath', () => {
  const html = page({ ...base, canonicalPath: '/?page=2', noCanonical: true })
  assert.ok(!html.includes('rel="canonical"'))
})

test('page()：css 为空时不输出 <style>（404 极简骨架），非空时输出不变', () => {
  assert.ok(!page({ ...base, css: '' }).includes('<style>'))
  assert.ok(page({ ...base, css: 'body{color:red}' }).includes('<style>body{color:red}</style>'))
})
