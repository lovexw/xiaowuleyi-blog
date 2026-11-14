#!/usr/bin/env node
/**
 * 后台前端巡检（真浏览器）——补上单元测试与 node --check 都覆盖不到的那块。
 *
 * 为什么需要它：`node --check` 只查语法，`tsc --noEmit` 不含 public/；删代码时
 * 把「定义删了、引用留着」这类问题（ReferenceError: xxx is not defined）两样都查不出，
 * 但浏览器一打开就是白屏。2026-11-14 精简批次就踩过：membersSearchTimer / pageModal /
 * statsBtn / /admin/server-plugins 四处被误删，后台白屏 + 页面管理点不动。
 *
 * 做法：headless Chrome + CDP 打开后台，登录后遍历全部路由，收集
 * Runtime.exceptionThrown / console.error / 网络 4xx-5xx，有任何一条即非零退出。
 *
 * 用法：
 *   1) 另开一个终端跑 `npm run dev`（默认 8799 端口）
 *   2) 本地库需有夹具管理员 smokeadmin / smoke-pass-12345
 *      （先跑过一次 `npm run smoke` 即可，它会 seed）
 *   3) npm run ui:audit
 *
 * 没装 Chrome 的机器（比如 CI 容器）自动跳过，不拦流程。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.UI_AUDIT_PORT || 8799)
const BASE = `http://127.0.0.1:${PORT}`
const DEBUG_PORT = 9333
const PROFILE = join(tmpdir(), 'bloghao-ui-audit-profile')

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chromePath) {
  console.log('▸ 跳过：本机没有 Chrome / Chromium（后台巡检需要真浏览器）')
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 先确认 dev 服务在跑，比等 Chrome 起来再报错更清楚
try {
  await fetch(`${BASE}/admin/`, { signal: AbortSignal.timeout(4000) })
} catch {
  console.error(`▸ 连不上 ${BASE}：先另开一个终端跑 \`npm run dev\``)
  process.exit(1)
}

try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 首次运行没有目录 */ }

const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' })

async function getJson(path, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`)
      if (r.ok) return await r.json()
    } catch { /* Chrome 还没监听 */ }
    await sleep(200)
  }
  throw new Error('Chrome 启动超时')
}

await getJson('/json/version')
const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')) })

let seq = 0
const pending = new Map()
let label = '登录页'
const findings = []

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  const p = msg.params
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails
    findings.push({ label, kind: 'exception', text: d?.exception?.description || d?.text })
  } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
    findings.push({ label, kind: 'console.error', text: p.args.map((a) => a.value ?? a.description ?? a.type).join(' ') })
  } else if (msg.method === 'Log.entryAdded' && p.entry.level === 'error') {
    findings.push({ label, kind: 'net/log', text: `${p.entry.text} ${p.entry.url || ''}`.trim() })
  }
}

const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq
  pending.set(id, res)
  ws.send(JSON.stringify({ id, method, params }))
})

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const d = r.result
  if (d?.exceptionDetails) return { err: d.exceptionDetails.exception?.description || d.exceptionDetails.text }
  return { val: d?.result?.value }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')

console.log('\n▸ 后台前端巡检')

// 1. 未登录：登录页必须渲染出来（白屏即失败——这正是 2026-11-14 的事故形态）
await send('Page.navigate', { url: `${BASE}/admin/` })
await sleep(2500)
const loginLen = await ev(`document.getElementById('app').innerHTML.length`)
const hasLoginText = await ev(`/登录|密码|用户名/.test(document.body.innerText)`)
check('登录页渲染出内容（白屏检测）', (loginLen.val || 0) > 200, `#app ${loginLen.val} 字符`)
check('登录页含登录表单文案', !!hasLoginText.val)

// 2. 页面内登录，cookie 落在浏览器
label = '登录'
const loginStatus = await ev(
  `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:'smokeadmin',password:'smoke-pass-12345'})}).then(r=>r.status)`,
)
check('夹具管理员登录', loginStatus.val === 200, `HTTP ${loginStatus.val}`)

await send('Page.navigate', { url: `${BASE}/admin/` })
await sleep(2500)
const shellLen = await ev(`document.getElementById('app').innerHTML.length`)
check('登录后进入主界面', (shellLen.val || 0) > 5000, `#app ${shellLen.val} 字符`)

// 3. 遍历全部路由：每页渲染出内容且不产生新错误
const ROUTES = ['#/', '#/posts', '#/weibo', '#/comments', '#/media', '#/settings', '#/stats',
  '#/pages', '#/links', '#/appearance', '#/plugins', '#/trash', '#/editor/new', '#/posts?view=cats']

for (const route of ROUTES) {
  label = route
  const before = findings.length
  await ev(`location.hash = ${JSON.stringify(route)}`)
  await sleep(1200)
  const len = await ev(`document.getElementById('app').innerHTML.length`)
  const fresh = findings.length - before
  check(`路由 ${route}`, (len.val || 0) > 1000 && fresh === 0, `#app ${len.val} 字符${fresh ? `，新错误 ${fresh}` : ''}`)
}

// 4. 页面管理弹窗：pageModal 曾被误删，点「新建页面」直接 ReferenceError
label = '新建页面弹窗'
await ev(`location.hash = '#/pages'`)
await sleep(1200)
const clicked = await ev(`(function(){var b=document.getElementById('page-add'); if(!b) return 'no-btn'; b.click(); return 'ok'})()`)
await sleep(800)
const modalOpen = await ev(`!!document.querySelector('.modal-mask, .modal')`)
check('「新建页面」能弹出表单', clicked.val === 'ok' && !!modalOpen.val)

// 5. 编辑器：mountEditor 正常挂载（markDirty / 自动保存链路的地基）
label = '编辑器'
await ev(`location.hash = '#/editor/new'`)
await sleep(1500)
const editorReady = await ev(`!!document.getElementById('ed-editor') && !!document.getElementById('ed-title')`)
check('编辑器挂载完成', !!editorReady.val)

console.log('\n===== 运行时错误 =====')
if (!findings.length) {
  console.log('  无')
} else {
  for (const f of findings) console.log(`  - [${f.label}] ${f.kind}: ${String(f.text).split('\n')[0].slice(0, 300)}`)
}

ws.close()
chrome.kill('SIGKILL')

const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${failed ? '✗' : '✓'} 巡检结果：${results.length - failed}/${results.length} 通过${findings.length ? `，运行时错误 ${findings.length} 条` : ''}`)
process.exit(failed || findings.length ? 1 : 0)
