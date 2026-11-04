import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { assetUrl, injectAdminAssetVersion, setAssetVersion, VERSIONED_ASSET_PATHS } from '../src/assets'

/**
 * 后台 SPA 入口的版本注入（2026-11 补漏）。
 *
 * 背景：site.js / share-card.js 早就挂了内容哈希，但后台 app.js 没有。实测 Cloudflare 的
 * Browser Cache TTL 会把源站的 no-cache 也抬成 max-age=14400（/admin/sw.js 可见），因此
 * 「加 no-cache」压不住旧文件，只能靠 URL 版本化。app.js 里的 editor.js / emoji.js 是静态
 * import，相对路径解析会丢 query，所以必须用 import map 一次覆盖三个模块。
 *
 * 这里守两件事：注入结果正确；index.html 里的标记串没被改掉（标记一改，注入就静默失效）。
 */

const ENTRY_FILE = new URL('../public/admin/index.html', import.meta.url)
const MARKER = '<script type="module" src="./app.js"></script>'
const V = 'bd28bef3a601'

function readEntry(): string {
  return fs.readFileSync(ENTRY_FILE, 'utf8')
}

test('后台入口 HTML 里仍有注入锚点（锚点被改则版本注入静默失效）', () => {
  assert.ok(
    readEntry().includes(MARKER),
    `public/admin/index.html 缺少标记串 ${MARKER}；若改了这行，请同步 src/assets.ts 的 ADMIN_ENTRY_TAG`
  )
})

test('注入后三个模块都带同一版本，且 import map 在入口脚本之前', () => {
  const out = injectAdminAssetVersion(readEntry(), V)
  for (const f of ['app.js', 'editor.js', 'emoji.js']) {
    assert.ok(out.includes(`./${f}?v=${V}`), `${f} 未带上版本`)
  }
  const mapAt = out.indexOf('<script type="importmap">')
  const entryAt = out.indexOf(`<script type="module" src="./app.js?v=${V}">`)
  assert.ok(mapAt >= 0, '缺少 import map')
  assert.ok(entryAt >= 0, '入口脚本未带版本')
  // import map 必须出现在任何 module 之前，否则浏览器不认这段映射
  assert.ok(mapAt < entryAt, 'import map 必须在入口脚本之前')
  // 原来的无版本入口不能再残留一份，否则浏览器可能加载两份 app.js
  assert.ok(!out.includes(MARKER), '仍残留无版本入口脚本')
})

test('import map 是合法 JSON，且映射值与入口脚本同源同版本', () => {
  const out = injectAdminAssetVersion(readEntry(), V)
  const m = out.match(/<script type="importmap">([\s\S]*?)<\/script>/)
  assert.ok(m, '未找到 import map')
  const parsed = JSON.parse(m![1]) as { imports: Record<string, string> }
  assert.deepEqual(Object.keys(parsed.imports).sort(), ['./app.js', './editor.js', './emoji.js'])
  for (const v of Object.values(parsed.imports)) assert.ok(v.endsWith(`?v=${V}`), `映射值未带版本：${v}`)
})

test('版本非法或缺失时原样返回，绝不产出半截 URL', () => {
  const html = readEntry()
  for (const bad of ['', 'abc', 'deadbeef\"><script>x</script>', '../etc/passwd', 'zzzzzzzzzzzz']) {
    assert.equal(injectAdminAssetVersion(html, bad), html, `非法版本 ${JSON.stringify(bad)} 不应改动 HTML`)
  }
})

test('页面里没有锚点（改版 / Workers 形态）时原样返回', () => {
  const html = '<html><body><script type="module" src="./main.js"></script></body></html>'
  assert.equal(injectAdminAssetVersion(html, V), html)
})

test('大写版本被规范成小写，与 assetUrl 口径一致', () => {
  const out = injectAdminAssetVersion(readEntry(), V.toUpperCase())
  assert.ok(out.includes(`?v=${V}`), '版本未转成小写')
})

test('前台 assetUrl 不受后台注入逻辑影响', () => {
  setAssetVersion(V)
  try {
    assert.equal(assetUrl('/site.js'), `/site.js?v=${V}`)
    assert.equal(assetUrl('/site.js?a=1'), `/site.js?a=1&v=${V}`)
  } finally {
    setAssetVersion('')
  }
  assert.equal(assetUrl('/site.js'), '/site.js')
})

test('版本路径清单覆盖后台三件套，且适配层与清单同源（防两处列表漂移）', () => {
  for (const p of ['/admin/app.js', '/admin/editor.js', '/admin/emoji.js', '/site.js', '/share-card.js']) {
    assert.ok((VERSIONED_ASSET_PATHS as readonly string[]).includes(p), `清单缺少 ${p}`)
  }
  // 适配层若改成硬编码文件名，哈希输入的集合就可能与 immutable 白名单不一致：
  // 白名单里的拿不到哈希、或哈希覆盖的文件拿不到不可变缓存。这里守住「只有一个来源」。
  const server = fs.readFileSync(new URL('../docker-poc/server.ts', import.meta.url), 'utf8')
  assert.match(server, /for \(const p of VERSIONED_ASSET_PATHS\)/, '哈希输入未使用共享清单')
  assert.match(server, /VERSIONED_ASSET_PATHS as readonly string\[\]\)\.includes\(decoded\)/, 'immutable 白名单未使用共享清单')
})
