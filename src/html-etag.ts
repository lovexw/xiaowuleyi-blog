import type { MiddlewareHandler } from 'hono'
import type { Env, SessionUser } from './types'

/* ---------------- HTML 条件请求（ETag / 304） ----------------
 * 单文件自洽模块（同 pagecache.ts / closed.ts 口径），Node 测试可直接导入。
 *
 * 是什么：公开页响应恒带 Cache-Control: no-cache，浏览器每次刷新都会回来验证；此前没有
 * ETag，结果每次验证都拿回一份完整 200（HTML 20–60KB，跨境链路上白付一个 RTT 的传输）。
 * 这里对 200 的 HTML 响应按内容生成强 ETag，命中 If-None-Match 时改回 304（零 body）。
 * Cloudflare 边缘缓存的副本也带这个 ETag，命中边缘时由 CF 直接回 304、不必回源。
 *
 * 注册位刻意在 pageCacheMiddleware 之前（src/index.ts）：洋葱模型下先注册者的后半段
 * 最后执行，边缘缓存命中的响应也要经过这里，才有机会改写成 304。
 *
 * 注意：边缘副本里没有 ETag。pageCache 是在 next() 返回之后才 clone 入库的，那一刻本
 * 中间件还没执行，所以存进去的响应不可能带 ETag。每个「命中边缘副本」的请求都要按内容
 * 重算一次哈希——几十 KB 的 SHA-256 只有几十微秒，远便宜于跨境传一份完整 body。
 * 「复用已有 ETag」的分支只在响应自带 ETag 时生效（上游/反代写入的情形）。
 *
 * 不依赖 caches.default——Node / docker-poc 一样生效；只碰 200 的 text/html，
 * /api、/images、RSS、503、404、带 Set-Cookie 的响应一律原样放行。
 */

type AppEnv = { Bindings: Env; Variables: { user: SessionUser | null } }

/** 304 上保留的头：复验 / 缓存 / 观测必需。未带的安全头由浏览器沿用缓存副本里的那份 */
const KEEP_ON_304 = ['ETag', 'Cache-Control', 'Vary', 'Content-Signal', 'X-Page-Cache']

/**
 * 纯函数：给 200 的 HTML 响应补强 ETag；请求带 If-None-Match 且命中时返回 304 响应。
 * 其余情况原样返回入参（可能已被加上 ETag）。抽成纯函数是为了测试不必拉起整个 app。
 */
export async function htmlConditionalResponse(res: Response, ifNoneMatch: string | null): Promise<Response> {
  if (res.status !== 200) return res
  if (!/^text\/html\b/i.test(res.headers.get('content-type') || '')) return res
  // 带 Set-Cookie 的响应不做条件请求：304 会让浏览器漏掉这次的 Cookie 写入
  if (res.headers.has('set-cookie')) return res

  // 响应自带 ETag（上游 / 反代已写入）时直接复用，省一次读 body + 摘要
  let etag = res.headers.get('ETag')
  if (!etag) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', await res.clone().arrayBuffer())
      etag = `"${Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')}"`
      res.headers.set('ETag', etag)
    } catch {
      return res // 读 body / 摘要失败就退化成原来的无 ETag 响应，绝不影响页面
    }
  }
  if (!etag || !ifNoneMatch) return res

  // If-None-Match 可以是逗号分隔列表或 *；弱比较按 RFC 9110 去掉 W/ 前缀后比对
  const bare = etag.replace(/^W\//, '')
  const matched =
    ifNoneMatch === '*' || ifNoneMatch.split(',').some((s) => s.trim().replace(/^W\//, '') === bare)
  if (!matched) return res

  const headers = new Headers()
  for (const k of KEEP_ON_304) {
    const v = res.headers.get(k)
    if (v) headers.set(k, v)
  }
  return new Response(null, { status: 304, headers })
}

/** 中间件：只处理 GET 的 HTML 响应；注册位见模块头注释 */
export function htmlEtagMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'GET') return next()
    await next()
    c.res = await htmlConditionalResponse(c.res, c.req.header('If-None-Match') ?? null)
  }
}
