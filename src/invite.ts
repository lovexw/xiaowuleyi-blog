/**
 * 注册邀请码（2026-11，会员体系第四批）
 * =====================================
 * 后台生成、一次性核销；持码注册直接拿到码上指定的档位（默认**优质会员**）。
 * 码本身不含任何业务信息（不签名、不加密）——它只是数据库里的一行主键查找，
 * 所以撤销就是删行，改档位就是改列，没有「过期签名」这类历史包袱。
 *
 * 形态：8 位 Crockford Base32（去掉 I / L / O / U 四个易混字符），展示成 XXXX-XXXX。
 * 用户粘贴时容忍小写、空格、连字符（normalizeInviteCode 统一收口）。
 *
 * 纯函数 + Node 可直接导入（tests/invite.test.ts），同 tiers.ts / commentgate.ts 模式；
 * 落库与原子核销在 db.ts（createInviteCodes / consumeInvite），权限与业务在 api.ts。
 */

/** Crockford Base32：0-9 + A-Z 去掉 I L O U（易与 1 / 0 混淆，且 U 易被拼成脏字） */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 码长（8 位 = 32^8 ≈ 1.1 万亿组合，配合一次性核销足够；再长手抄就烦了） */
export const INVITE_CODE_LEN = 8

/** 合法码形态（归一化后，不带连字符的 8 位大写字串） */
export const INVITE_CODE_RE = new RegExp(`^[${ALPHABET}]{${INVITE_CODE_LEN}}$`)

/** 生成一个码（8 位大写，展示用 formatInviteCode 分组）。
 *  随机源 256 % 32 === 0，取低 5 位无模偏差，不需要拒绝采样 */
export function genInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_LEN)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < INVITE_CODE_LEN; i++) out += ALPHABET[bytes[i] & 31]
  return out
}

/** 存库形态 → 展示形态：ABCD1234 → ABCD-1234（后台列表与复制按钮用，与人工念读节奏一致） */
export function formatInviteCode(code: string): string {
  const c = String(code || '')
  return c.length === INVITE_CODE_LEN ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/** 用户输入 → 存库形态：去空白/连字符、转大写；形态不合法返回 ''（调用方当「没填」或「码不对」处理）。
 *  不做「猜错字」纠正（0/O、1/I 互换）——那会让两个不同的码撞在一起，代价远大于省一次手输 */
export function normalizeInviteCode(input: unknown): string {
  const s = String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
  return INVITE_CODE_RE.test(s) ? s : ''
}
