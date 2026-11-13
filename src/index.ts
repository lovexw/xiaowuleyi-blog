import { Hono, type Context } from 'hono'
import { scheduledBackup } from './backup'
import { runScheduledPublish } from './scheduler'
import { api } from './api'
import { cleanBotPath, identifyBot, purgeBots, recordBot, shouldRecordBot } from './bots'
import { siteClosedResponse } from './closed'
import { clientIp, getCookie, getSessionUser, isSecureRequest, rateLimit } from './auth'
import { ensureSchema, getPostBySlug, getSettings, listCategories, listPages, listPosts, listPublishedTags, listSitemapCategoryLastmod, listSitemapPages, listSitemapPosts, listWeiboLastmod } from './db'
import { buildLlmsFullTxt, buildLlmsStub, buildLlmsTxt } from './llms'
import { goPageHtml, isTrustedOutHost } from './outlink'
import { htmlEtagMiddleware } from './html-etag'
import { imageCacheMatch, imageCachePut, pageCacheMiddleware } from './pagecache'
import { renderAbout, renderArchive, renderCategory, renderGuestbook, renderHome, renderLinks, renderNotFound, renderPage, renderPost, renderSearch, renderWeibo } from './pages'
import { canEverUnlock, gateHashesOf, GATE_COOKIE, GATE_TTL_MS, mergeGateCookie, normalizeAccess, verifyGatePassword, type GateLevel } from './protect'
import { installedManifest, pluginFileKey, readInstalled } from './pluginpkg'
import { buildJsonFeed, buildRss, buildSitemap } from './rss'
import { siteBase } from './render'
import { buildRobotsTxt, contentSignalValue, indexNowKeyOk, readAiPolicy } from './seo'
import { pluginConfig } from './hooks'
import { purgeVisits } from './stats'
import { mimeOfKey, variantBaseKey } from './store'
import { purgeTrash } from './trash'
import { recountWeiboCount, refreshFootStats, refreshOnThisDay } from './db'
import type { Env, SessionUser } from './types'
import { fmtDate, siteVisibleCutoff, weiboVisibleCutoff } from './utils'

const app = new Hono<{ Bindings: Env; Variables: { user: SessionUser | null } }>()

// 外链中间页的 CSP（/go 路由专用）：无脚本需求，比前台更收紧——default-src 'none' 只留内联样式
const CSP_GO = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// 老库缺列自动补齐（幂等），按 db 实例各执行一次。必须是 WeakMap 而不是模块级单例：
// docker-poc 单进程多租户共用同一份模块，单例会让第一个租户之后的全部租户在
// 请求/cron 路径上跳过 ensureSchema（租户库各自需要各自的增量迁移）；
// Workers 形态每 isolate 一个 db 实例，行为不变（2026-11 审计 P3-10）
const schemaReadyByDb = new WeakMap<D1Database, Promise<void>>()
function ensureSchemaOnce(db: D1Database): Promise<void> {
  let p = schemaReadyByDb.get(db)
  if (!p) {
    p = ensureSchema(db).catch((err) => {
      schemaReadyByDb.delete(db)
      throw err
    })
    schemaReadyByDb.set(db, p)
  }
  return p
}
app.use('*', async (c, next) => {
  await ensureSchemaOnce(c.env.DB)
  await next()
})

// 一键闭站（后台「设置 → 站点状态」，逻辑在 src/closed.ts）
app.use('*', async (c, next) => {
  const res = await siteClosedResponse(c.env.DB, c.req.raw, c.req.path)
  if (res) return res
  await next()
})

/* ---------------- 爬虫 / AI 抓取识别（src/bots.ts，统计页新维度） ----------------
 * 爬虫不执行 JS、进不了 visit_log，只能在服务端按 User-Agent 识别后旁路记录。
 * 只拦公开面：/admin、/api、/images 不算「抓内容」；识别不命中（浏览器/未知脚本）
 * 直接放行零开销。记录走 waitUntil 异步写，绝不阻塞响应；写入闸（去抖 + 预算）在
 * shouldRecordBot 内部，防穷举路径刷 D1 写配额——见 bots.ts 文件头注释。 */
const BOT_SKIP_PREFIX = ['/admin', '/api', '/images']
app.use('*', async (c, next) => {
  const ua = c.req.header('User-Agent') || ''
  if (ua) {
    const bot = identifyBot(ua)
    if (bot && !BOT_SKIP_PREFIX.some((p) => c.req.path === p || c.req.path.startsWith(p + '/'))) {
      const qi = c.req.url.indexOf('?')
      const path = cleanBotPath(qi >= 0 ? c.req.path + c.req.url.slice(qi) : c.req.path)
      if (path && shouldRecordBot(bot.name, path)) {
        const country = (c.req.header('CF-IPCountry') || '').slice(0, 8)
        c.executionCtx.waitUntil(
          recordBot(c.env.DB, { name: bot.name, kind: bot.kind, path, country }).catch(() => {})
        )
      }
    }
  }
  await next()
})

/* ---------------- HTML 条件请求（ETag / 304，src/html-etag.ts） ----------------
 * 公开页响应恒带 Cache-Control: no-cache，浏览器每次刷新都回来验证；此前没有 ETag，
 * 每次验证都拿回一份完整 200（HTML 20–60KB，跨境链路上白付一个 RTT 的传输）。
 * 现在按内容生成强 ETag，命中 If-None-Match 回 304（零 body）；CF 边缘副本带同一 ETag，
 * 命中边缘时由 CF 直接回 304、不必回源。
 * 注册位必须在 pageCacheMiddleware 之前：洋葱模型下先注册者的后半段最后执行，
 * 边缘缓存命中的响应也会经过这里，直接复用副本上的 ETag，不重复算哈希。 */
app.use('*', htmlEtagMiddleware())

/* ---------------- 页面边缘缓存（src/pagecache.ts）：公开页 / 订阅源 / 公开只读 API · 匿名访客 · 30 分钟副本 ----------------
 * 命中直接吐响应跳过 SSR/API 与 D1。登录 Cookie / 灰度一律不进缓存；带 query 走受控
 * 白名单（page/limit/wb/topic/q/sort/tag 镜像服务端 clamp 语义进键，未知参数 / sort=random 回源）。
 * 注册位必须在所有页面路由与 /api 子应用之前（终点 handler 不调 next），且在闭站 /
 * 爬虫统计之后；设置变更 saveSettings 自动换代作废，后台「概览 → 系统」可一键清理 */
app.use('*', pageCacheMiddleware())

app.route('/api', api)

/* ---------------- 公开页面（SSR + 主题渲染） ---------------- */
/** 公开页 handler 的统一签名：RSS / sitemap 这类需要复用同一份上下文类型 */
type PublicHandler = (c: Context<{ Bindings: Env; Variables: { user: SessionUser | null } }>) => Promise<Response>
// WordPress 风格订阅盲猜（/?feed=rss2 / rss / atom 等）：统一 302 到规范订阅地址
// （须注册在 renderHome 之前——终点 handler 不调 next，后注册的中间件不会再被执行）
app.get('/', async (c, next) => {
  if (c.req.query('feed')) return c.redirect('/rss.xml')
  await next()
})
app.get('/', renderHome)
app.get('/tag/:tag', renderHome)
app.get('/category/:slug', renderCategory)
app.get('/post/:slug', renderPost)
app.get('/page/:slug', renderPage)
app.get('/about', renderAbout)
app.get('/archives', renderArchive)
app.get('/guestbook', renderGuestbook)
app.get('/weibo', (c) => renderWeibo(c))
app.get('/links', renderLinks)
app.get('/search', renderSearch)

// 随机来一篇：从已发布文章里随机挑一篇跳过去（加密文章不进随机池——落上去就是一堵密码墙）
app.get('/random', async (c) => {
  // 站点可见窗口：随机入口同样只在窗口内抽（抽到窗口外文章 = 直链 404 死链）
  const settings = await getSettings(c.env.DB)
  const cutoff = siteVisibleCutoff(settings)
  const vis = cutoff ? 'AND COALESCE(published_at, created_at) >= ?' : ''
  const row = await c.env.DB.prepare(
    `SELECT slug FROM posts WHERE status = 'published' AND deleted_at IS NULL ${vis} AND min_tier = 'all' ORDER BY RANDOM() LIMIT 1`
  )
    .bind(...(cutoff ? [cutoff] : []))
    .first<{
      slug: string
    }>()
  if (!row) return renderNotFound(c)
  return c.redirect(`/post/${encodeURIComponent(row.slug)}`)
})

/* ---------------- 外链中间页（/go?u=<url>，机制在 src/outlink.ts） ----------------
 * 白名单域名（TRUSTED_OUT_DOMAINS）与同源链接 302 直跳不经过确认；其余第三方地址渲染
 * 「即将离开本站」提醒页（免责声明 + 访客自行决定），绝不自动跳转——不构成开放重定向。
 * 目标必须 http(s) 且 ≤2048 字符，缺失/非法一律回首页；正文外链在渲染层包装进来
 * （sanitize opts / weiboTextHtml），直接访问 /go 只是兜底入口 */
app.get('/go', async (c) => {
  const raw = (c.req.query('u') || '').trim()
  let target: URL | null = null
  try {
    target = raw ? new URL(raw) : null
  } catch {
    target = null
  }
  if (target && (target.protocol === 'http:' || target.protocol === 'https:') && target.href.length <= 2048) {
    if (target.origin === new URL(c.req.url).origin || isTrustedOutHost(target.hostname)) {
      return c.redirect(target.href)
    }
    const settings = await getSettings(c.env.DB)
    c.header('Content-Security-Policy', CSP_GO)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cache-Control', 'no-store')
    return c.html(goPageHtml(target, settings.siteName || 'BlogHao'))
  }
  return c.redirect('/')
})

/* ---------------- 文章解锁（表单 POST + 303 回跳，无 JS 依赖；表单由 src/protect.ts 渲染） ----------------
 * 两档站级口令：member 档只认会员密码；fixed 档先试固定密码、再试会员密码（高档覆盖低档）。
 * 成功：签 `level.exp.hmac` 解锁 Cookie（key = 该档 password hash，改密即全端失效）后 303 回文章页；
 * 失败：303 带 ?pwerr= 回文章页由表单展示错误；目标不存在/无需口令一律静默回跳，不透露存在性。
 * 限流按 IP 而不是按文章：口令是全站共享的，按文章分开计等于给爆破者换一篇就是新额度 */
app.post('/post/:slug/unlock', async (c) => {
  // 与 api.ts 同源校验同口径：浏览器跨站表单 POST 必带 Origin，不一致直接拒绝（防 CSRF）
  const origin = c.req.header('Origin')
  if (origin && origin !== new URL(c.req.url).origin) return c.text('跨站请求被拒绝', 403)
  const slug = (c.req.param('slug') || '').slice(0, 100)
  const back = `/post/${encodeURIComponent(slug)}`
  const row = await getPostBySlug(c.env.DB, slug)
  const access = normalizeAccess(row?.min_tier)
  if (!row || row.status !== 'published' || access === 'all') return c.redirect(back, 303)
  const settings = await getSettings(c.env.DB)
  const hashes = gateHashesOf(settings)
  if (!canEverUnlock(access, hashes)) return c.redirect(`${back}?pwerr=unset`, 303)
  // PBKDF2 是慢操作，10 次 / 10 分钟（与登录同量级）
  if (!rateLimit(c.env, `gate:${clientIp(c.req.raw)}`, 10, 10 * 60_000)) {
    return c.redirect(`${back}?pwerr=slow`, 303)
  }
  const body = await c.req.parseBody().catch(() => null)
  const password = body && typeof body === 'object' ? String((body as Record<string, unknown>)['password'] ?? '').slice(0, 64) : ''
  const tries: GateLevel[] = access === 'member' ? ['member'] : (['fixed', 'member'] as const).filter((lv) => !!hashes[lv])
  let level: GateLevel | null = null
  for (const lv of tries) {
    if (await verifyGatePassword(hashes[lv], password)) {
      level = lv
      break
    }
  }
  if (!level) return c.redirect(`${back}?pwerr=1`, 303)
  const token = await mergeGateCookie(getCookie(c.req.raw, GATE_COOKIE), level, hashes, Date.now())
  c.header('Set-Cookie', `${GATE_COOKIE}=${token}; Path=/; HttpOnly;${isSecureRequest(c.req.raw) ? ' Secure;' : ''} SameSite=Lax; Max-Age=${GATE_TTL_MS / 1000}`)
  return c.redirect(back, 303)
})

/* ---------------- RSS 订阅（规范地址 /rss.xml，别名路径盲猜兜底） ----------------
 * 主题页脚 / head rel=alternate / sitemap 只展示规范地址；别名是纯服务端路由，不出现在任何
 * 前端出口。内容同 buildRss 一份输出——阅读器按内容嗅探格式，atom.xml 等文件名不影响解析，
 * atom:link rel=self 恒指规范地址（顺带把订阅器引回 /rss.xml）。闭站中间件对别名同样 503 */
const RSS_ALIASES = [
  '/rss',
  '/rss/',
  '/feed',
  '/feed/',
  '/feed.xml',
  '/feed/rss.xml',
  '/feed/rss',
  '/atom',
  '/atom/',
  '/atom.xml',
  '/index.xml',
  '/feeds/posts/default', // Blogger 惯例路径
]
const rssHandler: PublicHandler = async (c) => {
  const settings = await getSettings(c.env.DB)
  // 站点可见窗口：窗口外文章不进订阅源（比会员锁文的「试读段」更彻底——直接不出现）
  const { items } = await listPosts(c.env.DB, { status: 'published', limit: 50, afterTs: siteVisibleCutoff(settings) })
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  c.header('Content-Type', 'application/rss+xml; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  setSignalHeader(c, settings)
  return c.body(buildRss(settings, items, siteUrl))
}
app.get('/rss.xml', rssHandler)
for (const p of RSS_ALIASES) app.get(p, rssHandler)

// JSON Feed 1.1（C12，buildJsonFeed 与 RSS 同一份防泄漏口径）：只有规范地址不设别名，
// 闭站中间件同样覆盖（订阅面随闭站 503）
const jsonFeedHandler: PublicHandler = async (c) => {
  const settings = await getSettings(c.env.DB)
  // 站点可见窗口：与 RSS 同一份口径（buildJsonFeed 防泄漏清单）
  const { items } = await listPosts(c.env.DB, { status: 'published', limit: 50, afterTs: siteVisibleCutoff(settings) })
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  c.header('Content-Type', 'application/json; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  setSignalHeader(c, settings)
  return c.body(buildJsonFeed(settings, items, siteUrl))
}
app.get('/feed.json', jsonFeedHandler)

/** Content-Signal 响应头（robots.txt 同款声明的 HTTP 头形态，部分抓取器只看头）：
 *  订阅源 / sitemap / llms 这些机器可读面与 HTML 页面（pages.ts baseHeaders）同一口径 */
function setSignalHeader(c: Context<{ Bindings: Env; Variables: { user: SessionUser | null } }>, settings: Awaited<ReturnType<typeof getSettings>>): void {
  const signal = contentSignalValue(readAiPolicy(settings.aiPolicy))
  if (signal) c.header('Content-Signal', signal)
}

app.get('/sitemap.xml', async (c) => {
  const settings = await getSettings(c.env.DB)
  const [posts, categories, catLastmod, pages, wbLastmod] = await Promise.all([
    listSitemapPosts(c.env.DB, siteVisibleCutoff(settings)),
    listCategories(c.env.DB),
    listSitemapCategoryLastmod(c.env.DB),
    listSitemapPages(c.env.DB),
    // 微博窗口只管微博：/weibo 条目的 lastmod 同样按游客口径收口（文章窗口与微博窗口已分列）
    listWeiboLastmod(c.env.DB, weiboVisibleCutoff(settings)),
  ])
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  const lastmodBySlug = new Map(catLastmod.map((r) => [r.slug, r.lastmod]))
  c.header('Content-Type', 'application/xml; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  setSignalHeader(c, settings)
  return c.body(
    buildSitemap(
      settings,
      posts,
      siteUrl,
      categories.map((cat) => {
        const ts = lastmodBySlug.get(cat.slug) || 0
        return { ...cat, lastmod: ts ? fmtDate(ts) : '' }
      }),
      pages,
      wbLastmod || undefined
    )
  )
})

/** robots.txt（B20）：内置段 + 后台「设置 → 站点」的 robots 追加段（src/seo.ts buildRobotsTxt） */
app.get('/robots.txt', async (c) => {
  const settings = await getSettings(c.env.DB)
  // Sitemap 行必须走 siteBase（settings.siteUrl 优先）：sitemap 本体 / RSS / canonical /
  // llms 全站绝对 URL 都以 siteUrl 为准，robots 跟请求 Host 会在别名域名 / 错误 Host /
  // 反代漏传 XFP（scheme 降级）时把爬虫引去错误主机（2026-11 审计 P1-4）
  return c.text(buildRobotsTxt(settings, siteBase(settings, new URL(c.req.url).origin)))
})

/* ---------------- AI 索引导读（llms.txt / llms-full.txt，B28）----------------
 * 新兴 AI 抓取导读约定（llmstxt.org；Cloudflare 阻止响应的内置放行路径）。文章清单走 listPosts
 * 的同一份公开口径（status=published + 站点可见窗口 + 软删过滤），防泄漏清单在 src/llms.ts 头注；
 * siteNoindex / AI 策略 deny 档出桩（与 robots.txt 整站 Disallow 同口径）；两路径已进
 * pagecache 数据白名单 */
const llmsHandler = (full: boolean): PublicHandler => async (c) => {
  const settings = await getSettings(c.env.DB)
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  setSignalHeader(c, settings)
  // AI 策略 deny 档：llms 面本就是给 AI 看的导读，robots 全拒时整体关闭（桩文案指向策略）。
  // siteNoindex 的真实站单独出「不收录」文案（2026-11 审计 P2-14）
  const aiDenied = readAiPolicy(settings.aiPolicy) === 'deny'
  const noindex = settings.siteNoindex === '1'
  if (noindex || aiDenied) return c.body(buildLlmsStub(settings, siteUrl, aiDenied, noindex))
  const [feed, pages, tags] = await Promise.all([
    listPosts(c.env.DB, { status: 'published', limit: full ? 50 : 100, afterTs: siteVisibleCutoff(settings) }),
    listPages(c.env.DB, { status: 'published' }),
    // 「关于本站」节的主要话题：已发布文章的标签聚合（真实内容推导），取前 8 个
    listPublishedTags(c.env.DB),
  ])
  const topics = tags.slice(0, 8).map((t) => t.name)
  return c.body(
    full
      ? buildLlmsFullTxt(settings, feed.items, siteUrl, topics)
      : buildLlmsTxt(settings, feed.items, pages.map((p) => ({ slug: p.slug, title: p.title })), siteUrl, topics)
  )
}
app.get('/llms.txt', llmsHandler(false))
app.get('/llms-full.txt', llmsHandler(true))

/* ---------------- IndexNow 密钥文件（hooks.ts indexnow 插件的站点归属验证路） ----------------
 * IndexNow 协议：提交时带 keyLocation，引擎回访这个地址比对密钥。密钥存插件配置
 * （serverPluginConfig.indexnow.key），未配置 / 形态不对一律 404 不透露任何信息；
 * 本文件是公开值（验证机制本来就要求公开），短缓存兼顾「换密钥后尽快生效」 */
app.get('/indexnow-key.txt', async (c) => {
  const settings = await getSettings(c.env.DB)
  const key = (pluginConfig(settings, 'indexnow').key || '').trim()
  if (!indexNowKeyOk(key)) return c.text('Not found', 404)
  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.body(key)
})

/* ---------------- 编辑器远程插件下发（B8 插件半边，安装端点在 api.ts） ----------------
 * /plugins/installed.json 与 /plugin-files/:id 都要求管理员会话（编辑器带着 Cookie 加载），
 * 未登录 / 未安装一律 404 不透露存在性；静态资源由 wrangler assets 先行，这里只接动态面。
 * 注意：/plugins/manifest.json 仍是 assets 静态文件，与本路由无关。 */
app.get('/plugins/installed.json', async (c) => {
  const user = await getSessionUser(c.env.DB, c.req.raw)
  if (!user) return c.text('Not found', 404)
  const list = readInstalled((await getSettings(c.env.DB)).pluginsInstalled)
  return c.json(installedManifest(list))
})

app.get('/plugin-files/:id', async (c) => {
  const user = await getSessionUser(c.env.DB, c.req.raw)
  if (!user) return c.text('Not found', 404)
  const id = c.req.param('id')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.text('Not found', 404)
  const list = readInstalled((await getSettings(c.env.DB)).pluginsInstalled)
  if (!list.some((p) => p.id === id)) return c.text('Not found', 404)
  const obj = await c.env.IMAGES.get(pluginFileKey(id))
  if (!obj) return c.text('Not found', 404)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Cache-Control', 'no-store')
  return c.body(obj.body, 200, { 'Content-Type': 'application/javascript; charset=utf-8' })
})

/* ---------------- R2 图床 ---------------- */
app.get('/images/*', async (c) => {
  const raw = c.req.path.slice('/images/'.length)
  let key = raw
  try {
    key = decodeURIComponent(raw)
  } catch {
    /* 保持原样 */
  }
  // 穿越样式的 key 前置 404（2026-11 审计 P3-14）：r2disk 的 safeJoin 对 `..`/`\`/`\0`
  // 抛异常，穿透到 shim 会变成 500 + 错误日志噪音（R2 形态本来就是 404）；穿越本身
  // 打不穿（safeJoin 双重校验），这里只对齐行为、消掉噪音
  if (key.includes('..') || key.includes('\\') || key.includes('\0')) return c.text('Not found', 404)
  if (!key.startsWith('u/') && !key.startsWith('og/')) return c.text('Not found', 404)
  // 图床边缘缓存（src/pagecache.ts imageCacheMatch）：键内容寻址（saveUpload 时间戳+随机数，
  // 同键永不覆盖），colo 副本命中直接返回，省一次 Worker→R2 的跨境回源；404 不缓存，
  // If-None-Match 复验也先在边缘层做
  const hit = await imageCacheMatch(c.req.raw)
  if (hit) return hit
  let obj = await c.env.IMAGES.get(key)
  let fellBack = false
  if (!obj) {
    // 响应式变体（`<原图 key>@480.webp`）是宿主机预生成的静态文件。定时器还没跑到、
    // 或者存量图从没生成过时，这里回退取原图——宁可多传几 KB，也不能让页面出现裂图。
    // key 换成原图键：下面的 mime 兜底要按**真实字节**的扩展名补，不能按 @480.webp 判成 webp
    const base = variantBaseKey(key)
    if (base) {
      obj = await c.env.IMAGES.get(base)
      if (obj) {
        key = base
        fellBack = true
      }
    }
  }
  if (!obj) return c.text('Not found', 404)
  // 缓存指令尊重 R2 对象自带的 httpMetadata.cacheControl（favicon 等「同键可覆盖」目录
  // 写的是短 TTL，刷新才能收敛）；没写才兜底内容寻址媒体的 1y immutable。
  // 回退到原图时必须给短 TTL：变体 URL 若被 immutable 钉住，等定时器补出真变体后
  // 浏览器和边缘一年都不会再取——图不会裂，但永远优化不到
  const cacheControl = fellBack
    ? 'public, max-age=300'
    : obj.httpMetadata?.cacheControl || 'public, max-age=31536000, immutable'
  if (obj.httpEtag && c.req.header('If-None-Match') === obj.httpEtag) {
    return new Response(null, {
      status: 304,
      // 304 也要带缓存指令：浏览器拿 304 续用本地副本时需要知道 TTL
      headers: { ETag: obj.httpEtag, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' },
    })
  }
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  // 存量对象丢了 contentType（迁移/导入进 R2）时按扩展名补，别退化成 octet-stream：
  // 退化的图微信抓不到 og:image，也进不了 isImageStorable 的边缘缓存。SVG 等不在表里，仍走兜底
  const storedType = headers.get('Content-Type') || ''
  if (!storedType || storedType === 'application/octet-stream') {
    headers.set('Content-Type', mimeOfKey(key) || storedType || 'application/octet-stream')
  }
  headers.set('ETag', obj.httpEtag)
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', cacheControl)
  // 禁止浏览器嗅探内容类型：图床里只允许真正的图片被当图片渲染
  headers.set('X-Content-Type-Options', 'nosniff')
  const res = new Response(obj.body, { headers })
  // 回退响应不进边缘图片缓存：它是「变体还没生成」的临时态，缓存下来会顶掉后续的真变体
  if (!fellBack) imageCachePut(c.req.raw, res, c.executionCtx)
  return res
})

/* ---------------- 后台入口 ---------------- */
app.get('/admin', (c) => c.redirect('/admin/'))

/* ---------------- 404 / 500 ---------------- */
app.notFound((c) => renderNotFound(c))

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  // /api 一律回 JSON：前端 postJSON 直接 r.json()，纯文本会让它抛
  // 「Unexpected token '服'…」这种完全看不懂的解析错误（真实踩过：上传目录 EACCES）。
  // 页面路径仍回纯文本——那时浏览器显示什么都比一段 JSON 强
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json({ error: '服务器开小差了，请稍后再试' }, 500)
  }
  return c.text('服务开小差了，请稍后再试。', 500)
})

// fetch：站点与 API；scheduled：Cron Trigger——先扫定时发布（每分钟），
// 每晚备份时间点顺带跑备份（见 wrangler.jsonc triggers.crons）
export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // 备份 cron 是 "30 16 * * *"（北京时间 00:30）；其余每分钟触发只做定时发布扫描。
    // cron 可能落在从未处理过请求的 isolate：先补齐 schema，否则冷启动库上
    // 定时发布/备份会因缺列缺表而报错。
    const isBackupCron = controller.cron === '30 16 * * *'
    return ctx.waitUntil(
      (async () => {
        try {
          await ensureSchemaOnce(env.DB)
        } catch (e) {
          // 迁移失败不阻塞 cron：后续查询自会报错并走各自的兜底提醒
          console.error('ensureSchema (cron) failed:', e)
        }
        await runScheduledPublish(env)
        if (isBackupCron) {
          await scheduledBackup(controller, env)
          // 访客日志滚动清理：visit_log 是日志类数据不进备份，只在这里按保留期删
          await purgeVisits(env.DB).catch((e) => console.error('purgeVisits failed:', e))
          // 爬虫日志滚动清理：bot_log 同为日志类数据不进备份（src/bots.ts）
          await purgeBots(env.DB).catch((e) => console.error('purgeBots failed:', e))
          // 回收站滚动清理：到期（30 天）的软删行彻底删除并级联评论（src/trash.ts）
          await purgeTrash(env.DB).catch((e) => console.error('purgeTrash failed:', e))
          // 页脚「站点足迹」统计夜更（db.ts refreshFootStats，页脚名片读 settings.siteFoot）
          await refreshFootStats(env.DB).catch((e) => console.error('refreshFootStats failed:', e))
          // 派生记账位夜更校准（2026-10-18 读放大治理）：wbPubCount 对增量计数做全量校准防漂移；
          // onThisDay 顺带重算，覆盖当天对往年内容的编辑（首页渲染平时只读快照不查询）
          await recountWeiboCount(env.DB).catch((e) => console.error('recountWeiboCount failed:', e))
          await refreshOnThisDay(env.DB).catch((e) => console.error('refreshOnThisDay failed:', e))
        }
      })()
    )
  },
}
