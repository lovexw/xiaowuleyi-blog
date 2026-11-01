import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCommentGate,
  canReplyGatedComment,
  commentGateContext,
  commentGateMoreText,
  commentGateRank,
  commentGateText,
  commentGateViewerRank,
  threadRootTier,
  type GateTierComment,
} from '../src/commentgate.ts'
import { parseMemberTiers } from '../src/tiers.ts'
import { commentsHtml } from '../src/render.ts'

// 评论圈层可见（会员档位门控评论）：注册会员与游客的评论对所有人可见；门槛档位及以上的
// 会员评论只对同档及以上会员与管理员可见——游客与低档会员只看到占位块，正文一律不下发

const defs = parseMemberTiers('') // 默认三档：注册会员(1) / 优质会员(2) / 咖啡会员(3)
const now = 1_700_000_000_000
// 门槛取「优质会员」（rank 2）：优质与咖啡两档的评论都进私密圈，注册会员与游客看不到
const ctx = (viewerRank: number, gateRank = 2, admin = false) => ({ defs, gateRank, viewerRank, admin, now })

const c = (over: Partial<GateTierComment> & { id: number }): GateTierComment => ({
  parent_id: 0,
  is_admin: 0,
  member_tier: '',
  member_tier_expires_at: null,
  ...over,
})

test('门槛档位：关闭写法一律 0；合法 key 取等级；失效 key 按最严口径 1', () => {
  for (const off of ['', '0', 'off', 'all', null, undefined, '  ']) assert.equal(commentGateRank(defs, off as string), 0)
  assert.equal(commentGateRank(defs, 'normal'), 1)
  assert.equal(commentGateRank(defs, 'premium'), 2)
  assert.equal(commentGateRank(defs, 'coffee'), 3)
  // 站长把档位删了 / 换了 key（含退役老键 top）：宁严勿松——静默放开等于把私密评论一次性公开
  assert.equal(commentGateRank(defs, 'deleted-tier'), 1)
})

test('读者等级：游客 0，会员取生效档位，过期降到 fallback 档而非基础档', () => {
  assert.equal(commentGateViewerRank(defs, null, now), 0)
  assert.equal(commentGateViewerRank(defs, { tier: 'coffee', tier_expires_at: null }, now), 3)
  // 过期咖啡会员 → 优质会员（rank 2，不碰 members.tier 原值）
  assert.equal(commentGateViewerRank(defs, { tier: 'coffee', tier_expires_at: now - 1 }, now), 2)
  // 脏档位（定义里没有）→ 基础档
  assert.equal(commentGateViewerRank(defs, { tier: 'ghost', tier_expires_at: null }, now), 1)
})

test('可见矩阵：游客与低档会员遮罩，同档及以上与管理员全见（含游客/注册会员评论永不遮）', () => {
  const rows = [
    c({ id: 1 }), // 游客评论
    c({ id: 2, member_tier: 'normal' }), // 注册会员
    c({ id: 3, member_tier: 'premium' }), // 优质会员
    c({ id: 4, member_tier: 'coffee' }), // 咖啡会员
    c({ id: 5, is_admin: 1, nickname: '作者' }), // 管理员发言
  ]

  const guest = applyCommentGate(rows, ctx(0))
  assert.deepEqual(guest.map((r) => !!r.gated), [false, false, true, true, false], '游客：优质及以上被遮')
  assert.equal(guest[2].content, '', '遮罩项正文必须被服务端清空')
  assert.equal(guest[2].gate_tier_name, '优质会员', '占位块要带作者档位名')

  const normal = applyCommentGate(rows, ctx(1))
  assert.deepEqual(normal.map((r) => !!r.gated), [false, false, true, true, false], '注册会员同样只看得见公开评论')

  const premium = applyCommentGate(rows, ctx(2))
  assert.deepEqual(premium.map((r) => !!r.gated), [false, false, false, true, false], '优质会员看不到咖啡会员的评论（只有同档及以上可见）')

  const coffee = applyCommentGate(rows, ctx(3))
  assert.ok(coffee.every((r) => !r.gated), '咖啡会员同档及以上全见')

  const admin = applyCommentGate(rows, ctx(0, 2, true))
  assert.ok(admin.every((r) => !r.gated), '管理员无视一切遮罩')
})

test('门槛关闭 / 门槛为基础档：一个不遮，或所有会员评论仅会员可见', () => {
  const rows = [c({ id: 1 }), c({ id: 2, member_tier: 'normal' }), c({ id: 3, member_tier: 'coffee' })]
  assert.ok(applyCommentGate(rows, ctx(0, 0)).every((r) => !r.gated), '关闭 = 与历史版本一致')
  const strict = applyCommentGate(rows, ctx(0, 1))
  assert.deepEqual(strict.map((r) => !!r.gated), [false, true, true], '门槛=基础档时游客看不到任何会员评论')
})

test('父级遮罩向下继承：私密线程里的回复一并遮，且折叠计数写在根上', () => {
  const rows = [
    c({ id: 10, member_tier: 'coffee' }),
    c({ id: 11, parent_id: 10, member_tier: 'premium' }), // 楼中楼回复（低一档也一并遮）
    c({ id: 12, parent_id: 10, is_admin: 1 }), // 管理员在这个楼里的回复
    c({ id: 13, member_tier: 'normal' }), // 另一个楼层的公开评论
  ]
  const out = applyCommentGate(rows, ctx(0))
  assert.deepEqual(out.map((r) => !!r.gated), [true, true, true, false], '私密线程里连管理员回复也不外露')
  assert.equal(out[0].gate_hidden, 2, '根上折叠 2 条回复')
  assert.equal(out[1].content, '')
})

test('过期会员的历史评论随档位降级放行（读侧判定，无回填）', () => {
  const rows = [c({ id: 1, member_tier: 'coffee', member_tier_expires_at: now - 1 })]
  // 门槛设在咖啡档（产品默认）时：过期降为优质会员后低于门槛，评论重新公开
  const out = applyCommentGate(rows, ctx(0, 3))
  assert.equal(out[0].gated, undefined, '咖啡会员到期降到优质会员，低于咖啡门槛，评论不再进私密圈')
})

test('回复权限：只有同档及以上会员与管理员能进私密楼', () => {
  const root = threadRootTier(defs, { id: 1, member_tier: 'coffee' }, now)
  assert.equal(root.rank, 3)
  assert.equal(canReplyGatedComment(0, false, root, 3), false, '游客不能回复（写侧另有登录校验）')
  assert.equal(canReplyGatedComment(1, false, root, 3), false, '注册会员不能回复咖啡会员的评论')
  assert.equal(canReplyGatedComment(2, false, root, 3), false, '优质会员也不能回复咖啡会员的评论')
  assert.equal(canReplyGatedComment(3, false, root, 3), true, '同档可以回复')
  assert.equal(canReplyGatedComment(0, true, root, 3), true, '管理员始终可以回复')
  // 公开楼（游客 / 注册会员的评论）谁都能回（登录会员内）
  const open = threadRootTier(defs, { id: 2 }, now)
  assert.equal(canReplyGatedComment(1, false, open, 3), true)
  // 门槛关闭时不做任何限制
  assert.equal(canReplyGatedComment(1, false, root, 0), true)
})

test('占位块文案：中文口径固定，游客提示登录、会员提示升级', () => {
  assert.deepEqual(commentGateText('咖啡会员', 0), { title: '这条评论仅对咖啡会员及以上可见', hint: '登录会员后可见' })
  assert.deepEqual(commentGateText('咖啡会员', 1), { title: '这条评论仅对咖啡会员及以上可见', hint: '升级档位后可见' })
  assert.match(commentGateText('咖啡会员', 0, true).title, /Only 咖啡会员 members and above/)
  assert.match(commentGateMoreText('咖啡会员', 3), /另有 3 条回复/)
  assert.match(commentGateMoreText('coffee', 1, true), /1 more reply/)
})

test('context 组装器：关闭档位下 viewerRank 照算，gateRank 0', () => {
  const g = commentGateContext(defs, '0', { tier: 'coffee', tier_expires_at: null }, false, now)
  assert.equal(g.gateRank, 0)
  assert.equal(g.viewerRank, 3)
  assert.equal(g.admin, false)
})

// SSR 渲染守卫：遮罩项在 HTML 里既没有正文也没有回复键（服务端截断，不做前端遮挡）
test('commentsHtml：遮罩项出占位块、正文与回复键都不在 HTML 里', () => {
  const base = {
    id: 1,
    post_id: 1,
    weibo_id: 0,
    parent_id: 0,
    is_admin: 0,
    nickname: '小林',
    email: '',
    website: '',
    content: '这是只有圈内人看得到的私密内容',
    status: 'approved' as const,
    ip: '',
    created_at: now,
  }
  const rows = [
    { ...base, id: 1, member_tier: 'coffee' as const },
    { ...base, id: 2, nickname: '路过的游客', content: '公开评论' },
    { ...base, id: 3, parent_id: 1, member_tier: 'coffee' as const, content: '楼里的回复' },
  ]
  const gated = applyCommentGate(rows, ctx(0))
  const html = commentsHtml({ comments: gated, slug: 'hello', allowComments: true, count: 3, memberName: '某会员', gateViewerRank: 0 })

  assert.ok(!html.includes('这是只有圈内人看得到的私密内容'), '遮罩项正文绝不能出现在 HTML 里')
  assert.ok(!html.includes('楼里的回复'), '遮罩楼里的回复同样不能出现')
  assert.ok(!html.includes('data-reply="1"'), '遮罩项不给回复键（登录会员也不给）')
  assert.ok(html.includes('这条评论仅对咖啡会员及以上可见'), '占位块文案')
  assert.ok(html.includes('登录会员后可见'), '游客看到登录引导')
  assert.ok(html.includes('另有 1 条回复'), '被折叠的回复数')
  assert.ok(html.includes('公开评论'), '公开评论照常渲染')
  assert.ok(html.includes('cmt-badge'), '昵称与档位徽标照常露出（知道圈子里有谁在聊）')
})
