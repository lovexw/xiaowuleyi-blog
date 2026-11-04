/**
 * 前台静态资源的内容寻址版本号（2026-11）：让改过的 site.js / share-card.js 不必靠
 * Cmd+Shift+R 强制刷新、也不必去 Cloudflare 后台手动 Purge 才生效。
 *
 * 病根：HTML 里写死 `<script src="/site.js">`，浏览器按 max-age 把它缓存住。部署后
 * 文件内容变了、URL 却没变，浏览器连问都不会问源站，用户只能强刷或清 CDN 缓存。
 *
 * 做法：服务端启动时对 public/site.js + share-card.js 算一次内容哈希，作为 `?v=` 挂到
 * HTML 的 script URL 上。内容一变 URL 就变 → 浏览器必然重新下载；内容不变 URL 不变 →
 * 可以给一年 immutable，复访零请求。纯内容寻址，不依赖构建步骤、不依赖 git、不改文件名，
 * Cloudflare Workers assets 与自托管 Node 共用同一套物理路径。
 *
 * 后台（public/admin/）同样走这套哈希，但注入方式不同：app.js 内部对 editor.js / emoji.js
 * 是静态 import，相对路径解析会丢掉 ?v=，改 index.html 的 import map 才能一次覆盖三个模块。
 * 见下方 injectAdminAssetVersion()。
 *
 * 版本由适配层（docker-poc/server.ts）注入。Cloudflare Workers 没有文件系统，没注入时
 * assetUrl() 原样返回路径、injectAdminAssetVersion() 原样返回 HTML（行为与改动前完全
 * 一致），那套部署形态不受影响。
 */
let current = ''

/** 只接受自己算出的短十六进制哈希：这个值会拼进 HTML 属性与 URL，不收外部输入 */
export function setAssetVersion(v: string): void {
  current = /^[a-f0-9]{8,32}$/i.test(v) ? v.toLowerCase() : ''
}

export function assetVersion(): string {
  return current
}

/** 无版本时返回原路径（向后兼容）；路径自带 query 时用 & 续接 */
export function assetUrl(path: string): string {
  if (!current) return path
  return `${path}${path.includes('?') ? '&' : '?'}v=${current}`
}

/**
 * 参与内容哈希、且允许「正确版本 → 一年 immutable」的全部静态路径（前台 + 后台）。
 * 单一事实来源：适配层的哈希输入与 immutable 白名单都从这里取，避免两处列表漂移
 * （漂移的后果是某个模块永远拿不到不可变缓存，或者反过来把无版本 URL 永久缓存住）。
 * 后台三个模块必须同进同出——它们互有静态 import，版本不一致 import map 就对不上。
 */
export const VERSIONED_ASSET_PATHS = [
  '/site.js',
  '/share-card.js',
  '/admin/app.js',
  '/admin/editor.js',
  '/admin/emoji.js',
] as const

/** 后台入口里被版本化的模块（相对 /admin/ 的文件名） */
const ADMIN_MODULES = VERSIONED_ASSET_PATHS.filter((p) => p.startsWith('/admin/')).map((p) =>
  p.slice('/admin/'.length)
)
/** 后台入口 HTML 里必须出现的那一行；页面改版后此处不匹配就会静默失效，故抽成常量便于测试 */
const ADMIN_ENTRY_TAG = '<script type="module" src="./app.js"></script>'

/**
 * 后台 SPA 入口（public/admin/index.html）的版本注入。
 *
 * 为什么不能只给 app.js 加版本：editor.js / emoji.js 是 app.js 的静态 import，模块 URL
 * 由模块自身解析，相对路径「./editor.js」解析出来不带 query——app.js 换了新版本，它引的
 * 两个依赖仍会命中浏览器里 4 小时前的旧副本（实测 Cloudflare 的 Browser Cache TTL 会把
 * 源站的 no-cache 统一抬成 max-age=14400，靠响应头根本压不住）。这里用 import map 把
 * 三个模块一起映射到带版本的地址，4900 行的 app.js 一行都不用改。
 *
 * 不支持 import map 的浏览器（Safari < 16.4 等）会忽略这段：入口仍按带版本 URL 加载，
 * editor.js / emoji.js 退回无版本路径——与改动前完全一致，不会白屏。
 *
 * 版本为空（Workers 形态 / 文件缺失）或不是合法哈希时原样返回，HTML 里那行保持不变。
 */
export function injectAdminAssetVersion(html: string, version: string): string {
  if (!/^[a-f0-9]{8,32}$/i.test(version)) return html
  if (!html.includes(ADMIN_ENTRY_TAG)) return html
  const q = `?v=${version.toLowerCase()}`
  const imports = ADMIN_MODULES.map((f) => `"./${f}":"./${f}${q}"`).join(',')
  const injected = `<script type="importmap">{"imports":{${imports}}}</script>\n<script type="module" src="./app.js${q}"></script>`
  return html.replace(ADMIN_ENTRY_TAG, injected)
}
