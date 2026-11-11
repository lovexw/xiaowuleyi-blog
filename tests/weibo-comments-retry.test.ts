import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* 微博折叠评论「加载失败可重试」回归（2026-11-04）
 * 线上现象：评论区一直显示「评论加载失败，稍后再试」，但服务端接口 200 + 合法 JSON。
 * 根因是展开时先打 dataset.loaded = '1'，一次瞬时失败（容器重建 / 跨境抖动 /
 * 隐私插件拦请求）就永久卡住，收起再展开也不重拉，只能刷新整页。
 * 这里把 site.js 的 loadWeiboComments 切片在 Node 里执行，验证重试语义。 */

const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
const seg = src.slice(
  src.indexOf('function loadWeiboComments'),
  src.indexOf('// 展开 / 收起（首次展开时拉取评论）')
)
assert.ok(seg.includes('function loadWeiboComments') && seg.includes('wb-cmt-retry'), 'site.js 切片失败：重试段不在预期位置')

type Panel = {
  dataset: Record<string, string | undefined>
  getAttribute: (k: string) => string | null
  querySelector: (s: string) => { innerHTML: string }
}

function makePanel(): { panel: Panel; listEl: { innerHTML: string } } {
  const listEl = { innerHTML: '' }
  const panel: Panel = {
    dataset: {},
    getAttribute: (k) => (k === 'data-wb-cmt' ? '6907' : null),
    querySelector: () => listEl,
  }
  return { panel, listEl }
}

function compile(deps: {
  getJSON: () => Promise<unknown>
  authState: () => Promise<unknown>
  render: () => void
  setTimeout: (fn: () => void) => void
}): (panel: Panel, retried?: boolean) => void {
  // 注入切片外的闭包依赖；T 走中文路径返回原串
  const factory = new Function(
    'getJSON', 'authState', 'T', 'renderWeiboComments', 'setTimeout',
    seg + '\n;return loadWeiboComments'
  )
  return factory(deps.getJSON, deps.authState, (zh: string) => zh, deps.render, deps.setTimeout)
}

async function tick(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

const authState = () => Promise.resolve({ user: null })

test('成功：渲染后才打 loaded，loading 标记清掉，不会重复拉', async () => {
  let rendered = 0
  let calls = 0
  const { panel, listEl } = makePanel()
  const load = compile({
    getJSON: () => { calls++; return Promise.resolve({ comments: [{ id: 1 }] }) },
    authState,
    render: () => { rendered++ },
    setTimeout: () => {},
  })
  load(panel)
  load(panel) // 加载中并发调用：应由 loading 标记挡住
  await tick()
  assert.equal(rendered, 1, '应渲染一次评论列表')
  assert.equal(panel.dataset.loaded, '1', '成功才打 loaded')
  assert.equal(panel.dataset.loading, undefined, 'loading 要清掉')
  assert.equal(calls, 1, '加载中不应重复发请求')
  assert.ok(!/评论加载失败/.test(listEl.innerHTML), '成功时不显示失败提示')
  // 注意：函数内刻意不检查 loaded —— 提交评论成功后（site.js 1150 附近）要靠再次调用强制刷新列表，
  // 「已加载不再拉」由外层展开守卫负责，不能挪进函数里。
})

test('首次失败：自动重试一次后恢复，用户无感', async () => {
  let calls = 0
  let rendered = 0
  const { panel, listEl } = makePanel()
  const load = compile({
    getJSON: () => {
      calls++
      return calls === 1
        ? Promise.reject(new Error('瞬时抖动'))
        : Promise.resolve({ comments: [] })
    },
    authState,
    render: () => { rendered++ },
    // 让 700ms 重试同步发生，测试不必真等
    setTimeout: (fn) => fn(),
  })
  load(panel)
  await tick()
  assert.equal(calls, 2, '首次失败应自动重试一次')
  assert.equal(rendered, 1, '重试成功后正常渲染')
  assert.equal(panel.dataset.loaded, '1')
  assert.equal(panel.dataset.loading, undefined)
  assert.ok(!/评论加载失败/.test(listEl.innerHTML), '恢复后不该还挂着失败提示')
})

test('两次都失败：给「点击重试」按钮，且清掉标记让下次展开能重拉', async () => {
  let calls = 0
  const { panel, listEl } = makePanel()
  const load = compile({
    getJSON: () => { calls++; return Promise.reject(new Error('持续失败')) },
    authState,
    render: () => { throw new Error('不该渲染') },
    setTimeout: (fn) => fn(),
  })
  load(panel)
  await tick()
  assert.equal(calls, 2, '最多自动重试一次，不无限重试')
  assert.match(listEl.innerHTML, /评论加载失败，稍后再试/, '仍给出失败提示')
  assert.match(listEl.innerHTML, /wb-cmt-retry/, '必须给明确的重试入口')
  assert.match(listEl.innerHTML, /点击重试/, '重试按钮文案')
  assert.equal(panel.dataset.loaded, undefined, '失败不能留下 loaded，否则永久卡死')
  assert.equal(panel.dataset.loading, undefined, '失败要清 loading，否则连重试按钮都点不动')
  // 手工重试：接口恢复后应能成功
  let rendered = 0
  const recovered = compile({
    getJSON: () => Promise.resolve({ comments: [] }),
    authState,
    render: () => { rendered++ },
    setTimeout: () => {},
  })
  recovered(panel)
  await tick()
  assert.equal(rendered, 1, '点重试后能正常加载')
  assert.equal(panel.dataset.loaded, '1')
})

test('渲染函数自身抛错也会走重试链路，不再伪装成「加载失败」卡死', async () => {
  let calls = 0
  let rendered = 0
  const { panel, listEl } = makePanel()
  const load = compile({
    getJSON: () => { calls++; return Promise.resolve({ comments: [{ id: 1 }] }) },
    authState,
    render: () => { rendered++; if (rendered === 1) throw new Error('渲染异常') },
    setTimeout: (fn) => fn(),
  })
  load(panel)
  await tick()
  assert.equal(calls, 2, '渲染异常同样触发一次自动重试')
  assert.equal(panel.dataset.loaded, '1', '重试成功后标记成功')
  assert.ok(!/评论加载失败/.test(listEl.innerHTML))
})

test('评论加载失败给可点重试（不再只给一句灰字）', () => {
  assert.match(src, /评论加载失败/, '失败提示')
  assert.match(src, /点击重试/, '重试入口')
})
