import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homeListBase, homeSortBar, markHtml, searchExtrasHtml, searchSnippet, searchTerms, textHasTerm } from '../src/render.ts'

// ── 搜索页的展示层（src/render.ts）：关键词高亮、正文命中片段、搜索排序条 ──
// 分页与排序本身在 src/fts.ts（tests/fts.test.ts 守着），这里只管「结果怎么显示」。

test('markHtml：命中词包 mark，其余字符照常转义', () => {
  assert.equal(markHtml('部署教程入门', '部署'), '<mark class="srch-hl">部署</mark>教程入门')
  assert.equal(markHtml('部署教程入门'), '部署教程入门', '没有关键词时与 esc() 逐字节相同')
  assert.equal(markHtml('a<b>c', 'b'), 'a&lt;<mark class="srch-hl">b</mark>&gt;c', '标签只由本函数生成')
})

test('markHtml：用户输入里的 HTML 进不了输出（先转义再匹配）', () => {
  const out = markHtml('<script>alert(1)</script>', '<script>')
  assert.ok(!out.includes('<script'), '原文的尖括号必须是实体')
  assert.ok(out.includes('&lt;script&gt;'), '转义后的词照样能被标亮')
  assert.equal(out.match(/<mark/g)?.length, out.match(/<\/mark>/g)?.length, 'mark 开闭成对')
})

test('markHtml：多词、大小写不敏感、最长优先', () => {
  assert.equal(
    markHtml('Docker 与 docker compose 部署', 'docker compose'),
    '<mark class="srch-hl">Docker</mark> 与 <mark class="srch-hl">docker</mark> <mark class="srch-hl">compose</mark> 部署'
  )
  assert.equal(
    markHtml('博客搜索引擎', '博客 搜索'),
    '<mark class="srch-hl">博客</mark><mark class="srch-hl">搜索</mark>引擎'
  )
  assert.equal(markHtml('DOKER docker', 'docker'), 'DOKER <mark class="srch-hl">docker</mark>')
})

test('markHtml：正则元字符不当通配符（关键词里的 . * ( ) 是字面量）', () => {
  assert.equal(
    markHtml('a.b c*d (e)', 'a.b c*d'),
    '<mark class="srch-hl">a.b</mark> <mark class="srch-hl">c*d</mark> (e)'
  )
  assert.equal(markHtml('abc', '.'), 'abc', '单个 . 不会把整段吞掉')
})

test('searchTerms：按空白切词、去重、最长优先、上限 12 个', () => {
  assert.deepEqual(searchTerms('  博客   搜索 博客 '), ['博客', '搜索'])
  assert.deepEqual(searchTerms(undefined), [])
  assert.equal(searchTerms(Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ')).length, 12)
})

test('textHasTerm：大小写不敏感的子串判定', () => {
  assert.equal(textHasTerm('Docker 部署', 'docker'), true)
  assert.equal(textHasTerm('Docker 部署', 'k8s'), false)
  assert.equal(textHasTerm('', 'x'), false)
  assert.equal(textHasTerm('x'), false)
})

test('searchSnippet：正文命中处前后各截一段，两端补省略号', () => {
  const body = `<p>${'前'.repeat(200)}</p><p>这里出现了部署教程这个词</p><p>${'后'.repeat(200)}</p>`
  const s = searchSnippet(body, '部署教程')
  assert.ok(s.includes('部署教程'), '片段必须含命中词')
  assert.ok(s.startsWith('…') && s.endsWith('…'), '词在中间，两头都截掉了要补省略号')
  assert.ok(!s.includes('<p>'), '标签不进摘要')
})

test('searchSnippet：命不中就用 fallback（不硬造一段无关正文）', () => {
  assert.equal(searchSnippet('<p>完全无关的正文</p>', '部署教程', '作者写的摘要'), '作者写的摘要')
  assert.equal(searchSnippet('', 'x', '兜底'), '兜底')
})

test('homeSortBar：搜索页换成「相关度 / 最新发布」两档，链接带回关键词', () => {
  const qs = 'q=%E9%83%A8%E7%BD%B2%E6%95%99%E7%A8%8B'
  assert.equal(
    homeSortBar({ q: '部署教程', sort: 'relevance' }),
    '<nav class="fs-bar" aria-label="搜索结果排序"><span class="fs-label">排序</span>' +
      `<a class="fs-chip is-active" href="/search?${qs}">相关度</a>` +
      `<a class="fs-chip" href="/search?${qs}&amp;sort=time">最新发布</a></nav>`,
    '相关度是默认档：不写进 URL，且当前高亮'
  )
  const byTime = homeSortBar({ q: '部署教程', sort: 'time' })
  assert.ok(byTime.includes(`<a class="fs-chip" href="/search?${qs}">相关度</a>`), '非当前档不带 is-active')
  assert.ok(byTime.includes(`<a class="fs-chip is-active" href="/search?${qs}&amp;sort=time">最新发布</a>`))
})

test('homeSortBar：首页排序条一字未变（五档、无相关度）', () => {
  const home = homeSortBar({ sort: 'latest' })
  for (const label of ['最新', '最多阅读', '最多点赞', '最多留言', '随机']) assert.ok(home.includes(`>${label}</a>`))
  assert.ok(!home.includes('相关度'))
  assert.ok(home.includes('aria-label="文章排序"'))
})

test('homeListBase：搜索页翻页链接带 q 与 sort，不串到首页', () => {
  assert.equal(homeListBase({ q: '部署', sort: 'time' }), '/search?q=%E9%83%A8%E7%BD%B2&sort=time&')
  assert.equal(homeListBase({ q: '部署' }), '/search?q=%E9%83%A8%E7%BD%B2&')
  assert.equal(homeListBase({ sort: 'latest' }), '/?')
})

test('searchExtrasHtml：页面命中出链接（标题高亮），标签命中出 chip（复用既有 class）', () => {
  const html = searchExtrasHtml({
    pages: [
      { slug: 'projects', title: '我的项目清单' },
      { slug: 'books', title: '在读项目书单' },
    ],
    pagesTotal: 5,
    tags: [
      { name: '项目复盘', count: 3 },
      { name: '小项目', count: 1 },
    ],
    tagsTotal: 9,
    q: '项目',
  })
  assert.ok(
    html.includes('<a href="/page/projects">我的<mark class="srch-hl">项目</mark>清单</a>'),
    '页面标题高亮且链到 /page/:slug'
  )
  assert.ok(html.includes('（共 5 个页面命中）'), '命中数多于显示数时点明')
  assert.ok(html.includes('class="fs-bar" aria-label="相关标签"'), '标签条复用排序条的 fs-bar 样式')
  assert.ok(html.includes('<a class="fs-chip" href="/tag/%E9%A1%B9%E7%9B%AE%E5%A4%8D%E7%9B%98"'), 'chip 链到 /tag/:name')
  assert.ok(html.includes('共 9 个'), '标签总数多于显示数时点明')
  assert.ok(!html.includes('<script'), '输出里不该有脚本')
})

test('searchExtrasHtml：两组都没命中就是空串（主题侧不渲染）', () => {
  assert.equal(searchExtrasHtml({ pages: [], tags: [], q: 'x1x' }), '')
  assert.equal(searchExtrasHtml({ q: 'x1x' }), '')
  assert.equal(searchExtrasHtml({ pages: null, tags: null }), '')
})
