import type { PostRow, SettingsMap } from './types'
import { parseTags } from './db'
import { siteMode } from './render'
import { sanitizeHtml } from './sanitize'
import { esc, fmtDate, isoDate } from './utils'
import { cdata, rfc822, xmlEsc } from './xml'

export function buildRss(settings: SettingsMap, posts: PostRow[], siteUrl: string): string {
  const fullText = settings.rssFullText !== '0'
  const items = posts
    .map((p) => {
      // 全文走 content:encoded（标准做法：description 保持摘要轻量，订阅器优先读全文）。
      // 需要口令的文章（min_tier 非 all）订阅器等同游客视角：**连试读段都不出**，
      // description 只用作者自填摘要——锁住的正文不能从 RSS 这条侧路漏出去。
      // 机器可读锁标志（bloghao 命名空间）：广场 hub 的 RSS pull 补漏据此跳过锁文，
      // 与 push 路 firePostPublished 的 locked 口径同源
      const locked = (p.min_tier || 'all') !== 'all'
      const encoded =
        fullText && p.content && !locked
          ? `\n      <content:encoded>${cdata(sanitizeHtml(p.content))}</content:encoded>`
          : ''
      return `    <item>
      <title>${xmlEsc(p.title)}</title>
      <link>${xmlEsc(siteUrl)}/post/${encodeURIComponent(p.slug)}</link>
      <guid isPermaLink="true">${xmlEsc(siteUrl)}/post/${encodeURIComponent(p.slug)}</guid>
      <pubDate>${rfc822(p.published_at)}</pubDate>
      <description>${xmlEsc(p.summary)}</description>${encoded}${locked ? '\n      <bloghao:locked>1</bloghao:locked>' : ''}
    </item>`
    })
    .join('\n')
  // lastBuildDate 取条目里最新的发布时间（max，防置顶旧文排第一时取错）；无条目时不输出
  const lastBuild = posts.reduce((m, p) => Math.max(m, p.published_at || 0), 0)
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:bloghao="https://bloghao.com/plaza-ns">
  <channel>
    <title>${xmlEsc((settings.siteName))}</title>
    <link>${xmlEsc(siteUrl)}</link>
    <description>${xmlEsc((settings.siteDescription))}</description>
    <language>zh-CN</language>
    <atom:link href="${xmlEsc(siteUrl)}/rss.xml" rel="self" type="application/rss+xml"/>
    <dc:creator>${xmlEsc((settings.siteName))}</dc:creator>
${items}${lastBuild ? `\n    <lastBuildDate>${rfc822(lastBuild)}</lastBuildDate>` : ''}
  </channel>
</rss>`
}

/** JSON Feed 1.1（/feed.json，C12）：机器可读订阅格式，防泄漏口径与 buildRss 同一份——
 *  需要口令的文章（min_tier 非 all）连试读段都不出、只留作者自填摘要，rssFullText 关闭时只出摘要。
 *  日期走 isoDate（北京时间 +08:00 口径，与 JSON-LD 同源）；字段名是 JSON Feed 规范键，
 *  输出经 JSON.stringify 序列化，无需 xmlEsc */
export function buildJsonFeed(settings: SettingsMap, posts: PostRow[], siteUrl: string): string {
  const fullText = settings.rssFullText !== '0'
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: settings.siteName,
    home_page_url: siteUrl,
    feed_url: `${siteUrl}/feed.json`,
    description: settings.siteDescription,
    language: 'zh-CN',
    authors: [{ name: settings.siteName, url: siteUrl }],
    items: posts.map((p) => {
      // 需要口令的文章：正文整段不出（试读段也不给），只留作者自填摘要——
      // 与 buildRss 同口径，别让 feed.json 成为绕过口令的侧门
      const locked = (p.min_tier || 'all') !== 'all'
      const contentHtml = fullText && p.content && !locked ? sanitizeHtml(p.content) : ''
      // 封面属作者主动公开的导读面（与标题/摘要同口径），相对路径补成绝对地址
      const cover = p.cover ? (p.cover.startsWith('/') ? siteUrl + p.cover : p.cover) : ''
      return {
        id: `${siteUrl}/post/${encodeURIComponent(p.slug)}`,
        url: `${siteUrl}/post/${encodeURIComponent(p.slug)}`,
        title: p.title,
        summary: p.summary,
        ...(contentHtml ? { content_html: contentHtml } : {}),
        ...(cover ? { image: cover } : {}),
        date_published: isoDate(p.published_at),
        date_modified: isoDate(p.updated_at),
        tags: parseTags(p),
      }
    }),
  }
  return JSON.stringify(feed)
}

/**
 * sitemap：只收录「有独立内容、值得提交」的页面——首页 / 关于 / 归档 / 微博流 / 独立页 / 分类页 / 文章页。
 * 标签页（自动生成的薄聚合页，页面本身已 noindex）与留言板 / 友链（薄 UGC 页）不收录，
 * /page/about（会 301 到 /about）也不重复收录——2026-10 SEO 审计：此前 sitemap 提交了 100 个标签页
 * 而标签页 canonical 却指向首页，是自相矛盾的收录信号。
 * lastmod 口径：文章/独立页用 updated_at，首页与归档用最新文章的 updated_at（此前的
 * Date.now() 每天都变，Google 会不信任恒为「今天」的 lastmod），分类页用其下文章的最新更新时间。
 */
export function buildSitemap(
  settings: SettingsMap,
  posts: { slug: string; updated_at: number }[],
  siteUrl: string,
  categories: { slug: string; name: string; lastmod?: string }[] = [],
  pages: { slug: string; updated_at: number }[] = [],
  weiboLastmod?: number
): string {
  const latestPostAt = posts[0]?.updated_at || 0
  const aboutPage = pages.find((p) => p.slug === 'about')
  const urls = [
    { loc: `${siteUrl}/`, lastmod: latestPostAt ? fmtDate(latestPostAt) : '' },
    { loc: `${siteUrl}/about`, lastmod: aboutPage ? fmtDate(aboutPage.updated_at) : '' },
    { loc: `${siteUrl}/archives`, lastmod: latestPostAt ? fmtDate(latestPostAt) : '' },
    // 纯博客模式前台隐藏了微博模块（/weibo 302 回首页），sitemap 不再收录
    ...(siteMode(settings) === 'blog' ? [] : [{ loc: `${siteUrl}/weibo`, lastmod: weiboLastmod ? fmtDate(weiboLastmod) : '' }]),
    // 独立页面（/page/:slug）：slug 做百分号编码（中文 slug 是非 ASCII IRI）；about 走专属短链 /about
    ...pages
      .filter((p) => p.slug !== 'about')
      .map((p) => ({
        loc: `${siteUrl}/page/${encodeURIComponent(p.slug)}`,
        lastmod: fmtDate(p.updated_at),
      })),
    // 分类归档页同样可收录；slug 做百分号编码（中文分类名是非 ASCII IRI）
    ...categories.map((cat) => ({
      loc: `${siteUrl}/category/${encodeURIComponent(cat.slug)}`,
      lastmod: cat.lastmod || '',
    })),
    ...posts.map((p) => ({
      loc: `${siteUrl}/post/${encodeURIComponent(p.slug)}`,
      lastmod: fmtDate(p.updated_at),
    })),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${xmlEsc(u.loc)}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
  </url>`
  )
  .join('\n')}
</urlset>`
}
