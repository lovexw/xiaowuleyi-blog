/* ===== AI 索引导读（llms.txt / llms-full.txt，B28，2026-10-17）=====
 * llms.txt 是新兴的 AI 抓取导读约定（llmstxt.org，Cloudflare 阻止响应的内置放行路径）：
 * H1 站名 + blockquote 描述 + 分节链接清单；llms-full.txt 在同一结构下附全文。
 * 本模块是纯函数组（tests/llms.test.ts 直接导入，不依赖 Workers 运行时），路由在 index.ts。
 *
 * 防泄漏（与 RSS 同一份口径，AGENTS「文章访问口令」防泄漏清单）：
 *  - 传入的文章清单已由调用方过滤（listPosts status=published + 站点可见窗口 + deleted_at IS NULL）；
 *  - 需要口令的文章（min_tier ≠ all，含 fixed 与 member 两档）：索引照常出现（标题/摘要属作者主动
 *    公开的导读面，与 RSS 出条目同口径），llms-full 只出作者摘要 + 口令说明，正文一个字都不出；
 *    其 /post/:slug.md 直接 404（与关键词搜索「整体退出」同口径——pages.ts renderPostMarkdown）；
 *  - 全站 noindex（settings.siteNoindex）/ AI 策略 deny 档（readAiPolicy）：index.ts 出桩
 *    （只有站名与说明，不列内容），与 robots.txt 整站 Disallow 同口径；deny 档时 .md 镜像同样
 *    404、文章页 head 不再声明 alternate——AI 面随策略整体关闭，别只关 llms 留 .md。
 */
import type { PostRow, SettingsMap } from './types'
import { fmtDate } from './utils'
import { htmlToMd } from './html-md'
import { sanitizeHtml } from './sanitize'

/** 独立页面（llms.txt「独立页面」节）：slug/title 由调用方从 listPages 已发布行映射 */
export interface LlmsPage {
  slug: string
  title: string
}

/** 标题/摘要单行化：llms.txt 的条目是行语义，内容里内嵌换行会断掉链接结构 */
function oneLine(s: string): string {
  return String(s ?? '').replace(/\s*\n+\s*/g, ' ').trim()
}

function postUrl(siteUrl: string, p: { slug: string }): string {
  return `${siteUrl}/post/${encodeURIComponent(p.slug)}`
}

/** 分节拼装：空节整节省略（无页面的站不出「独立页面」空标题） */
function sections(parts: [string, string][]): string {
  return parts
    .filter(([, body]) => body.trim())
    .map(([head, body]) => `\n${head}\n\n${body.trim()}\n`)
    .join('')
}

/** 共同的头（H1 + blockquote 描述）、关于本站节与机器可读清单尾节。
 *  「关于本站」给 AI 引用时提供出处背景（这是谁的站、在写什么）——topics 来自调用方的
 *  文章标签聚合（真实内容推导，无需站长另行配置），空标签时整行省略 */
function frame(settings: SettingsMap, siteUrl: string, middle: string, topics: string[] = []): string {
  const head = `# ${oneLine((settings.siteName))}\n\n> ${oneLine((settings.siteDescription))}\n`
  const aboutParts = [`- [关于我（作者介绍）](${siteUrl}/about)`]
  if (topics.length) aboutParts.push((`- 主要话题：${topics.join('、')}`))
  const about = sections([['## 关于本站', aboutParts.join('\n')]])
  const tools = sections([
    [
      '## 订阅与机器可读面',
      [
        `- [RSS](${siteUrl}/rss.xml)`,
        `- [JSON Feed](${siteUrl}/feed.json)`,
        `- [Sitemap](${siteUrl}/sitemap.xml)`,
        `- [Posts API](${siteUrl}/api/public/posts)`,
        `- [llms-full](${siteUrl}/llms-full.txt)`,
      ].join('\n'),
    ],
  ])
  const mdNote = '每篇文章另有 Markdown 镜像：在文章地址后加 `.md`（例如 `' + siteUrl + '/post/example.md`）。'
  return `${head}\n${middle}${about}${tools}\n${mdNote}\n`
}

/** /llms.txt —— 导读索引：最新文章（标题 + 链接 + 一句话摘要）与独立页面。
 *  slug='about' 的页面不再进「独立页面」节（「关于本站」节已带专属链接，避免同链重复） */
export function buildLlmsTxt(settings: SettingsMap, posts: PostRow[], pages: LlmsPage[], siteUrl: string, topics: string[] = []): string {
  const postLines = posts.map((p) => {
    const s = oneLine(p.summary)
    return `- [${oneLine(p.title)}](${postUrl(siteUrl, p)})${s ? `: ${s}` : ''}`
  })
  const pageLines = pages
    .filter((pg) => pg.slug !== 'about')
    .map((pg) => {
      const url = `${siteUrl}/page/${encodeURIComponent(pg.slug)}`
      return `- [${oneLine(pg.title)}](${url})`
    })
  const middle = sections([
    ['## 最新文章', postLines.join('\n')],
    ['## 独立页面', pageLines.join('\n')],
  ])
  return frame(settings, siteUrl, middle, topics)
}

/** /llms-full.txt —— 同一结构附全文：普通文出正文（库存净化 HTML 经 sanitizeHtml → htmlToMd 转
 *  Markdown，与导出 Markdown 包同款转换器——别按「库存即 Markdown」原样输出，标签会直接透出）；
 *  需要口令的文章只出摘要（防泄漏） */
export function buildLlmsFullTxt(settings: SettingsMap, posts: PostRow[], siteUrl: string, topics: string[] = []): string {
  const items = posts.map((p) => {
    const locked = (p.min_tier || 'all') !== 'all'
    let body: string
    if (locked) {
      body = (p.summary ? oneLine(p.summary) + '\n\n' : '') + (`> 本文需要访问密码，正文不对外提供：${postUrl(siteUrl, p)}`)
    } else {
      body = htmlToMd(sanitizeHtml(String(p.content ?? ''))).trim()
    }
    const date = p.published_at || p.updated_at
    return `## [${oneLine(p.title)}](${postUrl(siteUrl, p)})\n\n${date ? ('发布：') + fmtDate(date) + '\n\n' : ''}${body}\n\n---`
  })
  const middle = sections([['## 文章全文', items.join('\n\n')]])
  return frame(settings, siteUrl, middle, topics)
}

/** 全站 noindex / AI 策略 deny 档的桩输出：与 robots.txt 整站 Disallow 同口径，不列任何内容。
 * 两种桩因文案各异（2026-11 审计 P2-14）：aiDenied=策略拒绝；noindex=站长声明不收录的真实站；
 * 都不传 = 通用「暂不提供」文案 */
export function buildLlmsStub(settings: SettingsMap, siteUrl: string, aiDenied = false, noindex = false): string {
  const reason = aiDenied
    ? '本站已声明不允许 AI 抓取（见 robots.txt），此处不提供内容。'
    : noindex
      ? '本站已声明不希望被收录（见 robots.txt），此处不提供内容。'
      : '本站暂不向 AI 爬虫提供内容。'
  return `# ${oneLine((settings.siteName))}\n\n> ${reason}\n`
}
