import type { SettingsMap } from '../types'
import type { AboutData, ArchivesData, GuestbookData, HomeData, LinksData, MemberData, PageData, PostData, RankData, WeiboData } from './registry'
import {
  archiveListHtml,
  categoryLink,
  esc,
  fmtDate,
  footCardHtml,
  footLinks,
  friendLinkApply,
  friendLinkCards,
  homeListBase,
  homeSortBar,
  likesBtn,
  memberAuthHtml,
  memberCardHtml,
  rankListHtml,
  newSiteGuideHtml,
  onThisDayCard,
  postNeighborsHtml,
  pagerHtml,
  paywallHtml,

  shareBtn,
  siteMode,
  siteNav,
  tagLink,

  weiboCards,
  weiboComposer,
  weiboHomeFeed,
  weiboHomeEntry,
  weiboSearchResults,
  weiboPager,
  weiboTopicBar,
  yearStatsSuffix,
  heatmapHtml,
} from '../render'
import css from './news.css'

const id = 'news'

/** 页脚公共件：八个页面只差链接组 */
function foot(s: SettingsMap, links: string): string {
  return `<footer class="nw-footer">${footCardHtml(s)}<span>${esc((s.footerText || ''))}</span><span>${footLinks(s, links)}</span></footer>`
}

const FOOT_LINKS = {
  home: '<a href="/weibo">快讯</a><a href="/archives">归档</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>',
  article: '<a href="/">首页</a><a href="/weibo">快讯</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>',
  about: '<a href="/">首页</a><a href="/weibo">快讯</a><a href="/admin">管理</a>',
}

function avatar(s: SettingsMap): string {
  return s.avatarUrl ? `<img class="nw-avatar" src="${esc(s.avatarUrl)}" alt="${esc(s.siteName)}">` : ''
}

function masthead(s: SettingsMap,  active: string, extraNav = ''): string {
  return `<header class="nw-masthead">
  <a class="nw-logo" href="/">${avatar(s)}<span>${esc((s.siteName))}</span><i class="nw-date">每日更新</i></a>
  <nav class="nw-nav">${extraNav}<a class="nw-nav-link${active === 'weibo' ? ' is-active' : ''}" href="/weibo">快讯</a><a class="nw-nav-link${active === 'archives' ? ' is-active' : ''}" href="/archives">归档</a><a class="nw-nav-link${active === 'about' ? ' is-active' : ''}" href="/about">关于我</a></nav>
</header>`
}

/** 首页三段式（快讯主题的核心）：头条（最新文章大卡）→ 快讯流（微博紧凑卡）→ 文章列表 */
export function home(d: HomeData): string {
  const s = d.settings
  const head = d.posts[0]
  const rest = d.posts.slice(1)
  const headline = head
    ? `<a class="nw-headline" href="/post/${esc(head.slug)}">
  ${head.cover ? `<div class="nw-headline-media"><img src="${esc(head.cover)}" alt=""></div>` : ''}
  <div class="nw-headline-main">
    <span class="nw-kicker">今日头条</span>
    <h2 class="nw-headline-title">${esc(head.title)}</h2>
    <p class="nw-headline-abs">${esc(head.summary)}</p>
    <time class="nw-headline-time">${fmtDate(head.published_at)}</time>
  </div>
</a>`
    : ''
  const feed = d.weiboFeed
  const flash = feed
    ? `<section class="nw-flash">
  <h2 class="nw-kicker nw-kicker-bar">快讯<i>${feed.total} 条</i></h2>
  <div class="nw-flash-flow">${weiboHomeFeed({ settings: s, items: feed.items, total: feed.total, avatarHtml: avatar(s), allowComments: feed.allowComments, adminName: feed.adminName, memberName: feed.memberName })}</div>
  <a class="nw-flash-more" href="/weibo">全部快讯 →</a>
</section>`
    : ''
  const items = rest
    .map(
      (p) => `<a class="nw-item" href="/post/${esc(p.slug)}">
  <div class="nw-item-main">
    <h3 class="nw-item-title">${esc(p.title)}${p.pinned ? `<sup class="nw-pin">置顶</sup>` : ''}</h3>
    <p class="nw-item-abs">${esc(p.summary)}</p>
    <time class="nw-item-time">${fmtDate(p.published_at)}</time>
  </div>
  ${p.cover ? `<div class="nw-thumb"><img src="${esc(p.cover)}" loading="lazy" alt=""></div>` : ''}
</a>`
    )
    .join('\n')
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive })}
  ${masthead(s,  'home')}
  <p class="nw-intro">${esc((s.siteDescription))}</p>
  ${d.notice ? `<div class="nw-notice">${d.notice}</div>` : ''}
  ${d.newSite ? newSiteGuideHtml() : ''}
  ${onThisDayCard(d.onThisDay)}
  ${headline}
  ${flash}
  ${searchBar(d.q)}
  ${homeSortBar({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q })}
  <main class="nw-list">
    ${items || `<p class="nw-empty">${d.emptyText || '还没有文章。'}</p>`}
  </main>
  ${pagerHtml({ page: d.page, totalPages: d.totalPages, base: homeListBase({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }) })}
  ${d.searchWeibo ? weiboSearchResults({ settings: s, items: d.searchWeibo.items, total: d.searchWeibo.total, avatarHtml: avatar(s) }) : ''}
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

function searchBar(q: string | undefined): string {
  return `<form class="nw-search" action="/search" method="get" role="search">
  <input class="nw-search-input" type="search" name="q" value="${esc(q || '')}" placeholder="搜索文章…" maxlength="60" aria-label="搜索文章">
  <button class="nw-search-btn" type="submit">搜索</button>
</form>`
}

/** 文章页：报纸排版（标题衬线、meta 行规整、正文 rich） */
export function post(d: PostData): string {
  const p = d.post
  const related = d.related.length
    ? `<aside class="nw-related"><h2 class="nw-kicker nw-kicker-bar">继续读</h2>${d.related.map((r) => `<a class="nw-related-item" href="/post/${esc(r.slug)}">${esc(r.title)}</a>`).join('')}</aside>`
    : ''
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages })}
  ${masthead(d.settings,  'article')}
  <article class="nw-paper">
    <h1 class="nw-title">${esc(p.title)}</h1>
    <div class="nw-meta">${p.authorName ? `<span>文/${esc(p.authorName)}</span><span>·</span>` : ''}<time>${fmtDate(p.published_at)}</time><span>·</span><span>${p.views} 阅读</span>${p.aiGenerated ? `<span>·</span><span>AI 生成</span>` : ''}</div>
    ${p.cover ? `<div class="nw-cover"><img src="${esc(p.cover)}" alt=""></div>` : ''}
    <div class="rich">${p.contentHtml}</div>
    ${p.locked ? paywallHtml(p.minTier,  d) : ''}
    <div class="nw-foot">
      ${likesBtn(p.slug, p.likes)}
      ${d.share ? shareBtn(d.share.url, d.share.qr) : ''}
      <div class="nw-tags">${d.category ? `<a href="${categoryLink(d.category)}">${esc(d.category.name)}</a>` : ''}${p.tags.map((t) => `<a href="${tagLink(t)}">${esc(t)}</a>`).join('')}</div>
    </div>
    ${related}
    ${postNeighborsHtml(d.prev, d.next)}
    ${d.comments.html}
  </article>
  ${foot(d.settings, (FOOT_LINKS.article))}
</div>`
}

export function about(d: AboutData): string {
  return page({ ...d, title: '关于我' })
}

export function page(d: PageData): string {
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive })}
  ${masthead(d.settings,  'page')}
  <article class="nw-paper">
    <h1 class="nw-title">${esc(d.title)}</h1>
    <div class="rich">${d.contentHtml}</div>
  </article>
  ${foot(d.settings, (FOOT_LINKS.about))}
</div>`
}

/** 归档页：全部文章按年份分组（资讯站的「过刊」区） */
export function archives(d: ArchivesData): string {
  const s = d.settings
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'archives' })}
  ${masthead(s,  'archives')}
  <h1 class="nw-title nw-page-title">归档</h1>
  <p class="nw-intro">${d.total > 0 ? (`共 ${d.total} 篇 · 按年份倒序`) : '写下的每一篇都会收进这里'}${yearStatsSuffix(d.yearStats)}</p>
  ${heatmapHtml(d.heatmap)}
  <main class="nw-archives">${archiveListHtml(d.groups) || '<p class="nw-empty">Nothing here yet.</p>'}</main>
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 留言板：读者来信区（复用 .cmt-* 结构） */
export function guestbook(d: GuestbookData): string {
  const s = d.settings
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'guestbook' })}
  ${masthead(s,  'guestbook')}
  <h1 class="nw-title nw-page-title">留言板</h1>
  <p class="nw-intro">${d.count > 0 ? (`已有 ${d.count} 条留言 · 随便聊聊`) : '想说点什么，就在这里写下来'}</p>
  <main>${d.html}</main>
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 快讯页：时间轴式快讯墙（本主题的主角） */
export function weibo(d: WeiboData): string {
  const s = d.settings
  const topicBar = weiboTopicBar(d.topics || [], d.topic)
  const composer = d.adminName ? weiboComposer({ adminName: d.adminName }) : ''
  const cards = weiboCards({
    settings: s,
    items: d.items,
    avatarHtml: avatar(s),
    allowComments: d.allowComments,
    adminName: d.adminName,
    memberName: d.memberName,
  })
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'weibo' })}
  ${masthead(s,  'weibo')}
  <h1 class="nw-title nw-page-title">快讯</h1>
  <p class="nw-intro">每日不定期更新的随手快讯。</p>
  ${topicBar}
  ${composer}
  <main class="wb-list nw-flash-flow">
    ${cards || `<p class="nw-empty">${d.adminName ? '还没有快讯——在上面发第一条。' : '还没有快讯。'}</p>`}
  </main>
  ${weiboPager(d.page, d.totalPages, d.topic)}
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 友情链接：媒体报道名录 */
export function links(d: LinksData): string {
  const s = d.settings
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'links' })}
  ${masthead(s,  'links')}
  <h1 class="nw-title nw-page-title">友情链接</h1>
  <main class="fl-grid">
    ${friendLinkCards(d.items) || '<p class="nw-empty">No links yet.</p>'}
  </main>
  ${friendLinkApply()}
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 排行榜页（/rank）：会员积分总榜，榜单行结构共用 .rk-* */
export function rank(d: RankData): string {
  const s = d.settings
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'rank' })}
  ${masthead(s,  'rank')}
  <h1 class="nw-title nw-page-title">排行榜</h1>
  <p class="nw-intro">${d.total > 0 ? (`共 ${d.total} 位会员 · 按积分倒序`) : '还没有会员上榜。'}</p>
  <main class="nw-rank">${rankListHtml(d.entries) || '<p class="nw-empty">还没有会员上榜。</p>'}</main>
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 会员中心页（/member）：未登录出登录/注册表单，已登录出会员卡（结构共用 .mem-*） */
export function member(d: MemberData): string {
  const s = d.settings
  return `<div class="nw-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'nw-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'member' })}
  ${masthead(s,  'member')}
  <h1 class="nw-title nw-page-title">会员中心</h1>
  <p class="nw-intro">${d.member ? ('留言、常回来，积分与专属内容都在这里') : '登录或注册，加入本站会员'}</p>
  <main class="nw-member">${d.member ? memberCardHtml(d.member) : memberAuthHtml( d)}</main>
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

export { id, css }
