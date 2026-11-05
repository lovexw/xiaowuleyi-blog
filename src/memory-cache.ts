/**
 * 进程内 Cache 兼容层（Node 自托管专用）
 *
 * 为什么需要：pagecache.ts 的页面 / 图床缓存都建立在 Cache API（`caches.default`）上，
 * 而 Node 没有这个全局对象——`sharedCache()` 恒返回 null，整层缓存短路。也就是说自托管
 * 形态下那 1800 秒的页面缓存**从上线起就没生效过**，每个匿名请求都在直查直渲染 + D1 回源。
 *
 * 这里只实现够用的子集（match / put / delete）：页面缓存中间件用的就是这三个方法，
 * matchAll / add / addAll 一概用不到，不实现反而更安全（用不到就不会被误用）。
 *
 * TTL 从响应头的 Cache-Control `max-age` 解析——Workers 上的 Cache API 也是按这个存的，
 * 口径一致才能保证两条运行时的缓存寿命一致。缺省 1800s（与 PAGE_CACHE_TTL_S 同源）。
 *
 * 三条硬约束，都来自「缓存错了比没缓存更糟」：
 *
 * 1. **单条 2MB 上限**：图床也走这层，图片动辄几 MB、视频 25MB，不拦会把内存撑爆。
 *    超限直接不存（调用方本来就是「尽力回填」语义，不存不影响响应）。
 * 2. **总量 32MB + 300 条，LRU 淘汰**：Map 的插入顺序即 LRU 顺序，命中时把键移到末尾。
 *    按首页 ~200KB 未压缩 HTML 算，约能存 100~160 个页面，对个人博客足够。
 * 3. **match 返回 body 副本**：Response 的 body 是一次性流，多个 Response 共享同一个
 *    ArrayBuffer 会被第一次读取消费掉。每次 match 复制一份，代价是几毫秒。
 *
 * 多租户安全不靠这层：页面缓存键由 pageCacheKeyFor 生成且带 host（pathname 前拼了
 * 请求域名），图床键同样带 host。本模块只负责存，不参与「该不该缓存」的判断。
 */

type Entry = {
  body: Uint8Array
  status: number
  statusText: string
  headers: Headers
  expires: number
}

const MAX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 300
const DEFAULT_TTL_MS = 1800 * 1000

/** 插入顺序 = LRU 顺序（最旧在前）；命中时 delete + set 移到末尾 */
const store = new Map<string, Entry>()
let totalBytes = 0

function keyOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return (input as Request).url
}

/** 解析 max-age；no-store / no-cache 视为不缓存（返回 0） */
function ttlMs(headers: Headers): number {
  const cc = headers.get('cache-control') || ''
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cc)
  if (m) {
    const s = Number(m[1])
    if (Number.isFinite(s) && s > 0) return s * 1000
  }
  if (/no-store|no-cache/i.test(cc)) return 0
  return DEFAULT_TTL_MS
}

function drop(key: string): void {
  const e = store.get(key)
  if (!e) return
  store.delete(key)
  totalBytes -= e.body.byteLength
}

function evict(): void {
  while (store.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = store.keys().next()
    if (oldest.done) break
    drop(oldest.value)
  }
}

function createMemoryCache(): Cache {
  const cache = {
    async match(input: RequestInfo | URL): Promise<Response | undefined> {
      const key = keyOf(input)
      const e = store.get(key)
      if (!e) return undefined
      if (e.expires <= Date.now()) {
        drop(key)
        return undefined
      }
      // LRU 触碰：删了再插，移到队尾
      store.delete(key)
      store.set(key, e)
      return new Response(e.body.slice(), {
        status: e.status,
        statusText: e.statusText,
        headers: new Headers(e.headers),
      })
    },

    async put(input: RequestInfo | URL, res: Response): Promise<void> {
      const key = keyOf(input)
      const ttl = ttlMs(res.headers)
      if (ttl <= 0) return
      // clone 后再读：调用方可能还要用原响应的 body
      const body = new Uint8Array(await res.clone().arrayBuffer())
      if (body.byteLength === 0 || body.byteLength > MAX_ENTRY_BYTES) return
      drop(key)
      store.set(key, {
        body,
        status: res.status,
        statusText: res.statusText,
        headers: new Headers(res.headers),
        expires: Date.now() + ttl,
      })
      totalBytes += body.byteLength
      evict()
    },

    async delete(input: RequestInfo | URL): Promise<boolean> {
      drop(keyOf(input))
      return true
    },
  }
  // 只实现用到的三个方法：缺的方法在类型上不存在，调用即报错，不会被静默忽略
  return cache as unknown as Cache
}

let singleton: Cache | null = null

/** 进程内单例（docker-poc 注入 pagecache 用） */
export function nodeMemoryCache(): Cache {
  if (!singleton) singleton = createMemoryCache()
  return singleton
}

/** 清空（测试隔离用；生产不调用） */
export function resetMemoryCache(): void {
  store.clear()
  totalBytes = 0
}

/** 观测用：当前占用（字节 / 条数），便于启动日志与排查 */
export function memoryCacheStats(): { bytes: number; entries: number } {
  return { bytes: totalBytes, entries: store.size }
}
