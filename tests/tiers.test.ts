import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  baseTier,
  canReadTiers,
  cleanMemberTiers,
  DEFAULT_MEMBER_TIERS,
  effectiveTier,
  minTierRank,
  parseMemberTiers,
  tierByKey,
  type MemberTierDef,
} from '../src/tiers'
import { canRead, normalizeMinTier } from '../src/points'

/* ── 会员档位体系（src/tiers.ts）：定义解析 / 到期降级 / 付费墙判定 ──
 * 默认三档 = 用户口径：注册会员 → 优质会员 → 咖啡会员（咖啡到期降优质） */

test('默认三档：注册会员 / 优质会员（永久） / 咖啡会员（限时，到期降优质）', () => {
  const defs = parseMemberTiers(null)
  assert.deepEqual(defs.map((d) => d.key), ['normal', 'premium', 'coffee'])
  assert.deepEqual(defs.map((d) => d.name), ['注册会员', '优质会员', '咖啡会员'])
  assert.deepEqual(defs.map((d) => d.permanent), [true, true, false])
  assert.equal(defs[2].fallback, 'premium', '咖啡会员到期降到优质会员，不是直接掉基础档')
  assert.deepEqual(defs.map((d) => d.rank), [1, 2, 3])
})

test('cleanMemberTiers：合法定义规整（rank 按序生成、颜色白名单、第一档必须永久）', () => {
  const cleaned = cleanMemberTiers([
    { key: 'normal', name: '注册会员', color: 'not-a-color', permanent: true, days: 365 },
    { key: 'coffee', name: '  咖啡会员  ', color: '#C9803E', permanent: false, days: 30 },
  ])
  assert.ok(cleaned)
  assert.equal(cleaned.length, 2)
  assert.equal(cleaned[0].rank, 1)
  assert.equal(cleaned[0].color, '', '非法颜色清空（不能流进 style 属性）')
  assert.equal(cleaned[0].days, 0, '永久档的 days 强制归零')
  assert.equal(cleaned[1].name, '咖啡会员', '名称 trim')
  assert.equal(cleaned[1].color, '#c9803e', '颜色小写归一')
  // 第一档不永久 → 整体拒绝（它是「过期/无档」的兜底身份）
  assert.equal(cleanMemberTiers([{ key: 'vip', name: 'VIP', permanent: false, days: 30 }]), null)
  assert.equal(cleanMemberTiers('nope'), null)
  assert.equal(cleanMemberTiers([{ key: 'a', name: 'A', permanent: true }, { key: 'a', name: 'B', permanent: true }]), null, 'key 重复拒绝')
  assert.equal(cleanMemberTiers([{ key: 'Bad Key', name: 'A', permanent: true }, { key: 'b', name: 'B', permanent: true }]), null, 'key 形态拒绝')
  assert.equal(cleanMemberTiers([{ key: 'a', name: '', permanent: true }, { key: 'b', name: 'B', permanent: true }]), null, '空名称拒绝')
  assert.equal(cleanMemberTiers([{ key: 'a', name: 'A', permanent: true }, { key: 'b', name: 'B', permanent: true, days: 99999 }]), null, 'days 超幅拒绝')
  // 'all' / 'member' 是付费墙伪档（公开 / 任意登录会员），保留字不准占用
  assert.equal(cleanMemberTiers([{ key: 'all', name: 'A', permanent: true }, { key: 'b', name: 'B', permanent: true }]), null)
  assert.equal(cleanMemberTiers([{ key: 'member', name: 'A', permanent: true }, { key: 'b', name: 'B', permanent: true }]), null)
})

test('cleanMemberTiers：fallback 只接受「更低的已存在档位」，其余退回自动降一档', () => {
  const ok = cleanMemberTiers([
    { key: 'normal', name: '注册会员', permanent: true, days: 0 },
    { key: 'premium', name: '优质会员', permanent: true, days: 0 },
    { key: 'coffee', name: '咖啡会员', permanent: false, days: 30, fallback: 'premium' },
  ])
  assert.ok(ok)
  assert.equal(ok[2].fallback, 'premium')
  // 指向自己 / 更高档 / 不存在的 key：一律清空（= 自动降一档），不能静默「永不到期」
  const self = cleanMemberTiers([
    { key: 'normal', name: 'A', permanent: true, days: 0 },
    { key: 'vip', name: 'B', permanent: false, days: 30, fallback: 'vip' },
  ])
  assert.ok(self)
  assert.equal(self[1].fallback, '')
  const ghost = cleanMemberTiers([
    { key: 'normal', name: 'A', permanent: true, days: 0 },
    { key: 'vip', name: 'B', permanent: false, days: 30, fallback: 'ghost' },
  ])
  assert.ok(ghost)
  assert.equal(ghost[1].fallback, '')
  const higher = cleanMemberTiers([
    { key: 'normal', name: 'A', permanent: true, days: 0 },
    { key: 'mid', name: 'M', permanent: false, days: 30 },
    { key: 'vip', name: 'B', permanent: false, days: 30, fallback: 'mid' },
  ])
  assert.ok(higher)
  assert.equal(higher[2].fallback, 'mid')
})

test('parseMemberTiers：空/脏 JSON 一律回默认三档（读侧宁可用默认也不挂）', () => {
  assert.deepEqual(parseMemberTiers(null).map((d) => d.key), ['normal', 'premium', 'coffee'])
  assert.deepEqual(parseMemberTiers('').map((d) => d.name), ['注册会员', '优质会员', '咖啡会员'])
  assert.deepEqual(parseMemberTiers('{broken').map((d) => d.key), DEFAULT_MEMBER_TIERS.map((d) => d.key))
  assert.deepEqual(parseMemberTiers('[]').map((d) => d.key), DEFAULT_MEMBER_TIERS.map((d) => d.key), '空数组拒绝后回默认')
  assert.deepEqual(parseMemberTiers('[{"key":"vip","name":"VIP","permanent":false,"days":30}]').map((d) => d.key), DEFAULT_MEMBER_TIERS.map((d) => d.key), '第一档非永久整体拒绝后回默认')
  // 合法定义原样生效
  const custom = parseMemberTiers('[{"key":"normal","name":"注册会员","permanent":true,"days":0},{"key":"gold","name":"金牌","color":"#f00","permanent":false,"days":90}]')
  assert.equal(custom[1].key, 'gold')
  assert.equal(custom[1].rank, 2)
  assert.equal(baseTier(custom).key, 'normal')
})

test('effectiveTier：咖啡会员到期 → 降到优质会员（不是掉回基础档）', () => {
  const defs = parseMemberTiers(null)
  const now = Date.now()
  // 永久档
  assert.equal(effectiveTier(defs, 'normal', null, now).isBase, true)
  assert.equal(effectiveTier(defs, 'premium', 12345, now).isBase, false, '永久档带脏有效期也照常')
  // 未过期
  const eff = effectiveTier(defs, 'coffee', now + 86_400_000, now)
  assert.equal(eff.name, '咖啡会员')
  assert.equal(eff.rank, 3)
  assert.equal(eff.expired, false)
  assert.equal(eff.downgradedFrom, undefined)
  // 过期（含恰好到期边界）→ 优质会员 + expired + 原档位名
  const expired = effectiveTier(defs, 'coffee', now, now)
  assert.equal(expired.key, 'premium')
  assert.equal(expired.name, '优质会员')
  assert.equal(expired.rank, 2)
  assert.equal(expired.expired, true)
  assert.equal(expired.isBase, false, '降级后仍是优质会员，徽标照出')
  assert.equal(expired.downgradedFrom, '咖啡会员')
  assert.equal(effectiveTier(defs, 'coffee', now - 1, now).expired, true)
  // 定义里没有的 key → 基础档
  assert.equal(effectiveTier(defs, 'ghost', null, now).isBase, true)
  // 限时档但从未设有效期（tier_expires_at 为空）→ 不降级（按仍在有效期处理，站长没配就不掐）
  assert.equal(effectiveTier(defs, 'coffee', null, now).isBase, false)
})

test('effectiveTier：没配 fallback 的限时档自动降到紧邻下一档', () => {
  // 站长自定义三层：normal(永久) / mid(限时) / vip(限时)，都没配 fallback
  const defs = parseMemberTiers(
    '[{"key":"normal","name":"注册会员","permanent":true,"days":0},{"key":"mid","name":"中档","permanent":false,"days":30},{"key":"vip","name":"高档","permanent":false,"days":30}]'
  )
  const now = Date.now()
  const vipExpired = effectiveTier(defs, 'vip', now - 1, now)
  assert.equal(vipExpired.key, 'mid', '最高档到期降一档')
  assert.equal(vipExpired.expired, true)
  const midExpired = effectiveTier(defs, 'mid', now - 1, now)
  assert.equal(midExpired.key, 'normal', '第二档到期落到基础档')
  assert.equal(midExpired.isBase, true)
})

test('minTierRank：all=0 / member=1 / 自定义 key 按定义 / 老库键兜底 / 未知键按登录可见', () => {
  const defs = parseMemberTiers(null)
  assert.equal(minTierRank(defs, null), 0)
  assert.equal(minTierRank(defs, ''), 0)
  assert.equal(minTierRank(defs, 'all'), 0)
  assert.equal(minTierRank(defs, 'member'), 1)
  assert.equal(minTierRank(defs, 'normal'), 1)
  assert.equal(minTierRank(defs, 'premium'), 2)
  assert.equal(minTierRank(defs, 'coffee'), 3)
  // 退役老键 top（当年最高级）映射到当前最高档，不能映射成低档把锁文放开
  assert.equal(minTierRank(defs, 'top'), 3)
  // 删掉 premium/coffee 后老库存量键仍按历史映射兜底
  const slim: MemberTierDef[] = [{ key: 'normal', name: '注册会员', color: '', permanent: true, days: 0, fallback: '' }]
  assert.equal(minTierRank(slim, 'coffee'), 1, '只剩一档时 coffee 就是基础档')
  assert.equal(minTierRank(slim, 'top'), 1)
  assert.equal(minTierRank(slim, 'ghost'), 1, '未知键当「登录会员可见」，不静默放成全网公开')
})

test('canReadTiers：游客/登录/档位等级/到期降级 全链路', () => {
  const defs = parseMemberTiers(null)
  const now = Date.now()
  // 公开文谁都能看
  assert.equal(canReadTiers(defs, 'all', null, now), true)
  // 锁文游客一律不可
  assert.equal(canReadTiers(defs, 'member', null, now), false)
  assert.equal(canReadTiers(defs, 'coffee', { tier: 'normal' }, now), false)
  // 登录会员可读 member 档
  assert.equal(canReadTiers(defs, 'member', { tier: 'normal' }, now), true)
  assert.equal(canReadTiers(defs, 'coffee', { tier: 'coffee' }, now), true)
  assert.equal(canReadTiers(defs, 'coffee', { tier: 'premium' }, now), false, '优质会员读不到咖啡档锁文')
  assert.equal(canReadTiers(defs, 'premium', { tier: 'coffee' }, now), true, '高档位可读低档位锁文')
  // 到期降级：咖啡到期后等价优质会员
  assert.equal(canReadTiers(defs, 'coffee', { tier: 'coffee', tier_expires_at: now - 1 }, now), false)
  assert.equal(canReadTiers(defs, 'premium', { tier: 'coffee', tier_expires_at: now - 1 }, now), true)
  assert.equal(canReadTiers(defs, 'member', { tier: 'coffee', tier_expires_at: now - 1 }, now), true)
  // 限时档但未设有效期 = 视为仍在期
  assert.equal(canReadTiers(defs, 'coffee', { tier: 'coffee', tier_expires_at: null }, now), true)
})

test('canRead（points.ts 兼容包装）：与历史口径一致（normal=1 / coffee=2 / top=3）', () => {
  assert.equal(canRead('all', null), true)
  assert.equal(canRead('member', 'normal'), true)
  assert.equal(canRead('coffee', 'normal'), false)
  assert.equal(canRead('coffee', 'coffee'), true)
  assert.equal(canRead('top', 'top'), true)
  assert.equal(canRead('top', 'coffee'), false)
})

test('normalizeMinTier：自定义档位 key 放行，脏值回 all', () => {
  assert.equal(normalizeMinTier('all'), 'all')
  assert.equal(normalizeMinTier('member'), 'member')
  assert.equal(normalizeMinTier('coffee'), 'coffee')
  assert.equal(normalizeMinTier('gold'), 'gold', '自定义 key 是合法 min_tier（读侧解析 rank）')
  assert.equal(normalizeMinTier('gold-9_x'), 'gold-9_x')
  assert.equal(normalizeMinTier('ALL'), 'all', '大小写不匹配形态 → all')
  assert.equal(normalizeMinTier('jav ascript'), 'all')
  assert.equal(normalizeMinTier('9bad'), 'all', '数字开头不是合法 key')
  assert.equal(normalizeMinTier(null), 'all')
  assert.equal(normalizeMinTier(undefined), 'all')
})

test('tierByKey / baseTier：查表与兜底', () => {
  const defs = parseMemberTiers(null)
  assert.equal(tierByKey(defs, 'premium')?.name, '优质会员')
  assert.equal(tierByKey(defs, 'coffee')?.name, '咖啡会员')
  assert.equal(tierByKey(defs, 'top'), null, '退役老键不在默认定义里')
  assert.equal(tierByKey(defs, 'Top'), null, 'key 精确匹配（大小写敏感）')
  assert.equal(tierByKey(defs, '')?.key ?? null, null)
  assert.equal(baseTier(defs).key, 'normal')
})
