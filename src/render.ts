import type { CommentRow, PostRow, SettingsMap } from './types'
import type { PostSort, WeiboVideoView } from './db'
import { assetUrl, assetVersion } from './assets'
import { renderFooterHtml } from './hooks'
import { outHref } from './outlink'
import { cstDate, esc, excerpt, extractWeiboTopics, fmtDate, fmtDateCN, fmtDateTime, isoDate, plainText } from './utils'
import { replaceEmoji } from './emoji'
import { appearanceHeadStyle } from './appearance'
import { customCssHeadStyle } from './skinpack'
import { ipRegionLabel } from './ipregion'
import { readAiPolicy, seoHeadHtml } from './seo'

export interface ThemePageOptions {
  settings: SettingsMap
  css: string
  title: string
  description?: string
  ogImage?: string
  path: string
  /** canonical / og:url 用的完整路径（含规范化 query）。列表分页与筛选页传它自指，
   *  否则第 2、3 页都会把 canonical 指向第一页，被搜索引擎当成重复内容 */
  canonicalPath?: string
  /** 404 / 错误页不输出 canonical 与 og:url：否则会指向一个根本不存在的地址 */
  noCanonical?: boolean
  body: string
  preview?: boolean
  /** 请求源（new URL(c.req.url).origin）：canonical / og:url 绝对化的兜底，未配置 siteUrl 时也能产出绝对地址 */
  origin?: string
  /** 工具型页面（搜索、草稿预览）：要求搜索引擎不收录 */
  noindex?: boolean
  /** 结构化数据（JSON-LD）：对象序列化进 <script type="application/ld+json">，文章页传 articleJsonLd() 的产物；
   *  传数组时逐块输出（文章页 = BlogPosting + 面包屑 BreadcrumbList，见 src/seo.ts） */
  jsonLd?: Record<string, unknown> | Record<string, unknown>[]
}

/** og:image 三级兜底：文章专属卡图（编辑器 OG 标记 > 封面）→ 后台设置的默认卡图 → 内置品牌卡图。
 *  og:image 绝不缺位：社交平台抓不到图时会退化为灰色占位小图标 */
export function resolveOgImage(ogImage: string | undefined, settings: SettingsMap): string {
  return ogImage || settings.ogImageDefault || '/og-default.png'
}

/* ---------------- 站点模式（后台「设置 → 站点模式」） ----------------
 * 不爱写长文的人可以只写微博：模式决定微博/博客两大模块在前台的显隐与首页优先级。
 * - blog-weibo（默认）：文章为主，微博随手记作为首页入口卡（现状）
 * - weibo-blog：微博为主，首页先出完整微博卡片流，文章列表跟在后面
 * - blog：纯博客——微博模块全隐藏（导航/首页入口/历史上的今天的微博），/weibo 302 回首页
 * - weibo：纯微博——打开首页就是微博时间线，博客专属模块（归档/分类话题/随机）从导航隐藏；
 *   文章数据不动，直链仍可访问
 */
export type SiteMode = 'blog-weibo' | 'weibo-blog' | 'blog' | 'weibo'

export const SITE_MODE_VALUES: SiteMode[] = ['blog-weibo', 'weibo-blog', 'blog', 'weibo']

/** 设置里的站点模式：脏值/缺省一律回退 blog-weibo（与 DEFAULT_SETTINGS 同口径） */
export function siteMode(settings: SettingsMap): SiteMode {
  return SITE_MODE_VALUES.includes(settings.siteMode as SiteMode) ? (settings.siteMode as SiteMode) : 'blog-weibo'
}

/** 页脚链接组按站点模式收口：纯博客模式剥掉指向 /weibo 的链接（导航已下线微博入口，页脚同步口径）。
 *  只作用于各主题 FOOT_LINKS 的自有静态串（href 恰为 "/weibo"），不是通用 HTML 过滤器 */
export function footLinks(settings: SettingsMap, links: string): string {
  return siteMode(settings) === 'blog' ? links.replace(/<a href="\/weibo">[^<]*<\/a>/g, '') : links
}

/** 站点绝对地址前缀：后台「站点链接」优先，未配置时回退请求 origin；去尾部斜杠 */
export function siteBase(settings: SettingsMap, origin?: string): string {
  return ((settings.siteUrl || origin || '') as string).replace(/\/+$/, '')
}

/** HTML 骨架：meta/OG/JSON-LD/内联主题 CSS/站点脚本，所有主题共用。
 *  lang 固定 zh-CN（英文版 2026-11-11 已删除，前台只有中文一种输出） */
export function page(o: ThemePageOptions): string {
  const siteName = o.settings.siteName || 'BlogHao'
  const desc = (o.description || o.settings.siteDescription || '').slice(0, 160)
  const base = siteBase(o.settings, o.origin)
  const title = o.title ? `${o.title} - ${siteName}` : siteName
  const ogType = o.path.startsWith('/post/') ? 'article' : 'website'
  const ogImage = resolveOgImage(o.ogImage, o.settings)
  // 列表页分页/筛选时自指带规范化 query 的 URL；其余页沿用 path（与既有行为一致）
  const canonicalPath = o.canonicalPath ?? o.path
  const canonicalHtml = base && !o.noCanonical
    ? `<link rel="canonical" href="${esc(base + canonicalPath)}">`
    : ''
  const ogUrlHtml = base && !o.noCanonical
    ? `<meta property="og:url" content="${esc(base + canonicalPath)}">`
    : ''
  // JSON-LD 里的 < 必须转成 \u003c（仍是合法 JSON）：防正文标题带 </script> 提前闭合脚本标签
  const jsonLdHtml = o.jsonLd
    ? (Array.isArray(o.jsonLd) ? o.jsonLd : [o.jsonLd])
        .map((one) => `<script type="application/ld+json">${JSON.stringify(one).replace(/</g, '\\u003c')}</script>`)
        .join('\n')
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN"${assetVersion() ? ` data-av="${assetVersion()}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${o.noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="max-snippet:-1, max-image-preview:large, max-video-preview:-1">'}
${o.settings.statsEnabled === '0' ? '<meta name="xw-stats" content="off">' : ''}
${canonicalHtml}
<meta property="og:title" content="${esc(o.title || siteName)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${esc(siteName)}">
${ogUrlHtml}
<meta property="og:image" content="${esc(absUrl(base, ogImage))}">
<meta property="og:image:alt" content="${esc(o.title || siteName)}">
<meta name="twitter:card" content="summary_large_image">
${jsonLdHtml}
${o.settings.faviconUrl ? `<link rel="icon" href="${esc(absUrl(base, o.settings.faviconUrl))}">` : `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`}
${base ? `<link rel="alternate" type="application/rss+xml" title="${esc(siteName)}" href="${esc(base)}/rss.xml">` : ''}
${base ? `<link rel="alternate" type="application/feed+json" title="${esc(siteName)}" href="${esc(base)}/feed.json">` : ''}
${base && o.path.startsWith('/post/') && readAiPolicy(o.settings.aiPolicy) !== 'deny' && o.settings.siteNoindex !== '1' ? `<link rel="alternate" type="text/markdown" title="${esc(o.title || siteName)}" href="${esc(base + o.path)}.md">` : ''}
${o.css ? `<style>${o.css}</style>` : ''}
${appearanceHeadStyle(o.settings)}
${customCssHeadStyle(o.settings)}
${grayscaleStyle(o.settings)}
${seoHeadHtml(o.settings)}
</head>
<body${o.preview ? ' data-preview="1"' : ''}>

${o.body}
<script src="${assetUrl('/site.js')}" defer></script>
${renderFooterHtml(o.settings)}
</body>
</html>`
}

function absUrl(siteUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return siteUrl ? siteUrl + path : path
}

/** 一键灰度（哀悼/纪念模式）：settings.siteGrayscale 开启时全站去色。
 *  放在 <html> 上才能覆盖背景色。filter 会为 fixed 后代改挂定位基准——但按 CSS Filter
 *  Effects 规范，根元素（html）上的 filter 豁免、不建立 fixed 后代的 containing block，
 *  因此 wechat 移动端下拉（fixed）、site.js 运行时注入的灯箱/返回顶部/阅读进度条等
 *  fixed 元素在灰度下照常定位（Chromium/WebKit/Gecko 均按根元素豁免实现）。
 *  注意：这条安全边界只对「filter 挂在根元素」成立——若未来把灰度改挂到某个包裹层，
 *  其内所有 fixed 后代都会改挂该层为定位基准，必须先复查（AGENTS.md 灰度防线） */
function grayscaleStyle(settings: SettingsMap): string {
  return settings.siteGrayscale === '1' ? '<style>html{filter:grayscale(100%)}</style>' : ''
}

/** 闭站页（settings.siteClosed 开启时对匿名访客返回）：脱离主题的极简独立页。
 *  状态码必须 503 + Retry-After——搜索引擎据此暂时保留收录，而不是把站点当 404 摘掉 */
export function renderClosedPage(settings: SettingsMap): string {
  const siteName = settings.siteName || 'BlogHao'
  const message = settings.siteClosedMessage || '本站暂时关闭，请稍后再来。'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${`站点暂时关闭 - ${esc(siteName)}`}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{color-scheme:light dark}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;
  background:#f4f4f5;color:#52525b}
.card{max-width:460px;text-align:center}
.badge{width:44px;height:44px;margin:0 auto;border:1.5px solid #a1a1aa;border-radius:50%;
  display:flex;align-items:center;justify-content:center;color:#a1a1aa}
h1{font-size:20px;font-weight:600;margin:20px 0 12px;color:inherit}
.msg{font-size:15px;line-height:1.8;white-space:pre-wrap;word-break:break-word}
.site{margin-top:32px;font-size:13px;color:#a1a1aa}
@media (prefers-color-scheme:dark){body{background:#18181b}.badge{border-color:#3f3f46;color:#3f3f46}.site{color:#52525b}}
</style>
</head>
<body>
<div class="card">
<div class="badge" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/></svg></div>
<h1>站点暂时关闭</h1>
<p class="msg">${esc(message)}</p>
<div class="site">${esc(siteName)}</div>
</div>
</body>
</html>`
}

export interface ArticleJsonLdOptions {
  settings: SettingsMap
  /** 文章标题（headline，不带站名后缀） */
  title: string
  description: string
  /** 文章专属卡图或封面（可相对路径）：内部走 resolveOgImage 兜底，与 og:image 恒一致 */
  image?: string
  /** 文章 canonical 地址：与 page() 的 canonical 同源拼接（base + /post/:slug） */
  url: string
  base: string
  /** 发布时间（毫秒），缺失回退 updatedAt */
  publishedAt?: number | null
  /** 最后更新时间（毫秒） */
  updatedAt: number
  tags?: string[]
  commentCount?: number
  /** 付费墙标记（Google 结构化数据口径）：传内容区的 CSS 选择器时输出 isAccessibleForFree:"False"
   *  + hasPart——让搜索引擎 / AI 明确知道这篇是受限内容而非坏链，不误判站点质量。取值只来自
   *  renderPost 的两处字面量（'.paywall' / '.pp-box'），无注入面 */
  paywallSelector?: string
}

/**
 * 文章页 JSON-LD 结构化数据（schema.org BlogPosting，SEO 基本盘，roadmap A3）。
 * 时间统一北京时间 +08:00（isoDate，与全站时间口径一致）；dateModified 取发布/更新中较晚者——
 * 定时发布场景 updated_at 会早于 published_at，直接用会造成「修改时间早于发布时间」的矛盾数据。
 */
export function articleJsonLd(o: ArticleJsonLdOptions): Record<string, unknown> {
  const siteName = o.settings.siteName || 'BlogHao'
  const publishedTs = o.publishedAt || o.updatedAt
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    mainEntityOfPage: { '@type': 'WebPage', '@id': o.url },
    // Google 建议 headline 控制在 110 字符内，超长截断
    headline: o.title.slice(0, 110),
    description: o.description,
    image: absUrl(o.base, resolveOgImage(o.image, o.settings)),
    datePublished: isoDate(publishedTs),
    dateModified: isoDate(Math.max(publishedTs, o.updatedAt)),
    author: { '@type': 'Person', name: siteName },
    publisher: {
      '@type': 'Organization',
      name: siteName,
      logo: { '@type': 'ImageObject', url: absUrl(o.base, o.settings.faviconUrl || '/favicon.svg') },
    },
    inLanguage: 'zh-CN',
  }
  if (o.tags?.length) data.keywords = o.tags.join(', ')
  if (o.commentCount != null) data.commentCount = o.commentCount
  // 付费墙结构化声明（isAccessibleForFree + hasPart，Google「付费墙标记」口径）：
  // 检索端据此把这篇归为受限内容，不进「免费内容质量」的评价维度
  if (o.paywallSelector) {
    data.isAccessibleForFree = 'False'
    data.hasPart = { '@type': 'WebPageElement', isAccessibleForFree: 'False', cssSelector: o.paywallSelector }
  }
  return data
}

export interface HomePostView {
  slug: string
  title: string
  summary: string
  cover: string
  tags: string[]
  published_at: number | null
  views: number
  likes: number
  pinned: boolean
  commentCount?: number
}

/** 前台导航/文章页用的分类轻量视图 */
export interface CategoryLink {
  name: string
  slug: string
}

export function categoryLink(c: CategoryLink): string {
  return `/category/${encodeURIComponent(c.slug)}`
}

/** 顶部导航「分类话题」菜单用的标签视图（带使用计数） */
export interface TagCount {
  name: string
  count: number
}

/** 顶部导航里的自建页面项（独立页面系统，key 用于高亮匹配：'p:<slug>'） */
export interface NavPage {
  title: string
  href: string
  key: string
}

/**
 * 全站顶部导航：首页 + 微博 + 归档 + 留言板 + 分类话题（details 折叠菜单）+ 友情链接 + 自建页面 + 关于我 + 随机。
 * cls 传主题前缀（如 wx-snav），结构统一、样式交由主题 CSS 塑形。
 * mode 传站点模式（siteMode(settings)）：纯博客隐藏「微博」，纯微博把「微博」提为首位并隐藏
 * 归档/分类话题/随机等博客专属模块（未传按博客+微博处理，兼容第三方主题）。
 * 分类与标签收进同一折叠菜单（标签可能很多，菜单内部滚动），
 * active 传 'home' / 'weibo' / 'archives' / 'guestbook' / 'links' / 'about' / 分类 slug / 'tag:标签名' / 'p:页面slug'。
 */
export function siteNav(o: {
  cls: string
  mode?: SiteMode
  categories: CategoryLink[]
  tags?: TagCount[]
  pages?: NavPage[]
  active?: string
  /** compact 布局（主题逐个试点）：主条去微博（首页微博流自带「全部 →」入口），随机降级到主题页脚 */
  compact?: boolean
  /** 吸顶导航（wechat 先行）：输出 data-xw-nav-sticky 标记，site.js 据此做下滚收起/上滑浮现（阅读工具条联动） */
  sticky?: boolean
}): string {
  const m = o.mode || 'blog-weibo'
  // href 一并转义：当前调用方全是内部构造的路径/经 cleanSlug 的 slug，转义是给未来调用方的护栏
  const item = (href: string, label: string, active = false) =>
    `<a class="${o.cls}-link${active ? ' is-active' : ''}" href="${esc(href)}">${esc(label)}</a>`
  const chip = (href: string, label: string, count: number | undefined, active = false) =>
    `<a class="${o.cls}-chip${active ? ' is-active' : ''}" href="${esc(href)}">${esc(label)}${
      count != null ? `<i>${count}</i>` : ''
    }</a>`
  const cats = o.categories.map((c) => chip(categoryLink(c), c.name, undefined, o.active === c.slug))
  const tags = (o.tags || []).map((t) => chip(tagLink(t.name), t.name, t.count, o.active === `tag:${t.name}`))
  const menu =
    cats.length || tags.length
      ? `<div class="${o.cls}-menu">
  ${cats.length ? `<div class="${o.cls}-group"><span class="${o.cls}-label">分类</span><div class="${o.cls}-chips">${cats.join('')}</div></div>` : ''}
  ${tags.length ? `<div class="${o.cls}-group"><span class="${o.cls}-label">话题</span><div class="${o.cls}-chips">${tags.join('')}</div></div>` : ''}
</div>`
      : ''
  const drop = menu
    ? `<details class="${o.cls}-dd snav-dd">
  <summary class="${o.cls}-link">分类话题<svg class="${o.cls}-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
  ${menu}
</details>`
      : ''
  // RSS 订阅图标：博客文化的入口，内联塑造（currentColor 随各主题导航链接色），compact 与完整形态都保留
  const rssIcon = `<a class="${o.cls}-rss" href="/rss.xml" title="RSS 订阅" aria-label="RSS" style="display:inline-flex;align-items:center;opacity:.55"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.18 17.82a2.18 2.18 0 1 1-4.36 0 2.18 2.18 0 0 1 4.36 0zM2 8.73a13.27 13.27 0 0 1 13.27 13.27h-3.64A9.64 9.64 0 0 0 2 12.36V8.73zm0-6.36A19.64 19.64 0 0 1 21.64 22H18A16 16 0 0 0 2 6V2.36z"/></svg></a>`
  // 纯微博：'/' 即微博时间线，导航首位「微博」直达 /weibo（首页 item 退出）；纯博客：去掉「微博」
  const weiboItem = m === 'blog' ? '' : item('/weibo', ('微博'), o.active === 'weibo' || (m === 'weibo' && o.active === 'home'))
  const homeItem = m === 'weibo' ? '' : item('/', ('首页'), o.active === 'home')
  if (o.compact) {
    // 微博不单独进顶栏：混合模式首页已展示微博流（头部「全部 →」指向 /weibo），
    // 纯微博模式的「首页」本身就是微博（homeItem || weiboItem 兜底）
    return `<nav class="${o.cls}"${o.sticky ? ' data-xw-nav-sticky' : ''} aria-label="站点导航">
  ${homeItem || weiboItem}
  ${m === 'weibo' ? '' : item('/archives', ('归档'), o.active === 'archives')}
  ${m === 'weibo' ? '' : drop}
  ${(o.pages || []).map((p) => item(p.href, p.title, o.active === p.key)).join('')}
  ${item('/about', ('关于我'), o.active === 'about')}
  ${item('/guestbook', ('留言板'), o.active === 'guestbook')}
  ${item('/links', ('友情链接'), o.active === 'links')}
  ${rssIcon}
</nav>`
  }
  return `<nav class="${o.cls}"${o.sticky ? ' data-xw-nav-sticky' : ''} aria-label="站点导航">
  ${homeItem || weiboItem}
  ${m === 'weibo' ? '' : weiboItem}
  ${m === 'weibo' ? '' : item('/archives', ('归档'), o.active === 'archives')}
  ${item('/guestbook', ('留言板'), o.active === 'guestbook')}
  ${m === 'weibo' ? '' : drop}
  ${item('/links', ('友情链接'), o.active === 'links')}
  ${(o.pages || []).map((p) => item(p.href, p.title, o.active === p.key)).join('')}
  ${item('/about', ('关于我'), o.active === 'about')}
  ${m === 'weibo' ? '' : item('/random', ('随机'))}
  ${rssIcon}
</nav>`
}

/* ---------------- 文章归档（共享构建器） ----------------
 * 年份小节 + 日期外置的细线列表，结构全主题共用（语义化 .ar-* class），视觉由主题 CSS 塑形。
 */
export interface ArchiveItemView {
  slug: string
  title: string
  /** 发文时间（published_at 缺失回退 created_at），用于分组与展示 */
  ts: number
}

export interface ArchiveYearGroup {
  year: number
  count: number
  items: ArchiveItemView[]
}

/** 按年分组：年份倒序，组内按时间倒序 */
export function archiveGroups(posts: ArchiveItemView[]): ArchiveYearGroup[] {
  const map = new Map<number, ArchiveItemView[]>()
  for (const p of posts) {
    // 与 fmtDate 同口径：按北京时间的年份分组，避免 0-8 点发布的文章归错年
    const year = cstDate(p.ts).getUTCFullYear()
    const list = map.get(year) || []
    list.push(p)
    map.set(year, list)
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, items]) => ({
      year,
      count: items.length,
      items: items.sort((a, b) => b.ts - a.ts),
    }))
}

/** 归档页头部「今年已写」统计后缀：拼进各主题的副标题 <p>（muted 样式随主题）。
 * 无数据/零篇不出声；字数口径 = 正文字符量（含 Markdown 标记，db.ts yearArchiveStats），展示用「约」 */
export function yearStatsSuffix(stats: { count: number; chars: number } | undefined): string {
  if (!stats || !stats.count) return ''
  const wan =
    stats.chars >= 10000 ? ` · 约 ${(stats.chars / 10000).toFixed(1)} 万字` : stats.chars > 0 ? ` · 约 ${stats.chars} 字` : ''
  return ` · 今年已写 ${stats.count} 篇${wan}`
}

/** 正文标题锚点：给净化后正文 h2/h3 注入 toc-N 生成 id（id 由渲染端生成、非用户输入，
 * 不触净化器「不放行 id」的 DOM clobbering 防线），pages.ts renderPost 对七主题统一调用；
 * wechat 主题用返回的 items 渲染目录卡，site.js 据标题上的 id 出桌面 hover ¶ 复制链接。
 * text 是剥标签后的已转义 HTML 片段（sanitize 前已转义），插入 HTML 时原样使用勿再 esc */
export function headingAnchors(contentHtml: string): { html: string; items: { level: 2 | 3; text: string; id: string }[] } {
  const items: { level: 2 | 3; text: string; id: string }[] = []
  const html = contentHtml.replace(/<(h[23])((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g, (_m: string, tag: string, attrs: string, inner: string) => {
    const id = `toc-${items.length + 1}`
    items.push({ level: tag === 'h2' ? 2 : 3, text: inner.replace(/<[^>]*>/g, '').trim(), id })
    return `<${tag}${attrs} id="${id}">${inner}</${tag}>`
  })
  return { html, items }
}

/** 页脚「站点名片 + 足迹」（七主题共享）：左侧头像/站名/简介，右侧累计篇数、字数与写作年份。
 * 统计读 settings.siteFoot（cron 每晚刷新 + 冷启动播种，滞后一夜属展示口径），未播种只出名片半边 */
export function footCardHtml(s: SettingsMap): string {
  let stats: { posts: number; chars: number; since: number } | null = null
  try {
    const v: unknown = JSON.parse(s.siteFoot || 'null')
    if (v && typeof v === 'object' && typeof (v as { posts?: unknown }).posts === 'number') {
      stats = v as { posts: number; chars: number; since: number }
    }
  } catch {
    /* 脏数据按未播种处理，名片照常 */
  }
  const ch = (s.siteName || '博').trim().charAt(0) || '博'
  const avatar = s.avatarUrl
    ? `<span class="fc-avatar"><img src="${esc(variantUrl(s.avatarUrl, 192))}" alt="${esc((s.siteName))}"></span>`
    : `<span class="fc-avatar" aria-hidden="true">${esc(ch)}</span>`
  let statsHtml = ''
  if (stats) {
    const year = stats.since ? cstDate(stats.since).getUTCFullYear() : 0
    const parts = [
          `共 ${stats.posts} 篇`,
          stats.chars >= 10000 ? `约 ${(stats.chars / 10000).toFixed(1)} 万字` : stats.chars > 0 ? `约 ${stats.chars} 字` : '',
          year ? `${year} 年写起` : '',
        ]
    const line = parts.filter(Boolean).join(' · ')
    if (line) statsHtml = `<div class="fc-stats">${line}</div>`
  }
  return `<div class="fc">
  <div class="fc-id">${avatar}<div class="fc-main"><span class="fc-name">${esc((s.siteName))}</span>${
    s.siteDescription ? `<span class="fc-desc">${esc((s.siteDescription))}</span>` : ''
  }</div></div>
  ${statsHtml}
</div>`
}

/** 新站引导卡（首页空状态）：一篇文章和一条微博都没有时给部署者指路——三步开张，直达后台对应页。
 * 无背景虚线卡 + currentColor 中性半透明，任何主题（亮暗）都长在自己的语言里，七主题零 CSS 成本 */
export function newSiteGuideHtml(): string {
  const step = (href: string, label: string) =>
    `<a href="${href}" style="display:block;padding:10px 14px;border-radius:10px;background:rgba(128,128,128,0.08);color:inherit;text-decoration:none;font-size:14px;text-align:left;">${label}</a>`
  return `<section class="xw-guide" style="max-width:560px;margin:34px auto 8px;padding:26px 24px 20px;border:2px dashed rgba(128,128,128,0.35);border-radius:16px;text-align:center;">
  <div style="font-size:30px;line-height:1;" aria-hidden="true">🎉</div>
  <h2 style="font-size:17px;margin:10px 0 6px;">开张大吉，还差三步</h2>
  <p style="font-size:13.5px;opacity:.75;margin:0 0 16px;">这里还是一张白纸。登录后台，几分钟就能迎来第一位读者：</p>
  <div style="display:flex;flex-direction:column;gap:8px;max-width:320px;margin:0 auto 14px;">
    ${step('/admin', '✍️ ' + ('写下第一篇文章'))}
    ${step('/admin/#/appearance', '🎨 ' + ('挑一套顺眼的皮肤'))}
    ${step('/admin/#/settings', '⚙️ ' + ('补上站名、头像与简介'))}
  </div>
  <p style="font-size:12px;opacity:.5;margin:0;">这张卡片只在没有内容时出现，发布第一篇后自动消失</p>
</section>`
}

/** 创作热力图（归档页，GitHub 风年历）：过去一年按北京日聚合的发文密度。
 * 色阶 = 各主题 accent 的透明度四档（零依赖、任何浏览器都正确），空格 = 主题分隔线色；
 * 列 = 周（周日行首），行 1 放月份标签；now 可注入以便 Node 测试钉住日期。
 * 无数据返回空串；legend 与「过去一年写了 N 篇」一并输出 */
export function heatmapHtml(
  data: { days: { day: string; count: number }[]; total: number } | undefined,
  now = Date.now()
): string {
  if (!data || !data.days.length) return ''
  const counts = new Map<string, number>()
  for (const d of data.days) counts.set(d.day, d.count)
  // 北京墙上的「今天」：+8h 后取 UTC 分量（与 cstDate 同口径），锚成 UTC 午夜日期做日步进
  const bj = new Date(now + 8 * 3_600_000)
  const DAY = 86_400_000
  const end = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate())
  const start = end - (52 * 7 + new Date(end).getUTCDay()) * DAY
  const totalDays = Math.floor((end - start) / DAY) + 1
  const cols = Math.ceil(totalDays / 7)
  let lastMonth = -1
  let body = ''
  for (let c = 0; c < cols; c++) {
    const colStart = start + c * 7 * DAY
    const d0 = new Date(colStart)
    // 行 1：月份标签（该列首日进入新月份时贴一个），否则占位空格保持网格对位
    if (d0.getUTCMonth() !== lastMonth) {
      body += `<span class="hm-month">${d0.getUTCMonth() + 1 + '月'}</span>`
      lastMonth = d0.getUTCMonth()
    } else {
      body += '<span class="hm-sp"></span>'
    }
    for (let r = 0; r < 7; r++) {
      const t = colStart + r * DAY
      if (t > end) break
      const day = new Date(t).toISOString().slice(0, 10)
      const n = counts.get(day) || 0
      const lvl = n >= 4 ? 4 : n
      const title = n > 0 ? ` title="${day} · ${n} 篇"` : ''
      body += `<i class="hm-cell${lvl ? ` hm-l${lvl}` : ''}"${title}></i>`
    }
  }
  const summary = `过去一年写了 ${data.total} 篇`
  const legend = `<i class="hm-cell"></i><i class="hm-cell hm-l1"></i><i class="hm-cell hm-l2"></i><i class="hm-cell hm-l3"></i><i class="hm-cell hm-l4"></i>`
  return `<section class="hm"><div class="hm-scroll"><div class="hm-grid">${body}</div></div>` +
    `<p class="hm-foot"><span>${summary}</span><span class="hm-legend">少${legend}多</span></p></section>`
}

/** 上一篇/下一篇导航（prev = 更早一篇、next = 更新一篇）：七主题共享结构、各主题按自己的
 * 变量调 .pn-* 样式；缺一侧出占位空格保持两端对齐，两侧都空返回空串（不产生任何输出） */
export function postNeighborsHtml(
  prev: { slug: string; title: string } | null | undefined,
  next: { slug: string; title: string } | null | undefined,

): string {
  if (!prev && !next) return ''
  const cell = (n: { slug: string; title: string } | null | undefined, label: string, side: 'prev' | 'next') =>
    n
      ? `<a class="pn-cell pn-${side}" href="/post/${esc(n.slug)}"><span class="pn-label">${label}</span><span class="pn-title">${esc(n.title)}</span></a>`
      : `<span class="pn-cell pn-${side} pn-empty" aria-hidden="true"></span>`
  return `<nav class="pn-nav">${cell(prev, ('上一篇'), 'prev')}${cell(next, ('下一篇'), 'next')}</nav>`
}

/** 归档列表 HTML：每篇一行的 <time> + 标题链接（纯静态超链接，利于搜索引擎收录）；en 时日期换英文短格式 */
export function archiveListHtml(groups: ArchiveYearGroup[]): string {
  return groups
    .map(
      (g) => `<section class="ar-group">
  <h2 class="ar-year">${g.year}<i>${`${g.count} 篇`}</i></h2>
  <ul class="ar-list">${g.items
    .map(
      (p) => `<li class="ar-item">
  <a class="ar-link" href="/post/${esc(p.slug)}">
    <time class="ar-date" datetime="${fmtDate(p.ts)}">${fmtDate(p.ts).replace(/-/g, '.')}</time>
    <span class="ar-title">${esc(p.title)}</span>
  </a>
</li>`
    )
    .join('\n')}</ul>
</section>`
    )
    .join('\n')
}

/* ---------------- 友情链接（共享构建器） ----------------
 * 卡片 / 申请收录表单结构全主题共用（语义化 .fl-* class），视觉由主题 CSS 塑形。
 */
export interface FriendLinkView {
  name: string
  url: string
  description: string
  /** 图标地址（站内 /images/ 或外链），空则退回站名首字图标 */
  icon: string
}

/** 机器可读时间戳：<time datetime> 用。无效时间戳（备份恢复/导入的脏数据）兜成空串，
 *  直接 toISOString() 会抛 RangeError 让整页 500 */
function safeIso(ts: number): string {
  const d = new Date(ts)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}

/** 友链卡片：有图标用图标，没有用站名首字。url/icon 渲染前过 scheme 白名单——
 *  写侧已拦 javascript: 等协议，这里兜底防备份恢复/导入路径的脏数据流进 href/src。
 *  协议相对地址 //host 是外链不是站内路径，同样不放行（`/[^/]` 要求斜杠后还有字符） */
export function friendLinkCards(items: FriendLinkView[]): string {
  const safeUrl = (u: string): string => (/^(https?:\/\/|\/[^/])/i.test(u) ? u : '')
  return items
    .map((l) => {
      const url = safeUrl(l.url)
      const icon = safeUrl(l.icon)
      const ico = icon
        ? `<span class="fl-ico"><img src="${esc(icon)}" loading="lazy" alt=""></span>`
        : `<span class="fl-ico fl-ico-letter" aria-hidden="true">${esc((l.name || '链').trim().charAt(0))}</span>`
      const main = `<span class="fl-main">
    <span class="fl-name">${esc(l.name)}</span>
    ${l.description ? `<span class="fl-desc">${esc(l.description)}</span>` : ''}
  </span>`
      // url 非法时退化为无链接卡片（内容照常展示，不输出可疑 href）
      return url
        ? `<a class="fl-card" href="${esc(url)}" target="_blank" rel="noopener">
  ${ico}
  ${main}
</a>`
        : `<span class="fl-card">
  ${ico}
  ${main}
</span>`
    })
    .join('\n')
}

/** 申请收录表单：提交交给 site.js（POST /api/public/links/apply，进待审核）；en 输出英文表单 */
export function friendLinkApply(): string {
  return `<section class="fl-apply" id="fl-apply">
  <h2 class="fl-apply-title">申请收录</h2>
  <p class="fl-apply-sub">想和本站交个朋友？留下你的站点，审核通过后就会出现在上面。</p>
  <form class="fl-form">
    <div class="fl-form-row">
      <input class="fl-input" name="name" maxlength="40" placeholder="站点名称" required aria-label="站点名称">
      <input class="fl-input" name="url" type="url" inputmode="url" maxlength="500" placeholder="https:// 你的网址" required aria-label="站点网址">
    </div>
    <textarea class="fl-textarea" name="description" maxlength="120" rows="2" placeholder="一两句介绍你的网站（可选）" aria-label="站点介绍"></textarea>
    <input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="fl-form-foot">
      <span class="fl-tip">提交后由站长审核</span>
      <button class="fl-submit" type="submit">提交申请</button>
    </div>
  </form>
</section>`
}

/**
 * 文章页去重：封面图常取自正文首图，渲染正文时把与封面相同的第一张图删掉
 * （连同因此变空的 <p>），列表页缩略图不受影响。
 */
export function stripCoverDuplicate(contentHtml: string, cover: string): string {
  if (!cover) return contentHtml
  const img = contentHtml.match(/<img\b[^>]*>/i)
  if (!img) return contentHtml
  const src = img[0].match(/\bsrc\s*=\s*"([^"]*)"/i)
  if (!src) return contentHtml
  const norm = (u: string) => u.replace(/&amp;/g, '&').trim()
  if (norm(src[1]) !== norm(cover)) return contentHtml
  const imgRe = img[0].replace(/[.*+?^()|[\]\\]/g, '\\$&')
  const withoutP = contentHtml.replace(new RegExp(`<p>\\s*${imgRe}\\s*</p>`), '')
  return withoutP !== contentHtml ? withoutP : contentHtml.replace(img[0], '')
}

/** 会生成 WebP 变体的源图扩展名——与 deploy/images/gen-variants.py 的 EXTS 及
 *  src/store.ts `variantBaseKey` 的白名单一致（改任一侧同改）。
 *  gif 明列在外：cwebp 转静态会丢帧，宿主机脚本**故意跳过**，所以 `x.gif@480.webp`
 *  永远不会存在，拼出来就是 404（2026-11-06 生产日志里 blog.btchao.com 的
 *  `u/btc/*.gif@960.webp` 404、9 篇文章内嵌动图 + 4 篇 gif 封面裂图即此）
 *  svg/ico 同理：不是位图，没有变体。 */
const VARIANT_SOURCE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp'])

/**
 * 站内图床图片 → 响应式变体地址（`<原图>@<宽>.webp`）。
 *
 * 变体由 deploy/images/gen-variants.py 在宿主机预生成，/images 路由按 key 直读磁盘；
 * 真没生成时路由会回退原图并给 300s 短 TTL，所以这里可以无条件改写，不会裂图。
 * 外链图片原样返回——那不是我们能生成变体的对象。
 *
 * **不会生成变体的源图（gif/svg/ico）原样返回**：路由的回退只认 variantBaseKey
 * 白名单里的扩展名（gif 会判成"不是变体形态"→不回退→404），所以拼上去等于直接造一个
 * 死链，而不是"反正会回退"。调用方据此判断"有没有真的换地址"，别输出 srcset。
 * 已经是变体形态（`@480.webp`）的也原样返回，避免叠成 `x.webp@480.webp@960.webp`。
 */
export function variantUrl(url: string, w: number): string {
  if (!url.startsWith('/images/')) return url
  const cut = url.search(/[?#]/)
  const path = cut < 0 ? url : url.slice(0, cut)
  const suffix = cut < 0 ? '' : url.slice(cut)
  if (/@\d{2,4}\.webp$/i.test(path)) return url
  const dot = path.lastIndexOf('.')
  if (dot < 0) return url
  const ext = path.slice(dot + 1).toLowerCase()
  return VARIANT_SOURCE_EXTS.has(ext) ? `${path}@${w}.webp${suffix}` : url
}

/**
 * 正文 `<img>` → 响应式：站内图床图片补 srcset（480/960）与 sizes，全部补 loading/decoding。
 * 变体（`<原图>@480.webp`）由 deploy/images/gen-variants.py 在宿主机预生成，/images 路由
 * 按 key 直读磁盘；万一没生成，路由会回退原图，所以这里不需要探测存在性，也不会裂图。
 * 外链图片只补 loading/decoding——那不是我们能生成变体的对象。
 * 已经带 srcset 的原样返回：作者手写的响应式规则优先于我们的默认值。
 */
export function responsiveContentImages(html: string): string {
  if (!html || !html.includes('<img')) return html
  return html.replace(/<img\b([^>]*)>/gi, (tag: string, rawAttrs: string) => {
    if (/\bsrcset\s*=/i.test(rawAttrs)) return tag
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(rawAttrs)
    if (!srcMatch) return tag
    const src = (srcMatch[1] ?? srcMatch[2] ?? '').trim()
    if (!src) return tag

    const selfClose = /\/\s*$/.test(rawAttrs)
    const attrs = selfClose ? rawAttrs.replace(/\/\s*$/, '') : rawAttrs
    let extra = ''
    // 已经是变体地址（或懒加载库的 data-srcset 占位）就别再叠一层；
    // gif/svg 这类没有变体的源图 variantUrl 会原样返回，此时补 srcset 只会让浏览器
    // 选中一个永远 404 的候选地址（srcset 命中后不会回退 src）——所以直接跳过
    if (variantUrl(src, 480) !== src && !/\bdata-srcset\s*=/i.test(attrs)) {
      const set = [480, 960].map((w) => `${src}@${w}.webp ${w}w`).join(', ')
      extra += ` srcset="${set}" sizes="(max-width: 780px) 100vw, 720px"`
    }
    if (!/\bloading\s*=/i.test(attrs)) extra += ' loading="lazy"'
    if (!/\bdecoding\s*=/i.test(attrs)) extra += ' decoding="async"'
    if (!extra) return tag
    return `<img${attrs}${extra}${selfClose ? ' /' : ''}>`
  })
}

export function toHomePost(row: PostRow, tags: string[], commentCount?: number): HomePostView {
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    cover: row.cover,
    tags,
    published_at: row.published_at,
    views: row.views,
    likes: row.likes,
    pinned: !!row.pinned,
    commentCount,
  }
}

/* ---------------- 微博（随手记）共享构建器 ----------------
 * HTML 结构各主题共用（语义化 .wb-* class），视觉由主题 CSS 塑形。
 */
export interface WeiboItemView {
  id: number
  content: string
  images: string[]
  /** 单条视频（B19）：媒体区先视频后图片；null / 缺省 = 无视频 */
  video?: WeiboVideoView | null
  created_at: number
  likes: number
  commentCount: number
  pinned?: boolean
}

/** 微博时间：今年「10月3日 14:20」，往年带年份（北京时间口径，与 utils 时间函数一致）；en 换 Oct 3, 14:20 */
export function weiboTime(ts: number): string {
  const d = cstDate(ts)
  const now = cstDate(Date.now())
  const p = (x: number) => String(x).padStart(2, '0')
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hm}`
    : `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/** 微博图片网格：1 张大图，2/4 张两列，其余三列（微博式） */
export function weiboImageGrid(images: string[]): string {
  const n = images.length
  if (!n) return ''
  const cls = n === 1 ? 'wb-imgs-1' : n === 2 || n === 4 ? 'wb-imgs-2' : 'wb-imgs-3'
  const imgs = images.map((u) => `<img src="${esc(u)}" loading="lazy" alt="">`).join('')
  return `<div class="wb-imgs ${cls}">${imgs}</div>`
}

/** 微博视频块（B19）：单视频，控件齐全、只预载元数据（不预下整段），有原始宽高时换算占位比例避免加载抖动。
 *  无封面帧时叠一个 ▶ 角标（播放后由 site.js 给 .wb-video 挂 is-playing 收起）；竖屏视频交主题 CSS 居中限高。
 *  src 只可能来自 parseWeiboVideo 白名单（站内 /images/ 或 http(s)），仍统一过 esc。 */
export function weiboVideoHtml(v: WeiboVideoView): string {
  const portrait = v.w > 0 && v.h > 0 && v.h > v.w
  const ratio = v.w > 0 && v.h > 0 ? ` style="aspect-ratio:${v.w}/${v.h}"` : ''
  const poster = v.poster ? ` poster="${esc(v.poster)}"` : ''
  const badge = v.poster ? '' : '<span class="wb-video-badge" aria-hidden="true"></span>'
  const mime = /\.webm(\?|#|$)/i.test(v.url) ? 'video/webm' : 'video/mp4'
  const src = esc(v.url)
  // 单行输出（与 weiboImageGrid 一致）：site.js 的 wbVideoHtmlJs 是它的手工 ES5 镜像，
  // tests/weibo-admin.test.ts 把两侧同输入比对，别为了好看加换行缩进
  return `<div class="wb-video${portrait ? ' is-portrait' : ''}${v.poster ? '' : ' is-plain'}"><video controls playsinline preload="metadata"${poster}${ratio}><source src="${src}" type="${mime}"><a class="wb-video-fallback" href="${src}" target="_blank" rel="noopener noreferrer">视频</a></video>${badge}</div>`
}

/** 微博正文链接尾部标点（句读/引号/右括号）留在链接外，括号配对时保留（维基百科类 URL）。
 *  site.js 的 wbTextHtml 有一份同逻辑镜像，改动两边同步 */
export function trimUrlTail(u: string): string {
  let s = u
  while (s.length > 1) {
    const last = s[s.length - 1]
    if (last === ')') {
      const opens = (s.match(/\(/g) || []).length
      if ((s.match(/\)/g) || []).length > opens) {
        s = s.slice(0, -1)
        continue
      }
      break
    }
    if (".,;:!?>'、。，；：！？）】」』》›»…·".includes(last)) {
      s = s.slice(0, -1)
      continue
    }
    break
  }
  return s
}

/** 微博正文分词：URL 与 #话题 共用一个正则一次扫描（先转链接再扫话题会把 href 里的
 *  #fragment 误判成话题、把生成的锚点拆坏）。URL 不吞 CJK 字符与全角标点——
 *  「https://x.com的官网」这类中文紧贴的写法，链接应停在汉字前。
 *  话题名边界与 utils.ts WEIBO_TOPIC_RE 同口径（汉字后可跟话题、ASCII 字母数字防误判、
 *  句读即停），site.js 的 WB_TEXT_RE 是本正则的手工 ES5 镜像 */
const WEIBO_TEXT_RE =
  /(https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+)|((?<![A-Za-z0-9#])#[^\s#&<>"'，。！？；：、…~～,.!?;:]{1,24}(?:#|(?=[\s，。！？；：、…~～,.!?;:])|$))/gu

/** 微博正文：URL 转可点击超链（白名单外域过 /go 中间页，src/outlink.ts），
 *  #话题（或成对 #话题#）渲染成指向 /weibo?topic= 的高亮链接；其余文本转义 */
export function weiboTextHtml(content: string): string {
  let out = ''
  let last = 0
  for (const m of content.matchAll(WEIBO_TEXT_RE)) {
    // 微信表情文本码替换包在每段转义后的纯文本上（属性 href 不包，URL 分段无中文码不会命中）
    out += replaceEmoji(esc(content.slice(last, m.index)))
    last = m.index + m[0].length
    if (m[1]) {
      // URL：尾部标点留在链接外；锚文本与 href 都来自原文分段，经 esc 落进属性/文本上下文
      const url = trimUrlTail(m[1])
      out += `<a class="wb-link" href="${esc(outHref(url))}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${replaceEmoji(esc(m[0].slice(url.length)))}`
      continue
    }
    const name = extractWeiboTopics(m[0])[0]
    if (!name) out += replaceEmoji(esc(m[0]))
    else out += `<a class="wb-topic" href="/weibo?topic=${encodeURIComponent(name)}">${esc(m[0])}</a>`
  }
  return out + replaceEmoji(esc(content.slice(last)))
}

/** 微博话题条：默认不显示（避免标签堆满页头）；仅从正文 #话题 链接进入筛选时，显示「全部 + 当前话题」方便退出筛选 */
export function weiboTopicBar(topics: { name: string; count: number }[], active?: string): string {
  if (!active) return ''
  const hit = topics.find((t) => t.name === active)
  const chip = (name: string, label: string, count?: number) =>
    `<a class="wb-topic-chip${name === (active || '') ? ' is-active' : ''}" href="/weibo${
      name ? `?topic=${encodeURIComponent(name)}` : ''
    }">${esc(label)}${count != null ? `<i>${count}</i>` : ''}</a>`
  return `<nav class="wb-topics" aria-label="微博话题">${chip('', ('全部'))}${chip(active, '#' + active, hit?.count)}</nav>`
}

/** 卡片底栏右侧管理操作（仅管理员登录时渲染，访客 HTML 里不存在；交互在 site.js） */
function weiboAdminBar(w: WeiboItemView): string {
  return `<div class="wb-admin" data-wb-admin="${w.id}">
  <button class="wb-admin-btn" type="button" data-wb-act="edit">编辑</button>
  <button class="wb-admin-btn" type="button" data-wb-act="pin">${w.pinned ? '取消置顶' : '置顶'}</button>
  <button class="wb-admin-btn is-danger" type="button" data-wb-act="del">删除</button>
</div>`
}

/** 心形（点赞）图标：微博底栏 16 与文章页 18 两种规格共用同一 path */
function heartSvg(size: number): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 21s-7.5-4.9-10-9.3C.5 8.4 2.3 4.9 5.7 4.5c2-.2 3.9.8 5 2.5a5.7 5.7 0 0 1 5-2.5c3.4.4 5.2 3.9 3.7 7.2C19.5 16.1 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`
}

/** 微博卡片底栏：点赞（同文章 like-btn，data-type=weibo）+ 评论数（点开卡片内折叠评论区）+ 分享卡片 */
export function weiboCardFoot(w: WeiboItemView, isAdmin?: boolean): string {
  const like = `<button class="wb-action like-btn" type="button" data-type="weibo" data-id="${w.id}" data-likes="${w.likes}" aria-label="点赞">
  ${heartSvg(16)}
  <b class="like-count" data-count>${w.likes}</b>
</button>`
  const cmt = `<button class="wb-action wb-cmt-toggle" type="button" data-wb="${w.id}" aria-label="留言" aria-expanded="false">
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21 11.5c0 4.1-4 7.5-9 7.5-1 0-2-.1-2.9-.4L4 20l1.2-3.2C3.8 15.4 3 13.5 3 11.5 3 7.4 7 4 12 4s9 3.4 9 7.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
  <b class="wb-cmt-count" data-count>${w.commentCount}</b>
</button>`
  // 生成分享卡片（存图/转发）：纯前端，交互在 site.js（按需加载 /share-card.js）；管理三键仍 margin-left:auto 靠右
  const share = `<button class="wb-action wb-share" type="button" data-wb-share="${w.id}" aria-label="生成分享卡片">
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 14V3.5m0 0L8.5 7m3.5-3.5L15.5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 10.5H7a3 3 0 0 0-3 3V18a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <b>分享</b>
</button>`
  return `<footer class="wb-foot">${like}${cmt}${share}${isAdmin ? weiboAdminBar(w) : ''}</footer>`
}

/** 管理员登录时的发言身份行（文章/微博评论表单共用，免填昵称） */
function adminIdentity(name: string): string {
  return `<p class="cmt-as">以作者 <b>${esc(name)}</b> 的身份发言</p><input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">`
}

/** 会员登录时的发言身份行：结构与 adminIdentity 同构（蜜罐字段随行带上），徽标文案区分身份 */
/** 卡片内折叠评论区骨架：列表与表单内容由 site.js 按需填充；adminName 传入时表单免填昵称。
 *  showRegion 开启时在提示位预置「IP 属地」披露文案（site.js 提交/回复会覆盖提示位，属预期） */
export function weiboCommentPanel(
  w: WeiboItemView,
  allowComments: boolean,
  adminName?: string,

  showRegion = false
): string {
  return `<div class="wb-cmt" data-wb-cmt="${w.id}" hidden>
  <div class="wb-cmt-list" data-role="list"><p class="wb-cmt-loading">加载中…</p></div>
  ${
    allowComments
      ? `<form class="wb-cmt-form${adminName ? ' is-admin' : ''}" data-role="form">
  ${
    adminName
      ? adminIdentity(adminName)
      : `<div class="wb-cmt-row">
    <input class="wb-cmt-input" name="nickname" maxlength="24" placeholder="昵称" required>
    <input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">
  </div>
  <div class="wb-cmt-row">
    <input class="wb-cmt-input" name="qq" inputmode="numeric" maxlength="11" placeholder="QQ 号（选填，展示头像）" autocomplete="off" title="仅用于抓取头像，不会公开展示">
  </div>`
  }
  <textarea class="wb-cmt-textarea" name="content" maxlength="1000" rows="2" placeholder="说点什么…" required></textarea>
  <div class="wb-cmt-foot"><span class="wb-cmt-tip">${showRegion ? esc(('发布后将显示 IP 属地')) : ''}</span><button class="wb-cmt-submit" type="submit">发送</button></div>
</form>`
      : ''
  }
</div>`
}

export function weiboCards(o: {
  settings: SettingsMap
  items: WeiboItemView[]
  avatarHtml: string
  allowComments?: boolean
  /** 登录管理员昵称：评论表单免填昵称，以作者身份发言；传入即在卡片上渲染管理操作（编辑/置顶/删除） */
  adminName?: string
  /** 登录会员昵称（管理员未登录时生效）：评论表单免填昵称，以会员身份发言 */
}): string {
  const name = o.settings.siteName || '微博'
  const allowComments = o.allowComments !== false
  const isAdmin = !!o.adminName
  return o.items
    .map((w) => {
      const foot = weiboCardFoot(w, isAdmin)
      const panel = weiboCommentPanel(w, allowComments, o.adminName, o.settings.showCommentRegion === '1')
      return `<article class="wb-card${w.pinned ? ' is-pinned' : ''}" id="wb-${w.id}">
  <header class="wb-head">
    <span class="wb-avatar">${o.avatarHtml}</span>
    <div class="wb-who">
      <span class="wb-name">${esc(name)}</span>
      <time class="wb-time" datetime="${safeIso(w.created_at)}">${weiboTime(w.created_at)}</time>
    </div>
    ${w.pinned ? `<span class="wb-pin">置顶</span>` : ''}
  </header>
  ${w.content ? `<div class="wb-text">${weiboTextHtml(w.content)}</div>` : ''}
  ${w.video ? weiboVideoHtml(w.video) : ''}
  ${weiboImageGrid(w.images)}
  ${foot}
  ${panel}
</article>`
    })
    .join('\n')
}

/** 微博模块头部（入口卡与首页微博流共用）：整条指向 /weibo；countLabel 换计数文案（搜索结果区用「命中 N 条」） */
function weiboHomeHead(total: number,  countLabel?: string): string {
  return `<a class="wb-home-head" href="/weibo">
    <svg class="wb-home-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
    <span class="wb-home-title">微博 · 随手记</span>
    <span class="wb-home-count">${countLabel || `共 ${total} 条`}</span>
    <span class="wb-home-more">全部 →</span>
  </a>`
}

/** 首页微博入口卡：最新几条随手记摘要 + 总条数，整卡指向 /weibo（无已发布微博时不渲染） */
export function weiboHomeEntry(o: { items: WeiboItemView[]; total: number;  }): string {
  if (!o.items.length) return ''
  const items = o.items
    .map((w) => {
      // 无正文时用媒体兜底文案：视频优先，其次配图数；视频的封面帧同时充当初图
      const text = w.content || ''
      const short = text
        ? excerpt(text, 64)
        : w.video
          ? '发了一段视频'
          : `发了 ${w.images.length} 张图`
      const thumbUrl = w.images[0] || (w.video ? w.video.poster : '')
      const thumb = thumbUrl
        ? `<span class="wb-home-thumb"><img src="${esc(variantUrl(thumbUrl, 192))}" loading="lazy" decoding="async" alt=""></span>`
        : ''
      return `<a class="wb-home-item" href="/weibo?wb=${w.id}#wb-${w.id}">
  <div class="wb-home-main">
    <p class="wb-home-text">${esc(short)}</p>
    <time class="wb-home-time" datetime="${safeIso(w.created_at)}">${weiboTime(w.created_at)}</time>
  </div>
  ${thumb}
</a>`
    })
    .join('\n')
  return `<section class="wb-home" aria-label="微博随手记">
  ${weiboHomeHead(o.total)}
  ${items}
</section>`
}

/**
 * 首页微博流（微博+博客模式）：完整微博卡片先行（点赞/评论/管理键全可用，交互在 site.js），
 * 更早的顺着头部「全部 →」进 /weibo。卡片容器复用 /weibo 页的 .wb-list 间距。
 */
export function weiboHomeFeed(o: {
  settings: SettingsMap
  items: WeiboItemView[]
  total: number
  avatarHtml: string
  allowComments?: boolean
  adminName?: string
}): string {
  if (!o.items.length) return ''
  const cards = weiboCards({
    settings: o.settings,
    items: o.items,
    avatarHtml: o.avatarHtml,
    allowComments: o.allowComments,
    adminName: o.adminName,
  })
  return `<section class="wb-home-feed" aria-label="微博随手记">
  ${weiboHomeHead(o.total)}
  <div class="wb-list">${cards}</div>
</section>`
}

/**
 * 搜索页微博结果（ROADMAP B4，fts.ts 搜出的微博在这里渲染）：结构整体复用首页微博流的
 * wb-home-feed / wb-card 系列样式（六主题已有样式，零新增 CSS），头部计数换成「命中 N 条」。
 * 只读视角：不带管理操作与评论表单（allowComments: false），点赞与评论列表展开照常可用。
 */
export function weiboSearchResults(o: {
  settings: SettingsMap
  items: WeiboItemView[]
  total: number
  avatarHtml: string
}): string {
  if (!o.items.length) return ''
  const cards = weiboCards({
    settings: o.settings,
    items: o.items,
    avatarHtml: o.avatarHtml,
    allowComments: false,
  })
  return `<section class="wb-home-feed" aria-label="微博搜索结果">
  ${weiboHomeHead(o.total,  (`命中 ${o.total} 条`))}
  <div class="wb-list">${cards}</div>
</section>`
}

/* ---------------- 搜索页的「补充结果」：独立页面与标签 ---------------- * 文章列表之外的两组浅结果，整体一段预渲染 HTML（themes 只需透传 d.searchExtras）。
 * 刻意复用既有 class：页面行用 .search-meta（八主题都有），标签用 .fs-bar/.fs-chip
 * （排序条那套 chip 样式），不新增任何一个 CSS 类，八套主题自动同款。
 */

/** 补充结果：命中的独立页面（标题链到 /page/:slug）+ 命中的标签（chip 链到 /tag/:name）。
 *  两组都没命中时返回空串，主题侧 `d.searchExtras || ''` 不渲染。 */
export function searchExtrasHtml(o: {
  pages?: { slug: string; title: string }[] | null
  pagesTotal?: number
  tags?: { name: string; count: number }[] | null
  tagsTotal?: number
  q?: string
}): string {
  const parts: string[] = []
  if (o.pages && o.pages.length) {
    const links = o.pages
      .map((p) => `<a href="/page/${encodeURIComponent(p.slug)}">${markHtml(p.title, o.q)}</a>`)
      .join(' · ')
    // 超过显示条数时点明还有几条，不让人以为「页面就这些」
    const more = o.pagesTotal && o.pagesTotal > o.pages.length ? `（共 ${o.pagesTotal} 个页面命中）` : ''
    parts.push(`<p class="search-meta">相关页面${more}：${links}</p>`)
  }
  if (o.tags && o.tags.length) {
    const chips = o.tags
      .map(
        (t) =>
          `<a class="fs-chip" href="${tagLink(t.name)}" title="${esc(t.name)}（${t.count} 篇）">${markHtml(t.name, o.q)}</a>`
      )
      .join('')
    const more = o.tagsTotal && o.tagsTotal > o.tags.length ? `<span class="fs-label">共 ${o.tagsTotal} 个</span>` : ''
    parts.push(`<nav class="fs-bar" aria-label="相关标签"><span class="fs-label">标签</span>${chips}${more}</nav>`)
  }
  return parts.join('\n')
}

/** 零命中兜底：搜不到东西时搜索页不该是死胡同——给「热门标签」和「最近发布」两条出路。
 *  同样复用 .search-meta / .fs-bar / .fs-chip，零新增 CSS；两组都空时返回空串。 */
export function searchFallbackHtml(o: {
  tags?: string[]
  posts?: { slug: string; title: string }[]
}): string {
  const tags = (o.tags || []).slice(0, 8)
  const posts = (o.posts || []).slice(0, 5)
  const parts: string[] = []
  if (tags.length) {
    parts.push(
      `<nav class="fs-bar" aria-label="热门标签"><span class="fs-label">热门标签</span>${tags
        .map((t) => `<a class="fs-chip" href="${tagLink(t)}">${esc(t)}</a>`)
        .join('')}</nav>`
    )
  }
  if (posts.length) {
    parts.push(
      `<p class="search-meta">最近发布：${posts
        .map((p) => `<a href="/post/${encodeURIComponent(p.slug)}">${esc(p.title)}</a>`)
        .join(' · ')}</p>`
    )
  }
  return parts.join('\n')
}

/** 评论头像位（文章 / 留言板评论）：作者（管理员）发言用站点头像（settings.avatarUrl，
 *  与微博卡/后台侧栏同源）；游客有站内转存 QQ 头像用图；其余退回昵称首字块。
 *  site.js 的微博评论渲染是本函数的 ES5 手工镜像，改任一侧记得同步 */
function commentAvatarHtml(c: CommentRow, adminAvatar?: string): string {
  if (c.is_admin && adminAvatar) return `<img class="cmt-avatar cmt-avatar-img" src="${esc(variantUrl(adminAvatar, 192))}" alt="">`
  // 游客自填 QQ 抓取转存的站内头像（C2 扩展）：qq 本体永不出参，这里只会是 /images/ 地址
  if (c.avatar) return `<img class="cmt-avatar cmt-avatar-img" src="${esc(variantUrl(c.avatar, 192))}" loading="lazy" decoding="async" alt="">`
  const ch = (c.nickname || '客').trim().charAt(0) || '客'
  return `<span class="cmt-avatar" aria-hidden="true">${esc(ch)}</span>`
}

export interface OnThisDayItemView {
  kind: 'post' | 'weibo'
  href: string
  text: string
  ts: number
  yearsAgo: number
}

/** 年份标签：1 = 去年，2+ = N 年前 */
function otdYearLabel(yearsAgo: number): string {
  return yearsAgo <= 1 ? '去年' : `${yearsAgo} 年前`
}

/** 卡片直出条数，其余进「展开」折叠区——当天历史再多也不挤丢，只多占一行摘要 */
const OTD_VISIBLE = 4

function otdRow(it: OnThisDayItemView): string {
  return `<a class="otd-item" href="${esc(it.href)}">
  <span class="otd-year">${cstDate(it.ts).getUTCFullYear()}<i>${otdYearLabel(it.yearsAgo)}</i></span>
  <span class="otd-text">${esc(it.text)}</span>
  <span class="otd-kind">${it.kind === 'post' ? '文章' : '微博'}</span>
</a>`
}

export function onThisDayCard(items: OnThisDayItemView[] | null | undefined): string {
  if (!items?.length) return ''
  const rest = items.slice(OTD_VISIBLE)
  // 原生 <details> 折叠：无 JS 可用（CSP 禁内联脚本），开关文案由 CSS 按 open 态切换
  const more = rest.length
    ? `<details class="otd-more">
  <summary><span class="otd-fold-more">${`展开其余 ${rest.length} 条 ▾`}</span><span class="otd-fold-less">收起 ▴</span></summary>
  ${rest.map((it) => otdRow(it)).join('\n')}
</details>`
    : ''
  return `<section class="otd-card" aria-label="历史上的今天">
  <header class="otd-head">
    <svg class="otd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
    <span class="otd-title">历史上的今天</span>
    <span class="otd-sub">时间经过的地方，总会留下点什么</span>
  </header>
  ${items.slice(0, OTD_VISIBLE).map((it) => otdRow(it)).join('\n')}
  ${more}
</section>`
}

/** 前台微博页发布框：管理员登录时由主题渲染在时间线顶部（访客不可见），交互在 site.js，与后台发布器同款能力。
 *  按钮顺序是契约：site.js 用 `querySelector('.wb-composer-add')` 取唯一的媒体按钮（管计数与上传进度），
 *  它必须排在 JS 后插的表情按钮之前；媒体入口只有这一个（图片与视频同一个选择器，视频另走视频通道），
 *  视频预览容器 `.wb-composer-video` 由 site.js 填充。tests/weibo-admin.test.ts 有守卫。 */
export function weiboComposer(o: { adminName: string;  }): string {
  return `<form class="wb-composer" data-wb-composer>
  <p class="wb-composer-as">以作者 <b>${esc(o.adminName)}</b> 的身份发布</p>
  <textarea class="wb-composer-textarea" name="content" maxlength="5000" rows="3" placeholder="有什么新鲜事？写 #话题 即可归类"></textarea>
  <div class="wb-composer-tiles" hidden></div>
  <div class="wb-composer-video" hidden></div>
  <div class="wb-composer-foot">
    <button class="wb-composer-add" type="button" title="图片 / 视频，一条微博最多 1 个视频">加图（0/9）</button>
    <span class="wb-composer-count" data-count>0 / 5000</span>
    <span class="wb-composer-tip" data-tip aria-live="polite"></span>
    <span class="wb-composer-actions">
      <button class="wb-composer-draft" type="button">存草稿</button>
      <button class="wb-composer-publish" type="button">发布</button>
    </span>
  </div>
</form>`
}

/** 微博页翻页：上一页 / 下一页 + 页码跳转表单（与文章列表 pagerHtml 同款）；
 *  按话题筛选时翻页与跳转都要带上 topic。
 *  跳转表单 action 固定指向 /weibo：纯微博模式下本页渲染在 '/'，而翻页链接本就仍指 /weibo
 *  （同一内容，见 pages.ts renderWeibo 注释），保持一致。 */
export function weiboPager(page: number, totalPages: number, topic?: string): string {
  if (totalPages <= 1) return ''
  const href = (p: number) => `/weibo?page=${p}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`
  const prevLabel = '← 新一条'
  const nextLabel = '更早的 →'
  const prev =
    page > 1
      ? `<a class="wb-pager-btn" href="${href(page - 1)}">${prevLabel}</a>`
      : `<span class="wb-pager-btn is-disabled">${prevLabel}</span>`
  const next =
    page < totalPages
      ? `<a class="wb-pager-btn" href="${href(page + 1)}">${nextLabel}</a>`
      : `<span class="wb-pager-btn is-disabled">${nextLabel}</span>`
  // 页码跳转：纯 HTML GET 表单（CSP 禁内联脚本），隐藏域带回 topic；
  // 结构 / class 与文章列表 pagerHtml 的 .pager-jump 完全相同——七主题已共用一套样式，无需新增 CSS
  const jump = `<form class="pager-jump" action="/weibo" method="get">${
    topic ? `<input type="hidden" name="topic" value="${esc(topic)}">` : ''
  }<span class="pager-jump-text">跳至</span><input class="pager-input" type="number" name="page" min="1" max="${totalPages}" value="${page}" aria-label="页码"><span class="pager-jump-text">页</span><span class="pager-jump-text">/ 共 ${totalPages} 页</span><button class="pager-go" type="submit">跳转</button></form>`
  return `<nav class="wb-pager">${prev}<span class="wb-pager-info">${page} / ${totalPages}</span>${next}</nav>${jump}`
}

export interface PagerContext {
  page: number
  totalPages: number
  /** 形如 "/" 或 "/?tag=生活&" —— 会拼接 page=N */
  base: string
}

export function pagerHtml(c: PagerContext): string {
  if (c.totalPages <= 1) return ''
  const link = (p: number, label: string, cls: string, disabled = false) =>
    disabled
      ? `<span class="pager-btn ${cls} is-disabled">${label}</span>`
      : `<a class="pager-btn ${cls}" href="${esc(c.base)}page=${p}">${label}</a>`
  let nums = ''
  const start = Math.max(1, c.page - 2)
  const end = Math.min(c.totalPages, start + 4)
  for (let p = start; p <= end; p++) {
    nums += link(p, String(p), `pager-num${p === c.page ? ' is-current' : ''}`)
  }
  // 页码跳转：纯 HTML GET 表单（CSP 禁内联脚本），base 里的参数（tag/sort/seed…）原样带回
  const baseQs = c.base.replace(/^[^?]*\?/, '').replace(/&+$/, '')
  const hidden = [...new URLSearchParams(baseQs).entries()]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('')
  const jump = `<form class="pager-jump" action="${esc(c.base.split('?')[0] || '/')}" method="get">${hidden}<span class="pager-jump-text">${
    '跳至'
  }</span><input class="pager-input" type="number" name="page" min="1" max="${c.totalPages}" value="${c.page}" aria-label="页码">${
    `<span class="pager-jump-text">页</span><span class="pager-jump-text">/ 共 ${c.totalPages} 页</span><button class="pager-go" type="submit">跳转</button>`
  }</form>`
  return `<nav class="pager">${link(c.page - 1, ('← 上一页'), 'pager-prev', c.page <= 1)}${nums}${link(
    c.page + 1,
    ('下一页 →'),
    'pager-next',
    c.page >= c.totalPages
  )}</nav>${jump}`
}

/** 留言区（评论列表 + 表单），语义化 class 交给主题 CSS 塑形
 * - 楼中楼：parent_id 指向顶层评论的回复缩进展示，作者发言带「作者」徽标
 * - isAdmin：当前访客为管理员，渲染每条留言的「回复」按钮（site.js 接管交互）
 * - guestbook：留言板页（/guestbook）复用同一套结构，表单提交到 /api/public/guestbook
 */
export function commentsHtml(o: {
  comments: CommentRow[]
  slug: string
  allowComments: boolean
  count: number
  isAdmin?: boolean
  /** 登录管理员昵称：表单免填昵称，以作者身份发言 */
  adminName?: string
  /** 站点头像（settings.avatarUrl）：作者（管理员）评论的头像位用它，与微博卡同源 */
  adminAvatar?: string
  title?: string
  tip?: string
  /** 留言板模式：区块与表单换成 guestbook 专用 id，提交目标不同 */
  guestbook?: boolean
  /** 展示评论 IP 属地（settings.showCommentRegion）：标签由 ipRegionLabel 单点格式化，
   *  关闭时不渲染；采集与出参门控见 api.ts */
  showRegion?: boolean
}): string {
  const tops = o.comments.filter((c) => !c.parent_id)
  const children = new Map<number, CommentRow[]>()
  for (const c of o.comments) {
    if (!c.parent_id) continue
    const list = children.get(c.parent_id) || []
    list.push(c)
    children.set(c.parent_id, list)
  }

  // 孤儿回复（父评论被删）：按顶层展示，避免消失（先建 id 集合，免得逐条平方级扫全量评论）
  const commentIds = new Set(o.comments.map((c) => c.id))
  const orphans = o.comments.filter((c) => c.parent_id && !commentIds.has(c.parent_id))
  for (const c of orphans) tops.push({ ...c, parent_id: 0 })

  const renderItem = (c: CommentRow, floor?: number): string => {
    // 徽标：作者（文章语境叫「楼主」，留言板没有楼层的概念沿用「作者」）。楼层号只标顶层评论
    //（盖楼的是一楼一层，楼中楼不占号）
    const badge = c.is_admin ? `<span class="cmt-badge">${o.guestbook ? '作者' : '楼主'}</span>` : ''
    // 操作键：登录管理员有回复 + 删除；只对登录身份渲染（访客 HTML 里不存在）。
    // 前台删评论走后台 /api/admin/comments/:id（会话鉴权）
    const adminBtns = o.isAdmin
      ? `<button class="cmt-reply-btn" type="button" data-reply="${c.id}" data-name="${esc(c.nickname)}">回复</button>
    <button class="cmt-del-btn" type="button" data-cmt-del="${c.id}" title="删除这条评论（其下回复一并删除，不可恢复）">删除</button>`
      : ''
    const kids = children.get(c.id) || []
    // IP 属地：与楼号同款小灰字（复用内联样式，七主题零改动）；开关关闭或无快照（旧评论/自托管）不渲染
    const region = o.showRegion ? ipRegionLabel(c.ip_region || '') : ''
    // 操作键位单列成参数：遮罩项一律不给任何键（回复键会把「正文拿不到」变成「能往私密楼里打字」）
    const head = (btns: string): string => `<div class="cmt-head">
    ${commentAvatarHtml(c, o.adminAvatar)}
    <span class="cmt-name">${esc(c.nickname)}${badge}</span>
    <span class="cmt-time">${fmtDateTime(c.created_at)}</span>
    ${region ? `<span class="cmt-region" style="font-size:11px;opacity:0.45">${esc(region)}</span>` : ''}
    ${floor ? `<span class="cmt-floor" style="font-size:11px;opacity:0.45;font-variant-numeric:tabular-nums">#${floor}</span>` : ''}
    ${btns}
  </div>`
    return `<li class="cmt-item" id="cmt-${c.id}">
  ${head(adminBtns)}
  <div class="cmt-body">${replaceEmoji(esc(c.content))}</div>
  ${kids.length ? `<ul class="cmt-children">${kids.map((k) => renderItem(k)).join('')}</ul>` : ''}
</li>`
  }

  const list = tops.map((c, i) => renderItem(c, i + 1)).join('\n')

  const formInner = `
  <input type="hidden" name="parentId" value="">
  ${
    o.adminName
      ? adminIdentity(o.adminName)
      : `<div class="cmt-form-row">
    <input class="cmt-input" name="nickname" maxlength="24" placeholder="昵称" required>
    <input class="cmt-input cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">
  </div>
  <div class="cmt-form-row">
    <input class="cmt-input" name="qq" inputmode="numeric" maxlength="11" placeholder="QQ 号（选填，展示头像）" autocomplete="off" title="仅用于抓取头像，不会公开展示">
  </div>`
  }
  <textarea class="cmt-textarea" name="content" maxlength="1000" rows="3" placeholder="${
    o.guestbook ? '想对作者说点什么…' : '写下你的想法…'
  }" required></textarea>
  <div class="cmt-form-foot">
    <span class="cmt-tip">${esc(`${o.tip || '留言即刻展示，请友善交流'}${o.showRegion ? ` · 发布后将显示 IP 属地` : ''}`)}</span>
    <button class="cmt-submit" type="submit">发送</button>
  </div>
`
  const form = o.allowComments
    ? o.guestbook
      ? `<form id="guestbook-form" class="cmt-form${o.adminName ? ' is-admin' : ''}" data-guestbook="1">${formInner}</form>`
      : `<form id="comment-form" class="cmt-form${o.adminName ? ' is-admin' : ''}" data-slug="${esc(o.slug)}">${formInner}</form>`
    : `<p class="cmt-closed">作者已关闭留言。</p>`

  return `<section class="cmt-section${o.guestbook ? ' gb-section' : ''}" id="${o.guestbook ? 'guestbook' : 'comments'}">
  <h2 class="cmt-title">${esc(o.title || (o.guestbook ? '留言板' : '留言'))} <span class="cmt-count">${o.count}</span></h2>
  ${o.comments.length ? `<ul class="cmt-list">${list}</ul>` : `<p class="cmt-empty">${o.guestbook ? '还没有人留言，来坐个沙发，说点什么吧～' : '还没有留言，来抢沙发～'}</p>`}
  ${form}
</section>`
}

export function likesBtn(slug: string, likes: number): string {
  return `<button class="like-btn" data-slug="${esc(slug)}" data-likes="${likes}" type="button">
  ${heartSvg(18)}
  <span class="like-label">赞</span>
  <b class="like-count" data-count>${likes}</b>
</button>`
}

/**
 * 文章分享按钮：data-share-url 是 canonical 绝对链接，data-share-qr 是该链接的
 * QR 矩阵位串（src/qrcode.ts packMatrix 产物，空串表示链接超长未生成码）。
 * 交互在 site.js：点击按需加载 /share-card.js 弹出分享面板（复制链接/系统分享/卡片图）。
 */
export function shareBtn(url: string, qr: string): string {
  return `<button class="share-btn" type="button" data-share-url="${esc(url)}"${
    qr ? ` data-share-qr="${esc(qr)}"` : ''
  } aria-label="分享本文">
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 14V3.5m0 0L8.5 7m3.5-3.5L15.5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 10.5H7a3 3 0 0 0-3 3V18a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <span class="share-label">分享</span>
</button>`
}

export function tagLink(name: string): string {
  return `/tag/${encodeURIComponent(name)}`
}

/* ---------------- 搜索关键词高亮与命中片段 ----------------
 * 搜索页要把「为什么这条排在这」说清楚：标题/摘要里的命中词标成 <mark>，
 * 标题摘要都没提词（正文命中）时，摘要位改吐正文里第一处命中前后的片段。
 * 两者都在 esc() 之后做——拼进 HTML 的只有 <mark> 这一对标签，用户输入全程被转义。
 */

/** 正则元字符转义：关键词里的 . * ( ) 不能当通配符 */
function regexEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 关键词切词：与 src/fts.ts 的 MATCH 表达式同源（按空白切、去重、最长优先，
 *  最长优先避免「博客」被「博」抢先切碎），上限 12 个词防超长查询拖慢正则 */
export function searchTerms(q: string | undefined): string[] {
  if (!q) return []
  return [...new Set(q.split(/\s+/).map((t) => t.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 12)
}

/** 文本里是否含任一关键词（大小写不敏感；空关键词恒 false） */
export function textHasTerm(text: string, q: string | undefined): boolean {
  if (!text || !q) return false
  const lower = text.toLowerCase()
  return searchTerms(q).some((t) => lower.includes(t.toLowerCase()))
}

/** 关键词高亮：先 esc 再包 <mark class="srch-hl">，返回可直接拼进 HTML 的串。
 *  q 为空时与 esc(text) 逐字节相同——非搜索页的输出一点没变。 */
export function markHtml(text: unknown, q?: string): string {
  const s = esc(text)
  const terms = searchTerms(q)
  if (!s || !terms.length) return s
  const re = new RegExp(terms.map((t) => regexEsc(esc(t))).join('|'), 'gi')
  return s.replace(re, (m) => `<mark class="srch-hl">${m}</mark>`)
}

/** 正文命中片段：正文纯文本里取首处命中前后各 ~1/3 词长的片段（标题与摘要都没命中时顶替摘要）。
 *  找不到命中就原样返回 fallback——不硬造一段跟关键词无关的正文。 */
export function searchSnippet(contentHtml: string, q: string | undefined, fallback = '', n = 96): string {
  const text = plainText(contentHtml || '')
  if (!text) return fallback
  const lower = text.toLowerCase()
  let at = -1
  for (const t of searchTerms(q)) {
    const i = lower.indexOf(t.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return fallback
  const start = Math.max(0, at - Math.floor(n / 3))
  const end = Math.min(text.length, start + n)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** 搜索高亮样式（只在 /search 页随主题 CSS 一起内联，其他页面零字节）。
 *  半透明琥珀底 + color: inherit：亮色主题上是荧光笔，深色主题上仍是浅字可读，
 *  八套主题共用一段，不必各写一份。 */
export const SEARCH_HL_CSS =
  'mark.srch-hl{background:rgba(255,196,0,.38);color:inherit;padding:0 .1em;border-radius:2px;}'

/* ---------------- 首页列表排序筛选（共享构建器） ----------------
 * 结构全主题共用（语义化 .fs-* class），视觉由主题 CSS 塑形。
 * 随机排序：点「随机」不带 seed，服务端每次生成新 seed 洗一组；
 * 翻页链接带 seed，保证同一组随机顺序不重洗。
 */

/** 列表页排序可选项与文案 */
export const HOME_SORTS: { key: PostSort; label: string }[] = [
  { key: 'latest', label: '最新' },
  { key: 'views', label: '最多阅读' },
  { key: 'likes', label: '最多点赞' },
  { key: 'comments', label: '最多留言' },
  { key: 'random', label: '随机' },
]

/** 搜索页排序档位（相关度 / 时间）。与首页那套 PostSort 是两回事：
 *  「最多阅读 / 随机」在搜索结果里没有意义，硬塞进排序条只会让人以为排序坏了 */
export type SearchSort = 'relevance' | 'time'

export const SEARCH_SORTS: { key: SearchSort; label: string }[] = [
  { key: 'relevance', label: '相关度' },
  { key: 'time', label: '最新发布' },
]

export interface ListPageContext {
  /** 列表排序：搜索页传 SearchSort，其余页传 PostSort（两套白名单互不串门） */
  sort?: PostSort | SearchSort
  seed?: number
  tag?: string
  categorySlug?: string
  q?: string
}

/** 列表地址共用的查询串：tag/q/sort/seed 四件套 */
function listQuery(o: ListPageContext): string {
  const params = new URLSearchParams()
  if (o.tag) params.set('tag', o.tag)
  if (o.q) params.set('q', o.q)
  if (o.q) {
    // 搜索页：默认相关度（不写进 URL，保持 /search?q=x 这条干净短链），只有时间序才带 sort
    if (o.sort === 'time') params.set('sort', 'time')
  } else if (o.sort && o.sort !== 'latest') {
    params.set('sort', o.sort)
    if (o.sort === 'random' && o.seed) params.set('seed', String(o.seed))
  }
  return params.toString()
}

/** 排序条/翻页共用的列表地址：分类页、搜索页留在原路径，首页/标签页用 /?tag= */
export function listPageUrl(o: ListPageContext): string {
  const qs = listQuery(o)
  if (o.categorySlug) return `/category/${encodeURIComponent(o.categorySlug)}${qs ? `?${qs}` : ''}`
  if (o.q) return `/search${qs ? `?${qs}` : ''}`
  return '/' + (qs ? `?${qs}` : '')
}

/** 排序筛选条：一排 chips，当前排序高亮；点「随机」永远洗新一组。
 *  带 q 时（搜索页）换成相关度/时间两档——搜索结果按「最多阅读」排是说不通的。 */
export function homeSortBar(o: ListPageContext): string {
  const isSearch = !!o.q
  const active = isSearch ? (o.sort === 'time' ? 'time' : 'relevance') : o.sort || 'latest'
  const items: { key: string; label: string }[] = isSearch ? SEARCH_SORTS : HOME_SORTS
  const chips = items
    .map(
      (s) =>
        `<a class="fs-chip${s.key === active ? ' is-active' : ''}" href="${esc(
          listPageUrl({ ...o, sort: s.key as PostSort, seed: undefined })
        )}">${s.label}</a>`
    )
    .join('')
  return `<nav class="fs-bar" aria-label="${isSearch ? '搜索结果排序' : '文章排序'}"><span class="fs-label">排序</span>${chips}</nav>`
}

/** 翻页链接前缀（形如 "/?tag=x&sort=random&seed=5&"），随机时带 seed 稳住顺序 */
export function homeListBase(o: ListPageContext): string {
  const qs = listQuery(o)
  const head = o.categorySlug
    ? `/category/${encodeURIComponent(o.categorySlug)}?`
    : o.q
      ? '/search?'
      : '/?'
  return head + (qs ? qs + '&' : '')
}

/** 浏览量缩写：超过 1 万记作「1.2w」（万） */
export function fmtViews(n: number): string {
  return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w' : String(n)
}

export { esc, fmtDate, fmtDateCN }
