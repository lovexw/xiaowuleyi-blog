import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assetUrl, assetVersion, setAssetVersion } from '../src/assets.ts'
import { page } from '../src/render.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'

/* 前台 JS 内容寻址版本（2026-11）：治「改完前端必须 Cmd+Shift+R / 手动 Purge」。
 * 版本随文件内容变 → URL 变 → 浏览器必然重新下载；内容不变 → URL 稳定 → 可吃一年长缓存。
 * 这些断言同时守住两端：无版本时（Workers 形态 / 老 HTML 边缘副本）必须原样兼容。 */

const settings = { ...DEFAULT_SETTINGS, siteName: '示例站', siteUrl: 'https://blog.example.com' }
const base = { settings, css: '', title: '文', path: '/', body: '' }
const HASH = 'a1b2c3d4e5f6'

after(() => setAssetVersion(''))

test('assetUrl：无版本时原样返回（Workers 形态 / 老 HTML 兼容）', () => {
  setAssetVersion('')
  assert.equal(assetVersion(), '')
  assert.equal(assetUrl('/site.js'), '/site.js')
  const html = page({ ...base })
  assert.ok(html.includes('<script src="/site.js" defer></script>'))
  assert.ok(!html.includes('data-av='))
})

test('assetUrl：合法版本拼 ?v=；非法输入一律退回无版本', () => {
  setAssetVersion(HASH)
  assert.equal(assetVersion(), HASH)
  assert.equal(assetUrl('/site.js'), `/site.js?v=${HASH}`)
  assert.equal(assetUrl('/share-card.js?x=1'), `/share-card.js?x=1&v=${HASH}`)
  // 这个值会拼进 HTML 属性与 URL，绝不能收带引号 / 路径分隔符的外部输入
  for (const bad of ['"><script>', 'abc/def', '../../x', 'zzzzzzzzzzzz', '']) {
    setAssetVersion(bad)
    assert.equal(assetVersion(), '', `非法版本应被拒绝：${bad}`)
  }
})

test('page()：script URL 带内容版本，并把版本放进 <html data-av> 供按需加载复用', () => {
  setAssetVersion(HASH)
  const html = page({ ...base })
  assert.ok(html.includes(`<script src="/site.js?v=${HASH}" defer></script>`))
  assert.ok(html.includes(`data-av="${HASH}"`))
  assert.ok(!html.includes('<script src="/site.js" defer>'))
})

test('内容变 → URL 变；内容不变 → URL 稳定', () => {
  setAssetVersion(HASH)
  const a = assetUrl('/site.js')
  setAssetVersion('f6e5d4c3b2a1')
  const b = assetUrl('/site.js')
  assert.notEqual(a, b, '部署后必须换 URL，否则浏览器不会重新下载')
  setAssetVersion(HASH)
  assert.equal(assetUrl('/site.js'), a, '同一版本必须稳定，才能吃长缓存')
})

test('site.js：按需加载的 share-card.js 复用同一版本，不留裸路径', () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  assert.ok(src.includes("var AV = document.documentElement.getAttribute('data-av') || ''"))
  assert.ok(src.includes('function avUrl(p)'))
  assert.equal((src.match(/import\(avUrl\('\/share-card\.js'\)\)/g) || []).length, 2)
  assert.ok(!src.includes("import('/share-card.js')"), '仍有裸路径会拿到浏览器缓存里的旧分享卡片')
})

test('server.ts：只对「当前」版本给一年 immutable，且版本在启动时算', () => {
  const src = readFileSync(new URL('../docker-poc/server.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('computeAssetVersion'))
  assert.ok(src.includes('v === assetVersion()'), '随便拼 ?v=x 不该被永久缓存')
  assert.ok(src.includes("'public, max-age=31536000, immutable'"))
})

test('_headers：无版本的兜底仍是 1 小时，不能被误改成永久缓存', () => {
  const h = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
  assert.ok(/\/site\.js\s*\n\s*Cache-Control: public, max-age=3600/.test(h))
})

test('deploy-oracle.sh：清缓存钩子挂在部署成功之后，失败不影响部署', () => {
  const sh = readFileSync(new URL('../scripts/deploy-oracle.sh', import.meta.url), 'utf8')
  assert.ok(sh.includes('purge_edge_cache'))
  assert.ok(sh.includes('不影响本次部署'))
  assert.ok(/log "部署成功[\s\S]{0,200}purge_edge_cache/.test(sh))
})
