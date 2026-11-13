import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bufferPostText,
  cleanServerPluginConfig,
  fireBackupCompleted,
  fireCommentCreated,
  firePostDeleted,
  firePostPublished,
  firePostUpdated,
  fireWeiboDeleted,
  fireWeiboPublished,
  listServerPlugins,
  pluginConfig,
  plazaSign,
  renderFooterHtml,
} from '../src/hooks.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'
import type { Env, SettingsMap } from '../src/types.ts'

// ── 服务端插件钩子（roadmap A5）：总线过滤 + 官方示例插件行为 + 失败吞掉 ──

const settings = (over: Partial<SettingsMap>): SettingsMap => ({ ...DEFAULT_SETTINGS, ...over })

/** getSettings 只用 prepare().all()，桩掉整个 D1（注意包一层 Env：fire 函数取 env.DB） */
function fakeEnv(rows: { key: string; value: string }[] = []): Env {
  return {
    DB: { prepare: () => ({ all: async () => ({ results: rows }) }) } as unknown as D1Database,
  } as unknown as Env
}

/** 抓 fetch 调用（示例插件全部走 fetch 外发） */
function captureFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = orig
    },
  }
}

test('页脚注入：footerHtmlCode 进页脚，停用名单可关掉', () => {
  const s = settings({ footerHtmlCode: '<div class="badge">🌙 365 天</div>' })
  assert.equal(renderFooterHtml(s), '<div class="badge">🌙 365 天</div>')
  const off = settings({ footerHtmlCode: '<div>x</div>', serverPluginsDisabled: 'footer-html' })
  assert.equal(renderFooterHtml(off), '')
  // 其他插件被停用不影响 footer-html
  const otherOff = settings({ footerHtmlCode: '<i>hi</i>', serverPluginsDisabled: 'tg-channel,comment-webhook' })
  assert.equal(renderFooterHtml(otherOff), '<i>hi</i>')
  assert.equal(renderFooterHtml(settings({})), '')
})

test('发布同步 TG 频道：token+频道ID 齐才发，消息带标题与链接，可被停用', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'telegramBotToken', value: 'tok123' },
      { key: 'tgChannelChatId', value: '@mychannel' },
      { key: 'siteUrl', value: 'https://blog.example.com/' },
    ])
    await firePostPublished(env, { slug: 'hello', title: '新文章', summary: '摘要', via: 'scheduler' })
    assert.equal(cap.calls.length, 1)
    assert.match(cap.calls[0].url, /api\.telegram\.org\/bottok123\/sendMessage/)
    const body = JSON.parse(String(cap.calls[0].init?.body))
    assert.equal(body.chat_id, '@mychannel')
    assert.match(body.text, /新文章/)
    assert.match(body.text, /https:\/\/blog\.example\.com\/post\/hello/)
    // 频道 ID 未填：静默不发
    await firePostPublished(fakeEnv([{ key: 'telegramBotToken', value: 'tok123' }]), {
      slug: 'x', title: 't', summary: '', via: 'admin',
    })
    // 插件被停用：不发
    await firePostPublished(
      fakeEnv([
        { key: 'telegramBotToken', value: 'tok123' },
        { key: 'tgChannelChatId', value: '@mychannel' },
        { key: 'serverPluginsDisabled', value: 'tg-channel' },
      ]),
      { slug: 'x', title: 't', summary: '', via: 'admin' }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('微博同步 Buffer：key+渠道齐才发，mode=shareNow，站内图拼 siteUrl，可被停用', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'bufferAccessToken', value: 'bf-tok' },
      { key: 'bufferChannelId', value: 'chan1' },
      { key: 'siteUrl', value: 'https://blog.example.com/' },
    ])
    await fireWeiboPublished(env, { id: 7, content: '随手记 #随拍#', images: ['/images/a.jpg', 'https://cdn.example.com/b.png'], via: 'admin' })
    assert.equal(cap.calls.length, 1)
    assert.equal(cap.calls[0].url, 'https://api.buffer.com')
    assert.equal(cap.calls[0].init?.headers && (cap.calls[0].init.headers as Record<string, string>)['authorization'], 'Bearer bf-tok')
    const body = JSON.parse(String(cap.calls[0].init?.body))
    const input = body.variables.input
    assert.equal(input.channelId, 'chan1')
    assert.equal(input.mode, 'shareNow')
    assert.equal(input.schedulingType, 'automatic')
    assert.equal(input.text, '随手记 #随拍')
    assert.deepEqual(input.assets, [
      { image: { url: 'https://blog.example.com/images/a.jpg' } },
      { image: { url: 'https://cdn.example.com/b.png' } },
    ])
    // key 或渠道未填：静默不发
    await fireWeiboPublished(fakeEnv([{ key: 'bufferAccessToken', value: 'bf-tok' }]), { id: 1, content: 'x', images: [], via: 'admin' })
    // 插件被停用：不发
    await fireWeiboPublished(
      fakeEnv([
        { key: 'bufferAccessToken', value: 'bf-tok' },
        { key: 'bufferChannelId', value: 'chan1' },
        { key: 'serverPluginsDisabled', value: 'buffer-sync' },
      ]),
      { id: 1, content: 'x', images: [], via: 'admin' }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('微博同步 Buffer：MutationError 不抛出（fire 正常 resolve），无图不带 assets', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { createPost: { message: 'LinkedIn posts cannot exceed 3000 characters.' } } }), {
      status: 200,
    })) as typeof fetch
  try {
    const env = fakeEnv([
      { key: 'bufferAccessToken', value: 'bf-tok' },
      { key: 'bufferChannelId', value: 'chan1' },
    ])
    await fireWeiboPublished(env, { id: 2, content: '纯文字', images: [], via: 'draft' })
  } finally {
    globalThis.fetch = orig
  }
})

test('bufferPostText：话题 #xx# 转 #xx，超 270 码点截断（emoji 不破代理对）', () => {
  assert.equal(bufferPostText('今天天气不错 #随拍#'), '今天天气不错 #随拍')
  // 与站内 extractWeiboTopics 同上限：≤24 字的话题转换，>24 字的 #xx# 原样保留
  assert.equal(bufferPostText(`#${'长'.repeat(24)}#正文`), `#${'长'.repeat(24)}正文`)
  assert.equal(bufferPostText(`#${'长'.repeat(25)}#`), `#${'长'.repeat(25)}#`)
  const long = '好'.repeat(300)
  const cut = bufferPostText(long)
  assert.equal([...cut].length, 270)
  // 270 码点边界不截断；emoji 逐码点数（😀 记 1 个码点）
  assert.equal(bufferPostText('好'.repeat(270)), '好'.repeat(270))
  assert.equal([...bufferPostText('😀'.repeat(280))].length, 270)
})

test('评论 webhook：合法地址才 POST JSON（含事件名与留言内容）', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([{ key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' }])
    await fireCommentCreated(env, {
      kind: 'post', nickname: '小吴', content: '写得真好', context: '某文章', url: 'https://blog.example.com/post/a#comments', pending: false,
    })
    assert.equal(cap.calls.length, 1)
    assert.equal(cap.calls[0].url, 'https://hook.example.com/feed')
    const body = JSON.parse(String(cap.calls[0].init?.body))
    assert.equal(body.event, 'comment.created')
    assert.equal(body.nickname, '小吴')
    assert.equal(body.content, '写得真好')
    // 地址不合法 / 插件停用：不发
    await fireCommentCreated(fakeEnv([{ key: 'commentWebhookUrl', value: 'javascript:alert(1)' }]), {
      kind: 'guestbook', nickname: 'a', content: 'b', url: '', pending: true,
    })
    await fireCommentCreated(
      fakeEnv([
        { key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' },
        { key: 'serverPluginsDisabled', value: 'comment-webhook' },
      ]),
      { kind: 'guestbook', nickname: 'a', content: 'b', url: '', pending: true }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('插件失败被吞掉：fetch 抛错时 fire 正常 resolve，不影响主流程', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  try {
    const env = fakeEnv([
      { key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' },
      { key: 'telegramBotToken', value: 'tok' },
      { key: 'tgChannelChatId', value: '@ch' },
    ])
    await fireCommentCreated(env, { kind: 'weibo', nickname: 'a', content: 'b', url: '', pending: false })
    await firePostPublished(env, { slug: 'a', title: 'b', summary: '', via: 'admin' })
  } finally {
    globalThis.fetch = orig
  }
})

test('注册表元数据：id/标题/版本齐全，不带处理函数，id 全部合法（可进停用名单）', () => {
  const list = listServerPlugins()
  assert.ok(list.length >= 3)
  for (const p of list) {
    assert.ok(p.id && p.title && p.version && p.author)
    assert.match(p.id, /^[A-Za-z0-9_-]+$/)
    assert.equal('onPostPublished' in p, false)
    assert.equal('onCommentCreated' in p, false)
    assert.equal('footerHtml' in p, false)
  }
})

// ── 出站 Webhook ──

const OUTBOUND_URL = 'https://hooks.example/x'

function outboundRows(extra: Record<string, string> = {}): { key: string; value: string }[] {
  return [
    { key: 'serverPluginConfig', value: JSON.stringify({ 'outbound-webhook': { url: OUTBOUND_URL, ...extra } }) },
    ...Object.entries(extra)
      .filter(([k]) => k !== 'url')
      .map(([k, v]) => ({ key: k, value: v })),
  ]
}


test('出站 Webhook：四类新事件全通——post_updated / post_deleted / weibo_deleted / backup_completed', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv(outboundRows())
    await firePostUpdated(env, { slug: 'hello', title: '改过的文章', via: 'admin' })
    await firePostDeleted(env, { slug: 'hello', title: '删掉的文章', via: 'admin' })
    await fireWeiboDeleted(env, { id: 42, via: 'admin' })
    await fireBackupCompleted(env, { key: 'backups/xwblog-2026-10-16.json', bytes: 1234, tables: 9, at: 1760000000000 })
    assert.equal(cap.calls.length, 4)
    const events = cap.calls.map((c) => (JSON.parse(String(c.init?.body)) as { event: string }).event)
    assert.deepEqual(events, ['post_updated', 'post_deleted', 'weibo_deleted', 'backup_completed'])
    for (const c of cap.calls) {
      assert.equal(c.url, OUTBOUND_URL)
      const body = JSON.parse(String(c.init?.body)) as { site: string; data: Record<string, unknown> }
      assert.equal(body.site, DEFAULT_SETTINGS.siteName)
    }
    const backupBody = JSON.parse(String(cap.calls[3].init?.body)) as { data: { key: string; bytes: number } }
    assert.equal(backupBody.data.key, 'backups/xwblog-2026-10-16.json')
    assert.equal(backupBody.data.bytes, 1234)
  } finally {
    cap.restore()
  }
})

test('出站 Webhook：未配置 / 无 url / 非公网地址不外发；停用名单可关', async () => {
  const cap = captureFetch()
  try {
    assert.equal(cap.calls.length, 0)
    await firePostUpdated(fakeEnv([]), { slug: 'x', title: 'y', via: 'admin' })
    await firePostUpdated(fakeEnv([{ key: 'serverPluginConfig', value: 'dirty{{{' }]), { slug: 'x', title: 'y', via: 'admin' })
    await firePostUpdated(
      fakeEnv([{ key: 'serverPluginConfig', value: JSON.stringify({ 'outbound-webhook': { url: 'http://insecure.example/x' } }) }]),
      { slug: 'x', title: 'y', via: 'admin' }
    )
    await firePostUpdated(
      fakeEnv([{ key: 'serverPluginConfig', value: JSON.stringify({ 'outbound-webhook': { url: 'https://192.168.1.1/hook' } }) }]),
      { slug: 'x', title: 'y', via: 'admin' }
    )
    assert.equal(cap.calls.length, 0, '内网地址一律不发（SSRF 防线）')
    // 停用后不外发
    const env = fakeEnv([{ key: 'serverPluginConfig', value: JSON.stringify({ 'outbound-webhook': { url: OUTBOUND_URL } }) }, { key: 'serverPluginsDisabled', value: 'outbound-webhook' }])
    await firePostUpdated(env, { slug: 'x', title: 'y', via: 'admin' })
    assert.equal(cap.calls.length, 0)
  } finally {
    cap.restore()
  }
})

test('出站 Webhook：事件清单写脏（含坏项）整份拒发，不放大成全事件外推（失败关闭）', async () => {
  const cap = captureFetch()
  try {
    // 合法清单里混一个错拼 → 整份配置按失效处理：一个事件都不发（历史上会被当成「不过滤」全发）
    const env = fakeEnv(outboundRows({ events: 'post_published,nope_event' }))
    await firePostPublished(env, { slug: 'a', title: 'b', summary: '', via: 'admin' })
    await firePostUpdated(env, { slug: 'a', title: 'b', via: 'admin' })
    await fireBackupCompleted(env, { key: 'k', bytes: 1, tables: 1, at: 1 })
    assert.equal(cap.calls.length, 0, '坏清单拒发，别退化成「全部放行」')
    // 留空仍是「全部放行」（三态里的 'all' 不受影响）
    const all = fakeEnv(outboundRows())
    await firePostUpdated(all, { slug: 'a', title: 'b', via: 'admin' })
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

// ── 插件配置通道：pluginConfig 读取 + cleanServerPluginConfig 净化校验 ──

test('pluginConfig：脏 JSON / 非对象 / 值非字符串一律当没配；正常读出字符串键值', () => {
  assert.deepEqual(pluginConfig(settings({}), 'outbound-webhook'), {})
  assert.deepEqual(pluginConfig(settings({ serverPluginConfig: 'dirty' }), 'outbound-webhook'), {})
  assert.deepEqual(pluginConfig(settings({ serverPluginConfig: '[1]' }), 'outbound-webhook'), {})
  assert.deepEqual(pluginConfig(settings({ serverPluginConfig: '{"outbound-webhook":"str"}' }), 'outbound-webhook'), {})
  assert.deepEqual(pluginConfig(settings({ serverPluginConfig: '{"outbound-webhook":{"url":"https://x","n":1}}' }), 'outbound-webhook'), {
    url: 'https://x',
  })
})

test('cleanServerPluginConfig：合法配置规范化、未知插件/字段拒绝、非字符串拒绝、空命名空间清除', () => {
  const ok = cleanServerPluginConfig(JSON.stringify({ 'outbound-webhook': { url: 'https://hooks.example/x', events: 'post_published' } }))
  assert.ok(ok.ok)
  assert.deepEqual(JSON.parse(ok.value), { 'outbound-webhook': { url: 'https://hooks.example/x', events: 'post_published' } })
  // 空配置/空命名空间
  assert.equal(cleanServerPluginConfig('')!.ok && cleanServerPluginConfig('')!.value, '')
  const emptyNs = cleanServerPluginConfig(JSON.stringify({ 'outbound-webhook': {} }))
  assert.ok(emptyNs.ok && emptyNs.value === '', '空对象 = 清除')
  // 非法形态
  assert.equal(cleanServerPluginConfig('not json').ok, false)
  assert.equal(cleanServerPluginConfig('[]').ok, false)
  assert.equal(cleanServerPluginConfig(JSON.stringify({ 'nope-plugin': { url: 'https://x' } })).ok, false, '未注册插件 id')
  assert.equal(
    cleanServerPluginConfig(JSON.stringify({ 'outbound-webhook': { nope: 'x' } })).ok,
    false,
    '未登记配置字段'
  )
  assert.equal(cleanServerPluginConfig(JSON.stringify({ 'outbound-webhook': { url: 123 } })).ok, false, '值必须字符串')
  assert.equal(cleanServerPluginConfig(JSON.stringify({ 'outbound-webhook': { url: 'x'.repeat(2001) } })).ok, false, '单值 ≤ 2000')
})

test('cleanServerPluginConfig：configValidate 语义校验生效——坏 webhook 地址报错文案可读', () => {
  const bad = cleanServerPluginConfig(JSON.stringify({ 'outbound-webhook': { url: 'ftp://x' } }))
  assert.equal(bad.ok, false)
  assert.ok(bad.ok === false && bad.error.includes('https'), '错误文案指明要公网 https 地址')
  const lan = cleanServerPluginConfig(JSON.stringify({ 'outbound-webhook': { url: 'https://192.168.1.3/hook' } }))
  assert.equal(lan.ok, false, '内网地址过不了 fetchableUrl')
  const badEvents = cleanServerPluginConfig(JSON.stringify({ 'outbound-webhook': { url: 'https://x.example/h', events: 'nope' } }))
  assert.equal(badEvents.ok, false)
})

test('IndexNow 插件：密钥 + 站点地址齐才提交，URL/key/keyLocation 三件套齐全，未配置零外发', async () => {
  const cap = captureFetch()
  try {
    // 密钥（serverPluginConfig.indexnow.key）+ 站点地址齐：发布 / 编辑 / 软删各提交一条
    const env = fakeEnv([
      { key: 'siteUrl', value: 'https://blog.example.com/' },
      { key: 'serverPluginConfig', value: JSON.stringify({ indexnow: { key: 'a1b2c3d4e5' } }) },
    ])
    await firePostPublished(env, { slug: 'hello', title: '新文章', summary: '', via: 'admin' })
    assert.equal(cap.calls.length, 1)
    assert.ok(cap.calls[0].url.startsWith('https://api.indexnow.org/indexnow?'))
    const u = new URL(cap.calls[0].url)
    assert.equal(u.searchParams.get('url'), 'https://blog.example.com/post/hello')
    assert.equal(u.searchParams.get('key'), 'a1b2c3d4e5')
    assert.equal(u.searchParams.get('keyLocation'), 'https://blog.example.com/indexnow-key.txt')

    await firePostUpdated(env, { slug: 'hello', title: '新文章', via: 'admin' })
    await firePostDeleted(env, { slug: 'hello', title: '新文章', via: 'admin' })
    assert.equal(cap.calls.length, 3)

    // 密钥缺失 / 形态不对：零外发
    cap.calls.length = 0
    const noKey = fakeEnv([{ key: 'siteUrl', value: 'https://blog.example.com' }])
    await firePostPublished(noKey, { slug: 'hello', title: 'T', summary: '', via: 'admin' })
    const badKey = fakeEnv([
      { key: 'siteUrl', value: 'https://blog.example.com' },
      { key: 'serverPluginConfig', value: JSON.stringify({ indexnow: { key: 'zzzz' } }) },
    ])
    await firePostPublished(badKey, { slug: 'hello', title: 'T', summary: '', via: 'admin' })
    // 站点地址未配置：拼不出绝对 URL，静默跳过
    const noBase = fakeEnv([{ key: 'serverPluginConfig', value: JSON.stringify({ indexnow: { key: 'a1b2c3d4e5' } }) }])
    await firePostPublished(noBase, { slug: 'hello', title: 'T', summary: '', via: 'admin' })
    assert.equal(cap.calls.length, 0, '未配置态零外发')
  } finally {
    cap.restore()
  }
})

test('IndexNow 插件：configValidate 拒绝非十六进制密钥；停用名单可关掉', async () => {
  const bad = cleanServerPluginConfig(JSON.stringify({ indexnow: { key: 'xyz!!!' } }))
  assert.equal(bad.ok, false)
  assert.ok(bad.ok === false && bad.error.includes('十六进制'))
  const ok = cleanServerPluginConfig(JSON.stringify({ indexnow: { key: 'A1B2C3D4E5F60718293A4B5C6D7E8F90' } }))
  assert.equal(ok.ok, true)

  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'siteUrl', value: 'https://blog.example.com' },
      { key: 'serverPluginsDisabled', value: 'indexnow' },
      { key: 'serverPluginConfig', value: JSON.stringify({ indexnow: { key: 'a1b2c3d4e5' } }) },
    ])
    await firePostPublished(env, { slug: 'hello', title: 'T', summary: '', via: 'admin' })
    assert.equal(cap.calls.length, 0, '停用后零外发')
  } finally {
    cap.restore()
  }
})
