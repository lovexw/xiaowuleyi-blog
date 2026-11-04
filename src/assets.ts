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
 * 版本由适配层（docker-poc/server.ts）注入。Cloudflare Workers 没有文件系统，没注入时
 * assetUrl() 原样返回路径（行为与改动前完全一致），那套部署形态不受影响。
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
