import { sha256Hex } from './utils'
import { mediaDeleteKeys, variantBaseKey } from './store'
import type { Env } from './types'

/* ---------------- 媒体体检（后台「媒体 → 体检」的服务端逻辑） ----------------
 * 独立成模块是为了 Node 测试能直接导入（与 closed.ts / hooks.ts 同理）。三个能力：
 *  1. 未引用扫描：uploads 全量 key 与库内全部引用源比对，差集即「站内无引用」；
 *  2. 重复检测：按内容 SHA-256 指纹分组（新上传在 saveUpload 时写入，存量走 backfillHashes 回填）；
 *  3. 安全清理 / 合并：执行前重新校验引用（防「体检完又改了文章」的时间差），合并先把引用
 *     改写到保留项再删文件，前台内容始终有图可用。
 *
 * 引用源清单（新增存图片地址的字段时必须同步 pullReferenceTexts）：
 *   posts.content（含 <meta data-og-image>）与 posts.cover、pages.content、weibo.images、
 *   weibo.video（视频地址与封面帧，B19）、
 *   users.avatar、comments.avatar（评论头像 C2 / 游客 QQ 头像——
 *   2026-11 审计 P1-8 补登记，此前体检会把在用头像误判成未引用并清理掉）、
 *   friend_links.icon、settings.value（favicon/头像/OG 默认图）、tg_buffer（待合并的 TG 相册）。
 *   评论正文是纯文本不存 HTML，不构成引用源。
 */

/** 媒体库可管理的目录前缀：与 /images 路由、DELETE /admin/uploads 的白名单同口径 */
export function isMediaKey(key: string): boolean {
  return key.startsWith('u/') || key.startsWith('og/')
}

export interface UploadRow {
  id: number
  key: string
  name: string
  mime: string
  size: number
  created_at: number
  hash: string
}

export interface AuditItem {
  key: string
  name: string
  mime: string
  size: number
  created_at: number
  /** 仅报告里的条目带：当前是否被站内引用（未引用列表恒为 false） */
  referenced?: boolean
}

/** 「图床里已不存在、只剩库记录」的失踪文件哨兵（回填时写入，永不与真实指纹混淆） */
export const HASH_MISSING = 'missing'
/** 真实指纹是 64 位十六进制 SHA-256，重复分组只认这种形态 */
const HEX64 = /^[0-9a-f]{64}$/

/** 库内引用媒体的统一形态是 /images/<key>（外链绝对 URL 也含这一段）。
 *  线性扫一遍把候选串抠出来，再对 key 全集做精确命中——不做子串包含判断，
 *  天然规避两个 key 互为前缀的误判。候选字符集收紧到 key 的真实形态
 *  （saveUpload 生成的 key 只含 [a-z0-9/._-]）：中文等非 URL 字符与 &、引号
 *  相邻时自然截断（「见图/images/u/a.jpg即可」、HTML 属性结尾 &amp; 都不会把
 *  尾巴吸进候选串造成漏识别），?query/#hash 与中英文尾随标点再兜底剥一层 */
export function collectReferencedKeys(keys: string[], texts: readonly string[]): Set<string> {
  const candidates = new Set(keys)
  const found = new Set<string>()
  if (!candidates.size) return found
  const re = /\/images\/[\w./-]+/g
  for (const text of texts) {
    if (!text || !text.includes('/images/')) continue
    for (const m of text.matchAll(re)) {
      const key = m[0]
        .replace(/[.,;:!?'")\]}>、，。！？；：」』）】]+$/, '')
        .split(/[?#&]/)[0]
        .slice('/images/'.length)
      if (candidates.has(key)) found.add(key)
    }
  }
  return found
}

export interface DupGroup {
  hash: string
  items: UploadRow[]
  /** 冗余体积：同内容副本里多出来的 n-1 份 */
  wasteBytes: number
}

/** 按内容指纹分组找重复：只认 64 位十六进制指纹，''（未回填）与 missing（失踪）不参与 */
export function groupDuplicates(uploads: UploadRow[]): DupGroup[] {
  const byHash = new Map<string, UploadRow[]>()
  for (const u of uploads) {
    if (!HEX64.test(u.hash)) continue
    const list = byHash.get(u.hash)
    if (list) list.push(u)
    else byHash.set(u.hash, [u])
  }
  return [...byHash.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([hash, items]) => ({ hash, items, wasteBytes: (items.length - 1) * (items[0]?.size ?? 0) }))
}

/** 站内所有存媒体地址的列——**唯一事实来源**：体检的引用识别、合并时的改写、合并后的校验都用这一张表。
 *
 *  为什么必须共用一张表：这三处只要有一处漏列，后果就是「以为没人用 → 删掉 → 地址还在别处指着它」。
 *  2026-11-06 就踩过一次：合并改写漏了 weibo.video（引用识别有、改写没有），
 *  用生产库快照预演 241 组重复合并，站内断链从 2 处涨到 44 处，全是微博视频。
 *
 *  mode = 'scan'：正文/配图这类大字段，按字节预算分桶查询（不把整库正文拉进一次响应）；
 *  mode = 'small'：头像/图标/设置这类小字段，一次 LIKE 查全即可。 */
const MEDIA_REF_COLUMNS: { table: string; col: string; mode: 'scan' | 'small' }[] = [
  { table: 'posts', col: 'content', mode: 'scan' },
  { table: 'posts', col: 'cover', mode: 'small' },
  { table: 'pages', col: 'content', mode: 'scan' },
  { table: 'weibo', col: 'images', mode: 'scan' },
  // 视频列存 JSON（url + poster 都是 /images/ 地址）：不进引用源会被误判为「未被引用」（B19）
  { table: 'weibo', col: 'video', mode: 'scan' },
  { table: 'users', col: 'avatar', mode: 'small' },
  // 评论头像 C2 / 会员 QQ 头像：都经 saveUpload 落 /images/，漏登记会打瘫评论区头像（P1-8）
  { table: 'comments', col: 'avatar', mode: 'small' },
  { table: 'friend_links', col: 'icon', mode: 'small' },
  { table: 'settings', col: 'value', mode: 'small' },
  // tg_buffer 是待合并的 TG 相册缓冲，行数个位数且**没有 id 列**（分桶查询按 id 取行，用不了）
  { table: 'tg_buffer', col: 'content', mode: 'small' },
  { table: 'tg_buffer', col: 'images', mode: 'small' },
]

/** 改写的粒度是「表」：同一张表的多列用一条 UPDATE 一起改 */
const REF_TABLES: [table: string, cols: string[]][] = (() => {
  const byTable = new Map<string, string[]>()
  for (const { table, col } of MEDIA_REF_COLUMNS) byTable.set(table, [...(byTable.get(table) ?? []), col])
  return [...byTable]
})()

/* ---------------- 引用源拉取 ----------------
 * 大字段（posts/pages 正文、weibo 配图）按字节预算分桶查询：单条查询的响应体积可控，
 * 也不至于把整库正文拉进内存；含图行先用 LIKE 预筛，纯文字文章不进候选。
 * 桶大小对齐 D1 单语句 100 个绑定变量的上限（每桶 ≤ 50 个 id）。 */

/** 单条查询响应的保守字节预算（正文单篇上限 1MB，超预算的大行会独占一条查询） */
const QUERY_BYTE_BUDGET = 700_000
/** db.batch 单批语句数上限（保守分片，防子请求超限） */
const BATCH_CHUNK = 25

/** table/column 只来自本文件字面量，无注入面 */
async function bucketedColumnScan(
  db: D1Database,
  table: string,
  column: string
): Promise<{ texts: string[]; probed: number }> {
  const probe = await db
    .prepare(`SELECT id, length(CAST(${column} AS BLOB)) AS len FROM ${table} WHERE ${column} LIKE '%/images/%'`)
    .all<{ id: number; len: number }>()
  const buckets: number[][] = []
  let cur: number[] = []
  let bytes = 0
  for (const r of probe.results ?? []) {
    const len = r.len || 0
    if (cur.length && (bytes + len > QUERY_BYTE_BUDGET || cur.length >= 50)) {
      buckets.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(r.id)
    bytes += len
  }
  if (cur.length) buckets.push(cur)

  const texts: string[] = []
  for (let i = 0; i < buckets.length; i += BATCH_CHUNK) {
    const res = await db.batch(
      buckets.slice(i, i + BATCH_CHUNK).map((ids) => {
        const ph = ids.map(() => '?').join(',')
        return db.prepare(`SELECT ${column} AS v FROM ${table} WHERE id IN (${ph})`).bind(...ids)
      })
    )
    for (const r of res) for (const row of (r.results ?? []) as { v: string }[]) if (row.v) texts.push(row.v)
  }
  return { texts, probed: (probe.results ?? []).length }
}

/** 小字段一次批查拿全：行数与单值体积都被产品设计封顶（用户表个位数、友链 ≤500、设置 ≤50 条） */
async function pullReferenceTexts(db: D1Database): Promise<string[]> {
  const texts: string[] = []
  let probed = 0
  for (const { table, col, mode } of MEDIA_REF_COLUMNS) {
    if (mode !== 'scan') continue
    const r = await bucketedColumnScan(db, table, col)
    texts.push(...r.texts)
    probed += r.probed
  }
  // 死线守卫（2026-11-06）：预筛明确命中「含 /images/ 的记录」，正文却一条都没取回来，
  // 只可能是数据层坏了（当时是 docker-poc 的 db.batch 把 SELECT 当写语句执行，结果集全丢）。
  // 这种情况绝不能当「全站没有引用」继续跑——体检会把整库文件列成未引用，一键清理即删光图床。
  // 宁可让体检报错，也不能给出一份反过来的报告。
  if (probed > 0 && texts.length === 0) {
    throw new Error(
      `引用源读取异常：预筛命中 ${probed} 条含图记录，却未取回任何正文/配图；已中止体检（避免把全部媒体误判为「未引用」）`
    )
  }
  const small = await db.batch(
    MEDIA_REF_COLUMNS.filter((c) => c.mode === 'small').map(({ table, col }) =>
      db.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE '%/images/%' LIMIT 20000`)
    )
  )
  for (const r of small) for (const row of (r.results ?? []) as { v: string }[]) if (row.v) texts.push(row.v)
  return texts
}

/** 对给定 key 集合做一次引用判定（审计全量扫、清理/合并执行前复验共用同一口径） */
async function scanReferencedKeys(env: Env, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set()
  return collectReferencedKeys(keys, await pullReferenceTexts(env.DB))
}

/* ---------------- 体检报告 ---------------- */

export interface AuditReport {
  scanned: number
  /** 指纹尚未回填的数量（>0 时前端先跑回填再重扫） */
  missingHash: number
  unreferenced: AuditItem[]
  unreferencedBytes: number
  duplicateGroups: { hash: string; items: AuditItem[]; wasteBytes: number }[]
  duplicateBytes: number
  /** 图床里已不存在、只剩库记录的失踪文件（多半是手动清过 R2） */
  ghosts: AuditItem[]
  /** 磁盘有而库无（2026-11 审计 P2-18）：上传中断残文件 / 手工拷贝 / 变体残留。
   *  只报告不自动删——「宁少删不错删」；staleVariants 是原 key 已不在库的孤儿变体（P1-7 清理后应为 0） */
  orphans: {
    count: number
    staleVariants: number
    sample: string[]
    /** 达到单次扫描上限、还有对象没看（此时 count 只会偏少，不会偏多） */
    truncated: boolean
    /** 实际翻过的对象数（含 backups/ 等非媒体前缀）与本轮上限，前端据此说清「扫到哪了」 */
    scanned: number
    limit: number
  }
}

/** 单次体检最多翻多少个图床对象（R2 list 每页 1000，即最多 50 次调用）。
 *  2026-11 复核：旧上限 2 万 —— 生产图床已有 22586 个文件，超出的 2586 个永远看不到，
 *  报告却只在角落写一句「截断于 2 万个」，孤儿数被无声低估。抬到 5 万（仍封顶：
 *  病态大桶不该把一次体检拖成几十秒）。磁盘实现的重复全树遍历另在 r2disk.list 里用
 *  索引缓存解决，翻页不再逐页重走整棵树。 */
const ORPHAN_SCAN_MAX = 50_000
const ORPHAN_PAGE = 1000

/** 磁盘有而库无：翻页遍历图床对象，与 uploads 全集做差。只读不删。 */
async function scanDiskOrphans(env: Env, knownKeys: Set<string>): Promise<AuditReport['orphans']> {
  let cursor: string | undefined
  let scanned = 0
  let count = 0
  let staleVariants = 0
  const sample: string[] = []
  const maxPages = Math.ceil(ORPHAN_SCAN_MAX / ORPHAN_PAGE)
  for (let page = 0; page < maxPages; page++) {
    const res = await env.IMAGES.list({ limit: ORPHAN_PAGE, cursor })
    // 计数口径按「翻过多少对象」而非「多少媒体文件」：成本在翻页本身，
    // 按媒体数封顶时备份文件多的桶会一直翻到页数上限才停
    scanned += res.objects.length
    for (const o of res.objects) {
      if (!isMediaKey(o.key)) continue
      if (knownKeys.has(o.key)) continue
      const base = variantBaseKey(o.key)
      if (base) {
        // 变体：原图还在库 = 正常派生文件；原图已不在库 = 孤儿变体（删除路径漏网的）
        if (!knownKeys.has(base)) {
          staleVariants++
          count++
          if (sample.length < 50) sample.push(o.key)
        }
        continue
      }
      count++
      if (sample.length < 50) sample.push(o.key)
    }
    // 没有下一页，或已到上限：收工。res.truncated 为真但没给 cursor 属异常实现，
    // 继续翻会原地打转，一律按「已截断」返回
    if (!res.truncated || scanned >= ORPHAN_SCAN_MAX) return { count, staleVariants, sample, truncated: !!res.truncated, scanned, limit: ORPHAN_SCAN_MAX }
    if (!res.cursor) return { count, staleVariants, sample, truncated: true, scanned, limit: ORPHAN_SCAN_MAX }
    cursor = res.cursor
  }
  return { count, staleVariants, sample, truncated: true, scanned, limit: ORPHAN_SCAN_MAX }
}

export async function runAudit(env: Env): Promise<AuditReport> {
  const { results } = await env.DB.prepare(
    'SELECT id, key, name, mime, size, created_at, hash FROM uploads ORDER BY created_at DESC'
  ).all<UploadRow>()
  const uploads = results ?? []
  const knownKeys = new Set(uploads.map((u) => u.key))
  const referenced = await scanReferencedKeys(
    env,
    uploads.map((u) => u.key)
  )
  const orphans = await scanDiskOrphans(env, knownKeys)

  const unreferenced: AuditItem[] = []
  const ghosts: AuditItem[] = []
  let missingHash = 0
  for (const u of uploads) {
    const item: AuditItem = { key: u.key, name: u.name, mime: u.mime, size: u.size, created_at: u.created_at }
    if (u.hash === HASH_MISSING) {
      // 失踪文件单独呈现：对象已 404，引用它的正文本来就是死链，与「未引用」分开处置
      ghosts.push({ ...item, referenced: referenced.has(u.key) })
      continue
    }
    if (!u.hash) missingHash++
    if (!referenced.has(u.key)) unreferenced.push(item)
  }

  const duplicateGroups = groupDuplicates(uploads).map((g) => ({
    hash: g.hash,
    wasteBytes: g.wasteBytes,
    items: g.items.map((u) => ({ key: u.key, name: u.name, mime: u.mime, size: u.size, created_at: u.created_at, referenced: referenced.has(u.key) })),
  }))
  return {
    scanned: uploads.length,
    missingHash,
    unreferenced,
    unreferencedBytes: unreferenced.reduce((s, u) => s + u.size, 0),
    duplicateGroups,
    duplicateBytes: duplicateGroups.reduce((s, g) => s + g.wasteBytes, 0),
    ghosts,
    orphans,
  }
}

/* ---------------- 指纹回填 ---------------- */

export interface BackfillResult {
  /** 本轮真正算出指纹的数量（失踪文件不计入） */
  processed: number
  /** 本轮发现图床里已不存在的数量（写入 HASH_MISSING 哨兵，下次不再重复读） */
  missing: number
  /** 还剩多少未定指纹（0 = 回填完成） */
  remaining: number
}

/** 增量回填一批指纹：每轮读 ≤ limit 个 R2 对象（Workers 子请求预算内），前端循环到 remaining=0 */
export async function backfillHashes(env: Env, limit = 25): Promise<BackfillResult> {
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 25))
  const { results } = await env.DB.prepare("SELECT key FROM uploads WHERE hash = '' LIMIT ?")
    .bind(n)
    .all<{ key: string }>()
  const rows = results ?? []
  if (!rows.length) return { processed: 0, missing: 0, remaining: 0 }

  const stmts: D1PreparedStatement[] = []
  let missing = 0
  for (const r of rows) {
    const obj = await env.IMAGES.get(r.key)
    if (!obj) {
      missing++
      stmts.push(env.DB.prepare('UPDATE uploads SET hash = ? WHERE key = ?').bind(HASH_MISSING, r.key))
      continue
    }
    stmts.push(env.DB.prepare('UPDATE uploads SET hash = ? WHERE key = ?').bind(await sha256Hex(await obj.arrayBuffer()), r.key))
  }
  await env.DB.batch(stmts)
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE hash = ''").first<{ n: number }>()
  return { processed: rows.length - missing, missing, remaining: left?.n ?? 0 }
}

/* ---------------- 合并重复 ---------------- */

export interface MergeResult {
  /** 被改写的引用处数（跨所有表的行数合计） */
  updated: number
  freedBytes: number
  /** 被合并删除的 key（调用方据此清图床边缘缓存，审计 F2） */
  removed: string[]
  /** 删除口径全集 = removed ∪ 变体派生 key（P1-7）：边缘缓存清理用它，UI 展示仍用 removed */
  purgeKeys: string[]
}

/* REF_TABLES 由 MEDIA_REF_COLUMNS 推导（见文件上方）：改写的列集合必然等于体检测引用的列集合 */

/** 把 remove 组的引用改写到 keep 并删除 remove。
 *  安全闸：所有 key 必须是媒体库可管理的目录、必须真实存在、内容指纹必须完全一致——
 *  指纹未回填或不一致一律拒绝，宁可让用户重扫也不能改错内容 */
export async function mergeDuplicate(env: Env, keep: string, remove: string[]): Promise<MergeResult> {
  const rm = [...new Set(remove.map(String))]
  if (!isMediaKey(keep) || !rm.length || rm.length > 20 || rm.includes(keep) || rm.some((k) => !isMediaKey(k))) {
    throw new Error('非法的文件 Key')
  }
  const ph = [...rm, keep].map(() => '?').join(',')
  const { results } = await env.DB
    .prepare(`SELECT key, hash, size FROM uploads WHERE key IN (${ph})`)
    .bind(...rm, keep)
    .all<{ key: string; hash: string; size: number }>()
  const byKey = new Map((results ?? []).map((r) => [r.key, r]))
  const keepRow = byKey.get(keep)
  if (!keepRow) throw new Error('要保留的文件不存在，请重新体检')
  if (rm.some((k) => !byKey.has(k))) throw new Error('部分文件不存在，请重新体检')
  if (!HEX64.test(keepRow.hash) || rm.some((k) => byKey.get(k)!.hash !== keepRow.hash)) {
    throw new Error('文件内容指纹不一致或尚未计算，请重新体检后再合并')
  }

  // 引用改写：/images/<rm> → /images/<keep>。needle 是完整 key（时间戳+随机串），
  // 不存在互为前缀的 key，REPLACE 字面替换不会误伤；绝对 URL 同样命中这一子串
  const stmts: D1PreparedStatement[] = []
  for (const k of rm) {
    const from = `/images/${k}`
    const to = `/images/${keep}`
    for (const [table, cols] of REF_TABLES) {
      const sets = cols.map((c) => `${c} = REPLACE(${c}, ?, ?)`).join(', ')
      const conds = cols.map((c) => `instr(${c}, ?) > 0`).join(' OR ')
      // 占位符 3n 个：每列 SET 两个（from/to）+ WHERE 每列一个（from）
      stmts.push(env.DB.prepare(`UPDATE ${table} SET ${sets} WHERE ${conds}`).bind(...cols.flatMap(() => [from, to]), ...cols.map(() => from)))
    }
  }
  let updated = 0
  for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
    const res = await env.DB.batch(stmts.slice(i, i + BATCH_CHUNK))
    for (const r of res) updated += r.meta.changes || 0
  }

  // 最后一道校验（2026-11-06）：改写完再问一遍「站内还有没有地方指着这些副本」。
  // 查的列 = MEDIA_REF_COLUMNS（体检识别引用用的同一张表），所以「漏改一列」这种 bug
  // 会在这里暴露成中止，而不是删完之后留下一堆 404 地址。宁可报错让人重试，也不带病删除。
  const check = await env.DB.batch(
    REF_TABLES.map(([table, cols]) => {
      const conds = cols.flatMap((c) => rm.map(() => `instr(${c}, ?) > 0`))
      return env.DB
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${conds.join(' OR ')}`)
        .bind(...cols.flatMap(() => rm.map((k) => `/images/${k}`)))
    })
  )
  const still = check.reduce((s, r) => s + Number((r.results?.[0] as { n?: number })?.n ?? 0), 0)
  if (still > 0) throw new Error(`仍有 ${still} 处内容引用这些副本，已中止删除（请重试；持续失败请把这条报给开发）`)

  // 删除口径带变体派生文件（2026-11 审计 P1-7）：变体不进 uploads 表，只删原 key
  // 会留下仍可公开访问的 <key>@480.webp
  const purgeKeys = mediaDeleteKeys(rm)
  await env.IMAGES.delete(purgeKeys)
  await env.DB.prepare(`DELETE FROM uploads WHERE key IN (${rm.map(() => '?').join(',')})`)
    .bind(...rm)
    .run()
  return { updated, freedBytes: keepRow.size * rm.length, removed: rm, purgeKeys }
}

/* ---------------- 一键合并全部重复 ---------------- */

export interface MergeAllResult {
  /** 本批尝试的组数 */
  groups: number
  /** 本批成功的组数（失败的组会留在 remaining 里，下次重试） */
  processed: number
  /** 本批删除的副本文件数 */
  removed: number
  freedBytes: number
  /** 本批改写的引用处数 */
  updated: number
  /** 本批做完后还剩多少组重复（前端据它决定要不要继续下一批） */
  remaining: number
  /** 失败明细：一组失败不影响同批其他组 */
  failed: { hash: string; error: string }[]
  /** 已删文件（含变体派生 key），调用方据此清图床边缘缓存 */
  purgeKeys: string[]
}

/** 单次请求最多处理多少组：一条 merge 语句要扫 9 张表的正文，分批做才不会拖成长请求 */
export const MERGE_ALL_MAX = 30

/** 全部重复一次性合并（每组挑一张留下，其余合并进去）。
 *
 *  为什么在服务端重新分组、而不是让前端把分组结果发上来：分组依据是指纹，前端那份可能已经过期
 *  （体检之后又传了新图 / 合并过一批），按过期清单删文件是最危险的一类操作。这里每次都从
 *  uploads 现算，天然幂等——重复调用、被打断后重试都只会推进，不会误删。
 *
 *  保留规则（可解释、可预期）：**正在被引用的优先**（改写引用才不会动到在用内容），
 *  同样都在用/都没用时取**上传最早**的那张（老文章里的地址保持不变，URL 更稳定）。
 *  从体积最大的组开始处理，同样的点击次数先回收大头。 */
export async function mergeAllDuplicates(env: Env, limit = 20): Promise<MergeAllResult> {
  const take = Math.min(Math.max(1, Math.floor(limit) || 20), MERGE_ALL_MAX)
  const empty: MergeAllResult = {
    groups: 0, processed: 0, removed: 0, freedBytes: 0, updated: 0, remaining: 0, failed: [], purgeKeys: [],
  }

  const { results: groups } = await env.DB
    .prepare(
      `SELECT hash FROM uploads WHERE length(hash) = 64
        GROUP BY hash HAVING COUNT(*) > 1 ORDER BY SUM(size) DESC LIMIT ?`
    )
    .bind(take)
    .all<{ hash: string }>()
  if (!groups.length) return empty

  const hashes = groups.map((g) => g.hash)
  const { results: rows } = await env.DB
    .prepare(`SELECT key, hash, size, created_at FROM uploads WHERE hash IN (${hashes.map(() => '?').join(',')})`)
    .bind(...hashes)
    .all<{ key: string; hash: string; size: number; created_at: number }>()

  // 引用判定只扫一遍（引用源全量拉取是本函数最贵的部分），本批所有组共用
  const referenced = await scanReferencedKeys(env, (rows ?? []).map((r) => r.key))

  const out: MergeAllResult = { ...empty, groups: hashes.length, failed: [], purgeKeys: [] }
  for (const hash of hashes) {
    const items = (rows ?? []).filter((r) => r.hash === hash)
    if (items.length < 2) continue
    // 引用中的优先 → 上传最早 → key 字典序（最后一条只是为了排序稳定，结果可复现）
    const ranked = [...items].sort((a, b) => {
      const ra = referenced.has(a.key) ? 1 : 0
      const rb = referenced.has(b.key) ? 1 : 0
      if (ra !== rb) return rb - ra
      if (a.created_at !== b.created_at) return a.created_at - b.created_at
      return a.key < b.key ? -1 : 1
    })
    const keep = ranked[0].key
    const remove = ranked.slice(1).map((r) => r.key)
    try {
      // 单组副本可能超过 mergeDuplicate 的 20 个上限：同 keep 分批，REPLACE 改写幂等
      for (let i = 0; i < remove.length; i += 20) {
        const r = await mergeDuplicate(env, keep, remove.slice(i, i + 20))
        out.updated += r.updated
        out.freedBytes += r.freedBytes
        out.removed += r.removed.length
        out.purgeKeys.push(...r.purgeKeys)
      }
      out.processed++
    } catch (e) {
      // 一组失败（指纹不一致 / 文件正好被删）不牵连其他组，留在剩余里下次再来
      out.failed.push({ hash, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const left = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM (SELECT hash FROM uploads WHERE length(hash) = 64 GROUP BY hash HAVING COUNT(*) > 1)')
    .first<{ n: number }>()
  out.remaining = left?.n ?? 0
  return out
}

/* ---------------- 清理未引用 ---------------- */

export interface CleanupResult {
  deleted: number
  freedBytes: number
  /** 执行时发现已被内容引用而保留下来的 key（体检与清理之间内容可能变过） */
  blocked: string[]
  /** 真正删除的 key（调用方据此清图床边缘缓存，审计 F2） */
  deletedKeys: string[]
}

/** 删除一批未引用媒体。执行前对这批 key 重新做一遍引用判定：期间新写的文章若用上了
 *  其中某张图，只删其余的，被引用的原样保留并回告（前端提示重新体检） */
export async function cleanupUnreferenced(env: Env, keys: string[]): Promise<CleanupResult> {
  const ks = [...new Set(keys.map(String))]
  if (!ks.length || ks.length > 100 || ks.some((k) => !isMediaKey(k))) throw new Error('非法的文件 Key')

  const referenced = await scanReferencedKeys(env, ks)
  const deletable = ks.filter((k) => !referenced.has(k))
  const blocked = ks.filter((k) => referenced.has(k))
  if (!deletable.length) return { deleted: 0, freedBytes: 0, blocked, deletedKeys: [] }

  const ph = deletable.map(() => '?').join(',')
  const { results } = await env.DB
    .prepare(`SELECT key, size FROM uploads WHERE key IN (${ph})`)
    .bind(...deletable)
    .all<{ key: string; size: number }>()
  const freedBytes = (results ?? []).reduce((s, r) => s + r.size, 0)
  // 删除口径带变体派生文件（P1-7），边缘缓存清理（deletedKeys 消费方）随之覆盖变体 URL
  const purgeKeys = mediaDeleteKeys(deletable)
  await env.IMAGES.delete(purgeKeys)
  await env.DB.prepare(`DELETE FROM uploads WHERE key IN (${ph})`)
    .bind(...deletable)
    .run()
  return { deleted: deletable.length, freedBytes, blocked, deletedKeys: purgeKeys }
}
