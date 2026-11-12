import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canEverUnlock,
  canRead,
  GATE_COOKIE,
  gateFormHtml,
  gateHashesOf,
  gateSettingKey,
  hashGatePassword,
  mergeGateCookie,
  normalizeAccess,
  protectedDescription,
  unlockedLevels,
  verifyGatePassword,
} from '../src/protect.ts'

const NOW = 1_800_000_000_000

async function hashes(fixedPw: string, memberPw: string) {
  return {
    fixed: fixedPw ? await hashGatePassword(fixedPw) : '',
    member: memberPw ? await hashGatePassword(memberPw) : '',
  }
}

// ── 档位归一：脏值一律锁紧 ──
test('normalizeAccess：all/空 → all；fixed/member 直认；会员时代档位与脏值一律当 member', () => {
  assert.equal(normalizeAccess('all'), 'all')
  assert.equal(normalizeAccess(''), 'all')
  assert.equal(normalizeAccess(null), 'all')
  assert.equal(normalizeAccess(undefined), 'all')
  assert.equal(normalizeAccess('  all  '), 'all')
  assert.equal(normalizeAccess('fixed'), 'fixed')
  assert.equal(normalizeAccess('member'), 'member')
  // 会员体系时代的档位：语义都是「不是给所有人看的」，收敛成 member 而不是公开
  for (const dirty of ['coffee', 'top', 'premium', 'normal', '随便什么']) {
    assert.equal(normalizeAccess(dirty), 'member', dirty)
  }
})

test('gateSettingKey / gateHashesOf：两档各自的设置键，脏值当未配置', () => {
  assert.equal(gateSettingKey('fixed'), 'gateFixedPassword')
  assert.equal(gateSettingKey('member'), 'gateMemberPassword')
  assert.deepEqual(gateHashesOf({}), { fixed: '', member: '' })
  assert.deepEqual(gateHashesOf({ gateFixedPassword: 'a:b', gateMemberPassword: '' }), { fixed: 'a:b', member: '' })
})

// ── 口令哈希：PBKDF2 存储 salt:hash ──
test('hashGatePassword/verifyGatePassword：正确密码通过、错误与脏存储拒绝', async () => {
  const stored = await hashGatePassword('固定口令')
  assert.match(stored, /^[0-9a-f]+:[0-9a-f]{64}$/)
  assert.equal(await verifyGatePassword(stored, '固定口令'), true)
  assert.equal(await verifyGatePassword(stored, '固定口令 '), false)
  assert.equal(await verifyGatePassword(stored, ''), false)
  assert.equal(await verifyGatePassword(stored, 'wrong'), false)
  // 同一密码两次加盐：存储串不同，但都能过
  const again = await hashGatePassword('固定口令')
  assert.notEqual(again, stored)
  assert.equal(await verifyGatePassword(again, '固定口令'), true)
  for (const dirty of ['', 'no-colon', ':abcdef', 'saltonly:', 'x:y']) {
    assert.equal(await verifyGatePassword(dirty, '任意'), false, dirty)
  }
})

// ── 解锁令牌：HMAC key = 该档 password hash，改密即该档全端失效 ──
test('canRead：all 恒可；fixed 认 fixed 或 member；member 只认 member', async () => {
  const h = await hashes('fixed-pass', 'member-pass')
  const fixedCookie = await mergeGateCookie(null, 'fixed', h, NOW)
  const memberCookie = await mergeGateCookie(null, 'member', h, NOW)

  assert.equal(await canRead(null, 'all', h, NOW), true, '公开文章不要任何 cookie')
  assert.equal(await canRead('garbage', 'all', h, NOW), true)

  assert.equal(await canRead(null, 'fixed', h, NOW), false)
  assert.equal(await canRead(null, 'member', h, NOW), false)

  assert.equal(await canRead(fixedCookie, 'fixed', h, NOW), true)
  assert.equal(await canRead(fixedCookie, 'member', h, NOW), false, '固定密码不能读会员文章')

  assert.equal(await canRead(memberCookie, 'member', h, NOW), true)
  assert.equal(await canRead(memberCookie, 'fixed', h, NOW), true, '会员密码是高档，覆盖固定密码文章')
})

test('canRead：改密码让该档令牌失效，另一档不受影响', async () => {
  const before = await hashes('fixed-pass', 'member-pass')
  const both = await mergeGateCookie(await mergeGateCookie(null, 'fixed', before, NOW), 'member', before, NOW)
  assert.equal(await canRead(both, 'member', before, NOW), true)

  // 只换会员密码：会员令牌失效、固定令牌照旧（固定那一档的 hash 没动，令牌签名继续对得上）
  const rotatedMember = { fixed: before.fixed, member: await hashGatePassword('brand-new-member') }
  assert.equal(await canRead(both, 'member', rotatedMember, NOW), false, '换会员密码后必须重输')
  assert.equal(await canRead(both, 'fixed', rotatedMember, NOW), true, '固定密码那一档不受影响')

  // 只换固定密码：固定令牌失效，会员令牌仍能读固定文章（高档覆盖）
  const rotatedFixed = { fixed: await hashGatePassword('brand-new-fixed'), member: before.member }
  assert.equal(await canRead(both, 'fixed', rotatedFixed, NOW), true)
  // 但会员令牌本身仍有效 —— 逐条复核一下
  const levels = await unlockedLevels(both, rotatedFixed, NOW)
  assert.equal(levels.has('fixed'), false)
  assert.equal(levels.has('member'), true)
})

test('canRead：TTL 30 天到期、伪造签名、篡改有效期、未知档位全失效', async () => {
  const h = await hashes('fixed-pass', 'member-pass')
  const cookie = await mergeGateCookie(null, 'member', h, NOW)
  assert.match(cookie, /^member\.\d+\.[0-9a-f]{64}$/)
  assert.equal(await canRead(cookie, 'member', h, NOW + 29 * 86_400_000), true)
  assert.equal(await canRead(cookie, 'member', h, NOW + 31 * 86_400_000), false, '过期')

  assert.equal(await canRead(cookie.slice(0, -4) + '0000', 'member', h, NOW), false, '改签名尾')
  const expTampered = cookie.replace(/^member\.(\d+)\./, (_, exp) => `member.${Number(exp) + 1000}.`)
  assert.equal(await canRead(expTampered, 'member', h, NOW), false, '改有效期')

  for (const dirty of [null, '', 'garbage', 'member.abc.x', 'member..x', 'x.y.z', 'admin.1.2']) {
    assert.equal(await canRead(dirty, 'member', h, NOW), false, String(dirty))
  }
})

test('canRead：该档没配口令时永远解不开（不是静默放行）', async () => {
  const noFire = await hashes('', 'member-pass')
  const memberCookie = await mergeGateCookie(null, 'member', noFire, NOW)
  // fixed 没配：即便拿着会员密码的令牌，也走 has('member') 这条放行（高档覆盖），这是有意的
  assert.equal(await canRead(memberCookie, 'fixed', noFire, NOW), true)
  // 两档都没配：谁都打不开
  assert.equal(await canRead(null, 'fixed', { fixed: '', member: '' }, NOW), false)
  assert.equal(await canRead(null, 'member', { fixed: '', member: '' }, NOW), false)
})

test('mergeGateCookie：两档并存、同档替换、旧密码条目自动清掉、脏输入忽略', async () => {
  const h = await hashes('fixed-pass', 'member-pass')
  const one = await mergeGateCookie(null, 'fixed', h, NOW)
  const two = await mergeGateCookie(one, 'member', h, NOW)
  assert.equal(two.split(',').length, 2)

  // 同档再解锁：替换而不是堆积
  const replaced = await mergeGateCookie(two, 'fixed', h, NOW)
  assert.equal(replaced.split(',').length, 2)

  // existing 里另一档的签名对当前 hash 无效（改过密码）：并入时被清掉
  const rotated = await hashes('brand-new-fixed', 'member-pass')
  const merged = await mergeGateCookie(two, 'member', rotated, NOW)
  const levels = await unlockedLevels(merged, rotated, NOW)
  assert.equal(levels.has('fixed'), false, '旧固定密码签的令牌不该留下')
  assert.equal(levels.has('member'), true)

  // 脏 existing 原样忽略，不抛错
  assert.equal((await mergeGateCookie('garbage,,x.y', 'fixed', h, NOW)).split(',').length, 1)
  assert.equal((await mergeGateCookie('fixed.1.z', 'fixed', h, NOW)).split(',').length, 1)
})

test('canEverUnlock：两档都没配 = 站长还没开工', async () => {
  const h = await hashes('f', 'm')
  assert.equal(canEverUnlock('all', { fixed: '', member: '' }), true)
  assert.equal(canEverUnlock('fixed', h), true)
  assert.equal(canEverUnlock('member', h), true)
  assert.equal(canEverUnlock('fixed', { fixed: '', member: 'x:y' }), true, '会员密码也能开固定档文章')
  assert.equal(canEverUnlock('member', { fixed: 'x:y', member: '' }), false)
  assert.equal(canEverUnlock('fixed', { fixed: '', member: '' }), false)
})

// ── 防泄漏展示口径 ──
test('protectedDescription：作者摘要优先，否则固定话术（正文摘要绝不参与）', () => {
  assert.equal(protectedDescription('作者写的导读'), '作者写的导读')
  assert.ok(protectedDescription('').includes('访问密码'))
})

test('gateFormHtml：action 编码 slug、两档文案、错误态、无内联事件', () => {
  const fixed = gateFormHtml('my-slug', { need: 'fixed' })
  assert.ok(fixed.includes('action="/post/my-slug/unlock"'))
  assert.ok(fixed.includes('type="password"'))
  assert.ok(fixed.includes('访问密码'))
  assert.ok(!fixed.includes('gp-err'))
  // 会员档的提示与输入框标签都不同
  const member = gateFormHtml('s', { need: 'member' })
  assert.ok(member.includes('会员密码'))
  assert.ok(!member.includes('>访问密码<'))
  // 中文 slug 走百分号编码
  assert.ok(gateFormHtml('中文slug', { need: 'fixed' }).includes('/post/%E4%B8%AD%E6%96%87slug/unlock'))
  assert.ok(gateFormHtml('s', { need: 'fixed', error: 'wrong' }).includes('密码不对'))
  assert.ok(gateFormHtml('s', { need: 'fixed', error: 'slow' }).includes('尝试次数过多'))
  assert.ok(gateFormHtml('s', { need: 'member', error: 'unset' }).includes('站长还没有配置'))
  // 表单里不出现任何内联事件（CSP 无 unsafe-inline 脚本）
  assert.ok(!/\son[a-z]+=/i.test(fixed))
  // Cookie 名与 SESSION_COOKIE 同族（bloghao_ 前缀）
  assert.equal(GATE_COOKIE, 'bloghao_gate')
})
