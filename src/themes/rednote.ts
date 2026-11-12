import type { SettingsMap } from '../types'
import type { AboutData, ArchivesData, GuestbookData, HomeData, LinksData, MemberData, PageData, PostData, RankData, WeiboData } from './registry'
import {
  archiveListHtml,
  categoryLink,
  esc,
  fmtDate,

  fmtViews,
  footLinks,
  friendLinkApply,
  friendLinkCards,
  homeListBase,
  homeSortBar,
  likesBtn,
  markHtml,
  memberAuthHtml,
  memberCardHtml,
  onThisDayCard,
  pagerHtml,
  paywallHtml,

  yearStatsSuffix,
  footCardHtml,
  newSiteGuideHtml,
  postNeighborsHtml,
  heatmapHtml,
  rankListHtml,
  shareBtn,
  siteMode,
  siteNav,
  tagLink,

  weiboCards,
  weiboComposer,
  weiboHomeEntry,
  weiboHomeFeed,
  weiboSearchResults,
  weiboPager,
  weiboTopicBar,
} from '../render'
import css from './rednote.css'

const id = 'rednote'

/**
 * 站点标志（没设 avatarUrl 时的默认门面）：品牌红圆角方块 + 白色「记」，
 * 致敬小红书红底白字标志的版式；单字用系统中文粗体渲染（PingFang / 雅黑覆盖面足够）。
 * 尺寸由主题 CSS 按场景塑形（刊头 64 / 页头 26 / 作者栏 40 / 微博头像 36）。
 */
const RN_LOGO =
  '<svg class="rn-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#ff2442"/><text x="32" y="45" text-anchor="middle" font-size="34" font-weight="700" fill="#fff" font-family="\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">记</text></svg>'

/** 实心小红心（列表卡片赞数 / 页脚签名句用；按钮里的描边心由 render.ts likesBtn 自带） */
const HEART =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.9-10-9.3C.5 8.4 2.3 4.9 5.7 4.5c2-.2 3.9.8 5 2.5a5.7 5.7 0 0 1 5-2.5c3.4.4 5.2 3.9 3.7 7.2C19.5 16.1 12 21 12 21z" fill="currentColor"/></svg>'

/** 放大镜（搜索框左侧小图标） */
const MAGNIFIER =
  '<svg class="rn-search-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'

/** 页脚公共件：八个页面只差链接组，结构统一在这里；末行红心签名句是主题注脚 */
function foot(s: SettingsMap, links: string): string {
  return `<footer class="rn-footer">
  ${footCardHtml(s)}<div class="rn-footer-row"><span>${esc((s.footerText || ''))}</span><span class="rn-footer-links">${footLinks(s, links)}</span></div>
  <p class="rn-footer-motto">${HEART}标记我的生活</p>
</footer>`
}
const FOOT_LINKS = {
  home: '<a href="/weibo">微博</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>',
  article: '<a href="/weibo">微博</a><a href="/admin">管理</a><a href="/rss.xml">RSS</a>',
  about: '<a href="/">Home</a><a href="/weibo">微博</a><a href="/admin">管理</a>',
}

/** 站点标志：设置过 avatarUrl 用头像，否则用品牌红方块（小红书主题的默认门面） */
function mark(s: SettingsMap): string {
  return s.avatarUrl ? `<img class="rn-avatar" src="${esc(s.avatarUrl)}" alt="${esc(s.siteName)}">` : RN_LOGO
}

/** 关注胶囊：博客语境的「关注」= 订阅 RSS；次级胶囊是去留言板打个招呼 */
function followPill(): string {
  return `<div class="rn-hero-actions"><a class="rn-follow" href="/rss.xml">关注</a><a class="rn-follow rn-follow-ghost" href="/guestbook">打个招呼</a></div>`
}

/** 搜索框：小红书灰胶囊（放大镜 + 红色搜索按钮） */
function searchForm(q: string | undefined): string {
  return `<form class="rn-search" action="/search" method="get" role="search">
  ${MAGNIFIER}
  <input class="rn-search-input" type="search" name="q" value="${esc(q || '')}" placeholder="搜索你感兴趣的" maxlength="60" aria-label="搜索文章">
  <button class="rn-search-btn" type="submit">搜索</button>
</form>`
}

export function home(d: HomeData): string {
  const s = d.settings
  const items = d.posts
    .map((p) => {
      const foot = `<div class="rn-card-foot"><span class="rn-card-likes">${HEART}<b>${fmtViews(p.likes)}</b></span><span class="rn-card-time">${fmtDate(p.published_at)}</span></div>`
      if (p.cover) {
        return `<a class="rn-card" href="/post/${esc(p.slug)}">
  <div class="rn-card-cover"><img src="${esc(p.cover)}" loading="lazy" alt=""></div>
  <div class="rn-card-body"><h2 class="rn-card-title">${markHtml(p.title, d.q)}${p.pinned ? `<span class="rn-pin">置顶</span>` : ''}</h2>${foot}</div>
</a>`
      }
      return `<a class="rn-card" href="/post/${esc(p.slug)}">
  <div class="rn-card-body is-textonly"><h2 class="rn-card-title">${markHtml(p.title, d.q)}${p.pinned ? `<span class="rn-pin">置顶</span>` : ''}</h2><p class="rn-card-abs">${markHtml(p.summary, d.q)}</p>${foot}</div>
</a>`
    })
    .join('\n')
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive })}
  <header class="rn-hero">
    <div class="rn-hero-mark">${mark(s)}</div>
    <h1 class="rn-hero-title">${esc((s.siteName))}</h1>
    <p class="rn-hero-lead">${esc((s.siteDescription))}</p>
    ${followPill()}
    ${d.total > 0 ? `<p class="rn-hero-count">${`共 ${d.total} 篇 · 持续更新`}</p>` : ''}
  </header>
  ${d.notice ? `<div class="rn-notice">${d.notice}</div>` : ''}
  ${d.newSite ? newSiteGuideHtml() : ''}
  ${d.weiboFeed ? weiboHomeFeed({ settings: s, items: d.weiboFeed.items, total: d.weiboFeed.total, avatarHtml: mark(s), allowComments: d.weiboFeed.allowComments, adminName: d.weiboFeed.adminName, memberName: d.weiboFeed.memberName }) : ''}
  ${d.weibo ? weiboHomeEntry({ ...d.weibo }) : ''}
  ${onThisDayCard(d.onThisDay)}
  ${searchForm(d.q)}
  ${homeSortBar({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q })}
  <main class="rn-list">
    ${items || `<p class="rn-empty">${d.emptyText || '这一页还空着，去写下第一篇吧。'}</p>`}
  </main>
  ${pagerHtml({
    page: d.page,
    totalPages: d.totalPages,
    base: homeListBase({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }),
  })}
  ${d.searchWeibo ? weiboSearchResults({ settings: s, items: d.searchWeibo.items, total: d.searchWeibo.total, avatarHtml: mark(s) }) : ''}
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

export function post(d: PostData): string {
  const s = d.settings
  const p = d.post
  const related = d.related.length
    ? `<aside class="rn-related"><h2 class="rn-related-title">相关笔记</h2>${d.related
        .map((r) => `<a href="/post/${esc(r.slug)}">${esc(r.title)}</a>`)
        .join('')}</aside>`
    : ''
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages })}
  <header class="rn-header">
    <a class="rn-logo" href="/">← ${esc((s.siteName))}</a>
  </header>
  <article class="rn-article">
    <div class="rn-author">
      <span class="rn-author-main">${mark(s)}<span class="rn-author-name">${esc((s.siteName))}</span></span>
      <a class="rn-follow" href="/rss.xml">关注</a>
    </div>
    <h1 class="rn-title">${esc(p.title)}</h1>
    <div class="rn-meta"><time>${fmtDate(p.published_at)}</time><i>·</i><span>${`${fmtViews(p.views)} 阅读`}</span>${p.aiGenerated ? `<i>·</i><span>AI 生成</span>` : ''}</div>
    ${p.cover ? `<div class="rn-cover"><img src="${esc(p.cover)}" alt=""></div>` : ''}
    <div class="rich">${p.contentHtml}</div>
    ${p.locked ? paywallHtml(p.minTier,  d) : ''}
    <div class="rn-foot">
      ${likesBtn(p.slug, p.likes)}
      ${d.share ? shareBtn(d.share.url, d.share.qr) : ''}
      <div class="rn-tags">${d.category ? `<a href="${categoryLink(d.category)}">${esc(d.category.name)}</a>` : ''}${p.tags.map((t) => `<a href="${tagLink(t)}">${esc(t)}</a>`).join('')}</div>
    </div>
    ${related}
    ${postNeighborsHtml(d.prev, d.next)}
    ${d.comments.html}
  </article>
  ${foot(s, (FOOT_LINKS.article))}
</div>`
}

export function about(d: AboutData): string {
  return page({ ...d, title: '关于我' })
}

/** 独立页面页（/page/:slug，slug='about' 时渲染 /about）：结构同关于我，标题由页面数据决定 */
export function page(d: PageData): string {
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive })}
  <header class="rn-header"><a class="rn-logo" href="/">← ${esc((d.settings.siteName))}</a></header>
  <article class="rn-article">
    <h1 class="rn-title rn-page-title">${esc(d.title)}</h1>
    <div class="rich">${d.contentHtml}</div>
  </article>
  ${foot(d.settings, (FOOT_LINKS.about))}
</div>`
}

/** 文章归档页：全部文章按年份分组，品牌红年份 + 圆点时间线（白卡面板承载） */
export function archives(d: ArchivesData): string {
  const s = d.settings
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'archives' })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc((s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link is-active" href="/archives">归档</a><a class="rn-nav-link" href="/guestbook">留言板</a><a class="rn-nav-link" href="/about">关于我</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">归档</h1>
  <p class="rn-page-sub">${d.total > 0 ? (`共 ${d.total} 篇 · 按年份倒序`) : '写下的每一篇都会收进这里'}${yearStatsSuffix(d.yearStats)}</p>
  ${heatmapHtml(d.heatmap)}
  <main class="rn-archives">${archiveListHtml(d.groups) || `<p class="rn-empty">还没有内容，去写第一篇吧。</p>`}</main>
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 留言板页：独立留言墙（复用 .cmt-* 结构与样式，白卡面板承载） */
export function guestbook(d: GuestbookData): string {
  const s = d.settings
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'guestbook' })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc((s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link" href="/archives">归档</a><a class="rn-nav-link is-active" href="/guestbook">留言板</a><a class="rn-nav-link" href="/about">关于我</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">留言板</h1>
  <p class="rn-page-sub">${d.count > 0 ? (`已有 ${d.count} 条留言 · 随便聊聊`) : '想说点什么，就在这里写下来'}</p>
  <main class="rn-panel">${d.html}</main>
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 微博页：随手记笔记流 */
export function weibo(d: WeiboData): string {
  const s = d.settings
  const topicBar = weiboTopicBar(d.topics || [], d.topic)
  const composer = d.adminName ? weiboComposer({ adminName: d.adminName }) : ''
  const cards = weiboCards({
    settings: s,
    items: d.items,
    avatarHtml: mark(s),
    allowComments: d.allowComments,
    adminName: d.adminName,
    memberName: d.memberName,
  })
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'weibo' })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc((s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link is-active" href="/weibo">微博</a><a class="rn-nav-link" href="/about">关于我</a></nav>
  </header>
  ${topicBar}
  ${composer}
  <main class="wb-list">
    ${cards || `<p class="rn-empty">${d.adminName ? '这里还空着，在上面发第一条吧。' : '这里还空着，过两天再来看看。'}</p>`}
  </main>
  ${weiboPager(d.page, d.totalPages, d.topic)}
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 友情链接页：名片式白卡 + 申请收录 */
export function links(d: LinksData): string {
  const s = d.settings
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'links' })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc((s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link is-active" href="/links">友链</a><a class="rn-nav-link" href="/about">关于我</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">友情链接</h1>
  <p class="rn-page-sub">值得慢慢读的博客们</p>
  <main class="fl-grid">
    ${friendLinkCards(d.items) || `<p class="rn-empty">还没有友链。</p>`}
  </main>
  ${friendLinkApply()}
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 排行榜页（/rank）：会员积分总榜，榜单行结构共用 .rk-* */
export function rank(d: RankData): string {
  const s = d.settings
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'rank' })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc((s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link is-active" href="/rank">排行榜</a><a class="rn-nav-link" href="/about">关于我</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">排行榜</h1>
  <p class="rn-page-sub">${d.total > 0 ? (`共 ${d.total} 位会员 · 按积分倒序`) : '榜首虚位以待'}</p>
  <main class="rn-rank">${rankListHtml(d.entries) || `<p class="rn-empty">还没有会员上榜。</p>`}</main>
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

/** 会员中心页（/member）：未登录出登录/注册表单，已登录出会员卡（结构共用 .mem-*） */
export function member(d: MemberData): string {
  const s = d.settings
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'member' })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc((s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link" href="/rank">排行榜</a><a class="rn-nav-link" href="/about">关于我</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">会员中心</h1>
  <p class="rn-page-sub">${d.member ? ('留言、常回来，积分与专属内容都在这里') : '登录或注册，加入本站会员'}</p>
  <main class="rn-member">${d.member ? memberCardHtml(d.member) : memberAuthHtml( d)}</main>
  ${foot(s, (FOOT_LINKS.home))}
</div>`
}

export { id, css }
