/**
 * FTS5 全文搜索（ROADMAP B4，2026-10-07 落地）。
 *
 * posts_fts / weibo_fts 两张 trigram 分词虚表（external content 挂 posts / weibo 原表，
 * 增量同步靠 db.ts ensureSchema 挂的 AFTER INSERT/DELETE/UPDATE 触发器），替换 /search
 * 页对 title/summary/content 的 LIKE 全表扫描；微博正文顺势纳入搜索（此前搜不到）。
 *
 * 三条铁律（改这里先跑 tests/fts.test.ts）：
 * 1. trigram 至少要 3 个字符才能成窗（2 字中文词「博客」凑不出一个三元组）——任一分词
 *    短于 3 字符就整体退回 listPosts 的 LIKE 老路，保住 2 字词的既有行为，两套结果口径一致；
 * 2. 加密文章整体退出关键词搜索（与 listPosts q 分支同口径）：FTS 命中本身会泄露
 *    「正文含此词」，可被用来探测加密内容；回收站 / 草稿 / 定时文同样不得出现在公开搜索里；
 * 3. MATCH 表达式只由本模块构造：用户输入按空白切词后逐词加双引号（内部 " 翻倍），
 *    FTS5 查询语法（AND/OR/NOT/NEAR/列过滤）永远到不了引擎，防注入面收敛在这一处。
 *
 * 老库升级：FTS 虚表建出来时倒排索引是空的（external content 不含词条），ensureSchema
 * 用 settings 记账位 ftsSeeded 保证「建表后重建一次全量索引」只跑一回；demo 重置走
 * DELETE/INSERT 会触发同款触发器，索引天然跟着长。
 */

import { listPosts } from './db'
import type { ListPostsResult } from './db'
import { likePattern } from './utils'
import type { PostRow, WeiboRow } from './types'

/** 用户关键词 → FTS5 MATCH 表达式；null = 用不上索引（含短词），调用方退回 LIKE。
 *  按空白切词、词间 AND（与「整句连续子串」的旧 LIKE 语义略有放宽：多词只要求都出现），
 *  逐词双引号包裹成短语（trigram 下等价于连续子串匹配），内部双引号翻倍转义。 */
export function ftsMatchExpr(q: string): string | null {
  const terms = q.split(/\s+/).map((t) => t.trim()).filter(Boolean)
  if (!terms.length) return null
  // [...t] 按码点数（trigram 按字符成窗，emoji 这类代理对要算 1 个字符而不是 2 个 UTF-16 单元）
  if (terms.some((t) => [...t].length < 3)) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')
}

/** /search 页文章搜索的可选参数。分页与排序都在这里收口：
 *  - `page` / `perPage`：与首页列表同一套语义（perPage 上限 50，越界页码回落到最后一页）
 *  - `sort`：`relevance`（bm25，默认）或 `time`（发布时间倒序）。**LIKE 兜底路径恒为时间序**
 *    ——LIKE 没有相关度可排，硬拗一个假的「相关度」只会误导。
 *  - `afterTs`：站点可见窗口下界，窗口外文章不参与搜索（命中本身即泄露） */
export interface PostSearchOpts {
  page?: number
  perPage?: number
  sort?: 'relevance' | 'time'
  afterTs?: number
}

/** /search 页文章搜索：FTS 命中按 bm25 相关度排序（好匹配在前），短词或 FTS 异常退回
 *  listPosts 的 LIKE 路径（时间序）——调用方拿到的都是同构 ListPostsResult，无感切换。
 *  加密文 / 回收站 / 非公开状态在 FTS 查询层直接排除（防线 2），locked 文章照常参与搜索、
 *  由渲染层的摘要口径兜底（与旧搜索同口径）。 */
export async function searchPosts(db: D1Database, q: string, opts: PostSearchOpts = {}): Promise<ListPostsResult> {
  const perPage = Math.min(50, Math.max(1, Math.floor(opts.perPage || 10)))
  const wantPage = Math.max(1, Math.floor(opts.page || 1))
  const sort = opts.sort === 'time' ? 'time' : 'relevance'
  const afterTs = opts.afterTs || 0
  const expr = ftsMatchExpr(q)
  /** LIKE 兜底：短词（trigram 成不了窗）或 FTS 虚表缺失时走这里。
   *  页码也要夹回最后一页——listPosts 只管「page ≥ 1」，不管是否越过 totalPages，
   *  否则手输 ?page=99 在 2 字短词下会吐一个「空列表 + 99 / 3 页」的破页 */
  const likePath = async (): Promise<ListPostsResult> => {
    const r = await listPosts(db, { status: 'published', q, page: wantPage, limit: perPage, afterTs })
    if (r.total > 0 && r.page > r.totalPages) {
      return listPosts(db, { status: 'published', q, page: r.totalPages, limit: perPage, afterTs })
    }
    return r
  }
  if (!expr) return likePath()
  // 与 listPosts q 分支同口径的过滤条件（防线 2）；matches 必须回连原表过这些业务过滤；
  // 站点可见窗口（afterTs）同 listPosts 口径——窗口外文章不参与搜索，防「命中本身即泄露」
  const vis = afterTs > 0 ? 'AND COALESCE(p.published_at, p.created_at) >= ?' : ''
  const where =
    `posts_fts MATCH ? AND p.deleted_at IS NULL AND p.status = 'published' AND (p.password_hash IS NULL OR p.password_hash = '') ${vis}`
  const binds = (args: unknown[]) => (afterTs > 0 ? [...args, afterTs] : args)
  try {
    // 先拿总数再取页：页码越界（手输 ?page=99）时回落到最后一页，别吐一个空列表配一个越界的页码器
    const countRes = await db
      .prepare(`SELECT COUNT(*) AS n FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid WHERE ${where}`)
      .bind(...binds([expr]))
      .first<{ n: number }>()
    const total = countRes?.n ?? 0
    const totalPages = Math.max(1, Math.ceil(total / perPage))
    const page = Math.min(wantPage, totalPages)
    if (!total) return { items: [], total: 0, page: 1, totalPages: 1 }
    // bm25() 越小越相关（FTS5 的约定），升序即「最相关在前」；时间序另按发布时间倒序，
    // 同刻并列用 id 兜底，避免同秒内两条结果的顺序随查询计划漂移
    const order = sort === 'time' ? 'COALESCE(p.published_at, p.created_at) DESC, p.id DESC' : 'bm25(posts_fts)'
    const itemsRes = await db
      .prepare(
        `SELECT p.* FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
      )
      .bind(...binds([expr]), perPage, (page - 1) * perPage)
      .all<PostRow>()
    return { items: itemsRes.results ?? [], total, page, totalPages }
  } catch {
    // FTS 虚表缺失（迁移未跑完的冷启动窗口）等异常：退回 LIKE，搜索不能因索引挂掉而 500
    return likePath()
  }
}

export interface PageHit {
  slug: string
  title: string
}

export interface PageSearchResult {
  items: PageHit[]
  total: number
}

/** /search 页的独立页面搜索（/page/:slug 那套自建页）：**刻意不用 FTS**。
 *  页面数量是个位数到十几条（项目页 / 书单 / 隐私政策这类），LIKE 全表扫也就读十来行，
 *  走 FTS 要再加一张虚表 + 三个触发器 + 重建记账位，机器比内容还重。词长短都不用管。
 *  只搜已发布、未进回收站的页面；加密/档位概念页面系统没有。 */
export async function searchPages(db: D1Database, q: string, limit = 6): Promise<PageSearchResult> {
  const n = Math.min(20, Math.max(1, Math.floor(limit)))
  const pat = likePattern(q)
  const where = "pg.deleted_at IS NULL AND pg.status = 'published' AND (pg.title LIKE ? ESCAPE '\\' OR pg.content LIKE ? ESCAPE '\\')"
  const [itemsRes, countRes] = await Promise.all([
    db
      .prepare(`SELECT pg.slug, pg.title FROM pages pg WHERE ${where} ORDER BY pg.sort ASC, pg.id ASC LIMIT ?`)
      .bind(pat, pat, n)
      .all<PageHit>(),
    db.prepare(`SELECT COUNT(*) AS n FROM pages pg WHERE ${where}`).bind(pat, pat).first<{ n: number }>(),
  ])
  return { items: itemsRes.results ?? [], total: countRes?.n ?? 0 }
}

export interface WeiboSearchResult {
  items: WeiboRow[]
  total: number
}

/** /search 页微博搜索：长词走 weibo_fts（bm25），短词走 LIKE 扫微博表（微博行数少，扫表够快）。
 *  微博无加密 / 档位概念，只需排除回收站与草稿；站点可见窗口（afterTs）两条路都收口。 */
export async function searchWeibo(db: D1Database, q: string, limit = 20, afterTs = 0): Promise<WeiboSearchResult> {
  const vis = afterTs > 0 ? 'AND COALESCE(w.published_at, w.created_at) >= ?' : ''
  const tail = (args: unknown[]) => (afterTs > 0 ? [...args, afterTs] : args)
  const expr = ftsMatchExpr(q)
  if (expr) {
    const where = `weibo_fts MATCH ? AND w.deleted_at IS NULL AND w.status = 'published' ${vis}`
    try {
      const [itemsRes, countRes] = await Promise.all([
        db
          .prepare(
            `SELECT w.* FROM weibo_fts JOIN weibo w ON w.id = weibo_fts.rowid WHERE ${where} ORDER BY bm25(weibo_fts), w.id DESC LIMIT ?`
          )
          .bind(...tail([expr]), limit)
          .all<WeiboRow>(),
        db
          .prepare(`SELECT COUNT(*) AS n FROM weibo_fts JOIN weibo w ON w.id = weibo_fts.rowid WHERE ${where}`)
          .bind(...tail([expr]))
          .first<{ n: number }>(),
      ])
      return { items: itemsRes.results ?? [], total: countRes?.n ?? 0 }
    } catch {
      /* 虚表缺失等异常：落到底下的 LIKE 兜底 */
    }
  }
    // vis 恒置句尾与 tail() 的追加式 bind 顺序对齐（vis 插中间会把 cutoff 绑成 LIKE 模式——0 行静默漏配）
  const where = `w.deleted_at IS NULL AND w.status = 'published' AND w.content LIKE ? ESCAPE '\\' ${vis}`
  const [itemsRes, countRes] = await Promise.all([
    db
      .prepare(
        `SELECT w.* FROM weibo w WHERE ${where} ORDER BY w.pinned DESC, COALESCE(w.published_at, w.created_at) DESC LIMIT ?`
      )
      .bind(...tail([likePattern(q)]), limit)
      .all<WeiboRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM weibo w WHERE ${where}`).bind(...tail([likePattern(q)])).first<{ n: number }>(),
  ])
  return { items: itemsRes.results ?? [], total: countRes?.n ?? 0 }
}

/* ---------------- 输入联想（/search 搜索框的下拉建议，2026-11 搜索强化） ----------------
 * 只做「标题级」预判：用户敲到第 2 个字就要有反应，所以刻意不走 FTS（短词本来就退回 LIKE，
 * 长词再建一次 bm25 排序也没意义——联想只要「像不像」，不要「多相关」）。返回的是可直接点的
 * 目的地：标签 → 文章 → 页面，顺序即「越窄的语义越靠前」。
 */
export interface SuggestItem {
  /** post = 文章、page = 独立页面、tag = 标签 */
  type: 'post' | 'page' | 'tag'
  text: string
  href: string
}

/** 搜索联想：标题 LIKE + 标签子串命中（标签由调用方传入，通常是 db.listPublishedTagsCached 的
 *  那份 isolate 快照——联想每敲一次键都要用，不能每次真去读 1000 行 tags 列）。
 *  q 少于 1 个字符、或整条查询异常时返回空数组：联想是锦上添花，绝不让搜索框报错。 */
export async function suggestSearch(
  db: D1Database,
  q: string,
  opts: { afterTs?: number; tags?: { name: string; count: number }[]; limit?: number } = {}
): Promise<SuggestItem[]> {
  const limit = Math.min(10, Math.max(1, Math.floor(opts.limit || 8)))
  const needle = q.trim().slice(0, 30)
  if (!needle) return []
  const pat = likePattern(needle)
  const afterTs = opts.afterTs || 0
  // 可见窗口：联想与搜索页同一份口径，窗口外文章不能从下拉里漏出去
  const vis = afterTs > 0 ? 'AND COALESCE(published_at, created_at) >= ?' : ''
  const bound = (extra: unknown[]) => (afterTs > 0 ? [afterTs, ...extra] : extra)
  try {
    const [posts, pages] = await Promise.all([
      db
        .prepare(
          `SELECT slug, title FROM posts WHERE deleted_at IS NULL AND status = 'published' ${vis} AND title LIKE ? ESCAPE '\\' ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`
        )
        .bind(...bound([pat, limit]))
        .all<{ slug: string; title: string }>(),
      db
        .prepare(
          `SELECT slug, title FROM pages WHERE deleted_at IS NULL AND status = 'published' AND title LIKE ? ESCAPE '\\' ORDER BY sort ASC, id ASC LIMIT 3`
        )
        .bind(pat)
        .all<{ slug: string; title: string }>(),
    ])
    const lower = needle.toLowerCase()
    const out: SuggestItem[] = []
    for (const t of (opts.tags || []).filter((t) => t.name.toLowerCase().includes(lower)).slice(0, 3)) {
      out.push({ type: 'tag', text: t.name, href: `/tag/${encodeURIComponent(t.name)}` })
    }
    for (const p of posts.results ?? []) {
      out.push({ type: 'post', text: p.title, href: `/post/${encodeURIComponent(p.slug)}` })
    }
    for (const p of pages.results ?? []) {
      out.push({ type: 'page', text: p.title, href: `/page/${encodeURIComponent(p.slug)}` })
    }
    return out.slice(0, limit)
  } catch {
    return []
  }
}
