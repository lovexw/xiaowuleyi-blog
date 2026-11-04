import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageExtOf, MAX_REMOTE_IMAGES, MAX_UPLOAD_BYTES, mimeOfKey, sniffImageExt, sniffUploadExt, variantBaseKey } from '../src/store.ts'

// ── 上传常量与白名单（AGENTS「上传常量与落库统一走 src/store.ts」）：
// imageExtOf 必须走 hasOwnProperty——IMAGE_MIMES['constructor'] 是继承属性，直查表可穿透 ──

const buf = (bytes: number[]) => Uint8Array.from(bytes).buffer

test('imageExtOf：白名单查表含 image/jpg 别名，原型链属性穿透不出去', () => {
  assert.equal(imageExtOf('image/jpeg'), 'jpg')
  assert.equal(imageExtOf('image/jpg'), 'jpg')
  assert.equal(imageExtOf('image/png'), 'png')
  assert.equal(imageExtOf('image/webp'), 'webp')
  assert.equal(imageExtOf('image/gif'), 'gif')
  assert.equal(imageExtOf('image/x-icon'), 'ico')
  assert.equal(imageExtOf('image/vnd.microsoft.icon'), 'ico')
  // 原型链上的 Function 属性名：直查表会 truthy 穿透，hasOwnProperty 必须挡住
  assert.equal(imageExtOf('constructor'), undefined)
  assert.equal(imageExtOf('toString'), undefined)
  assert.equal(imageExtOf('hasOwnProperty'), undefined)
  assert.equal(imageExtOf('image/svg+xml'), undefined) // SVG 永不入白名单（存储 XSS）
  assert.equal(imageExtOf(''), undefined)
})

test('sniffUploadExt：手动上传魔数识别覆盖 ico / mp4 / webm（sniffImageExt 不认的三类）', () => {
  assert.equal(sniffUploadExt(buf([0, 0, 1, 0, 1, 0, 16, 16])), 'ico')
  assert.equal(sniffUploadExt(buf([0, 0, 2, 0, 1, 0, 32, 32])), 'ico') // CUR 同魔数族
  // MP4：偏移 4-7 = 'ftyp'
  assert.equal(sniffUploadExt(buf([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])), 'mp4')
  assert.equal(sniffUploadExt(buf([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])), 'webm')
  // 四类图片魔数复用 sniffImageExt 口径
  assert.equal(sniffUploadExt(buf([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
  assert.equal(sniffUploadExt(buf([0x89, 0x50, 0x4e, 0x47])), 'png')
})

test('sniffUploadExt：HTML/SVG/文本与空缓冲一律拒收', () => {
  const str = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
  assert.equal(sniffUploadExt(str('<html><script>alert(1)</script></html>')), null)
  assert.equal(sniffUploadExt(str('<?xml version="1.0"?><svg onload="alert(1)">')), null)
  assert.equal(sniffUploadExt(new ArrayBuffer(0)), null)
})

test('转存上限常量：单篇图数与单文件字节在位（防 Workers 子请求 / 内存超限）', () => {
  assert.equal(MAX_REMOTE_IMAGES, 30)
  assert.ok(MAX_UPLOAD_BYTES > 0 && MAX_UPLOAD_BYTES <= 25 * 1024 * 1024)
})

// ── /images/* 读取侧的 MIME 兜底：迁移进 R2 的历史对象常缺 httpMetadata.contentType，
//    读出会退化成 application/octet-stream，微信抓不到 og:image，也进不了 isImageStorable 缓存 ──
test('mimeOfKey：按扩展名补回图片/视频 mime', () => {
  assert.equal(mimeOfKey('u/202610/abc.png'), 'image/png')
  assert.equal(mimeOfKey('u/202610/abc.jpg'), 'image/jpeg')
  assert.equal(mimeOfKey('u/202610/abc.jpeg'), 'image/jpeg')
  assert.equal(mimeOfKey('u/202610/abc.webp'), 'image/webp')
  assert.equal(mimeOfKey('u/202610/abc.gif'), 'image/gif')
  assert.equal(mimeOfKey('og/favicon.ico'), 'image/x-icon')
  assert.equal(mimeOfKey('u/202610/abc.avif'), 'image/avif')
  assert.equal(mimeOfKey('u/202610/abc.mp4'), 'video/mp4')
  assert.equal(mimeOfKey('u/202610/abc.webm'), 'video/webm')
  // 大小写不敏感；只取最后一个点（目录名带点不影响）
  assert.equal(mimeOfKey('u/202610/ABC.PNG'), 'image/png')
  assert.equal(mimeOfKey('u/2026.10/a.png'), 'image/png')
})

test('mimeOfKey：认不出的扩展名一律返回空，保持 octet-stream', () => {
  // SVG 永不补类型：同源直开可执行脚本，是存储 XSS
  assert.equal(mimeOfKey('u/202610/a.svg'), '')
  assert.equal(mimeOfKey('u/202610/a.html'), '')
  assert.equal(mimeOfKey('u/202610/a.js'), '')
  assert.equal(mimeOfKey('u/202610/noext'), '')
  assert.equal(mimeOfKey('u/202610/a.'), '')
  // 键名可控，原型链属性必须挡住（MIME_BY_EXT['constructor'] 是继承来的函数对象）
  assert.equal(mimeOfKey('u/x.constructor'), '')
  assert.equal(mimeOfKey('u/x.toString'), '')
  assert.equal(mimeOfKey('u/x.__proto__'), '')
})

// ── 响应式变体键：模板输出 `<原图>@480.webp`，宿主机预生成同 key 的静态文件；
//    没生成时 /images 路由靠它回退原图，否则新上传的图会一直裂图 ──
test('variantBaseKey：变体键还原成原图键', () => {
  assert.equal(variantBaseKey('u/202610/a.jpg@480.webp'), 'u/202610/a.jpg')
  assert.equal(variantBaseKey('u/202610/a.png@192.webp'), 'u/202610/a.png')
  assert.equal(variantBaseKey('og/202610/card.png@960.webp'), 'og/202610/card.png')
  // 非变体形态一律 null
  assert.equal(variantBaseKey('u/202610/a.jpg'), null)
  assert.equal(variantBaseKey('u/202610/a.webp'), null)
  assert.equal(variantBaseKey('u/202610/a.jpg@480.avif'), null)
  assert.equal(variantBaseKey('u/202610/a.jpg@.webp'), null)
  assert.equal(variantBaseKey('u/202610/a.jpg@12345.webp'), null)
  // 原图不是会生成变体的格式：GIF/SVG/无扩展名都别白跑一次 get
  assert.equal(variantBaseKey('u/202610/a.gif@480.webp'), null)
  assert.equal(variantBaseKey('u/202610/a.svg@480.webp'), null)
  assert.equal(variantBaseKey('u/202610/noext@480.webp'), null)
  // 键名可控：不能让 @ 把它带出图床前缀，也不能二次剥离
  assert.equal(variantBaseKey('u/202610/a.jpg@480.webp@960.webp'), 'u/202610/a.jpg@480.webp')
})
