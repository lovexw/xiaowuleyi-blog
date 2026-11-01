/**
 * 注册邀请码（2026-11，会员体系第四批）
 * =====================================
 * 后台生成；持码注册直接拿到码上指定的档位（默认**优质会员**）。
 * 核销次数可选：一码一人（默认）/ 限量 N 次 / 不限次数（会员群福利码），外加码自身的有效期。
 * 码本身不含任何业务信息（不签名、不加密）——它只是数据库里的一行主键查找，
 * 所以撤销就是删行，改档位就是改列，没有「过期签名」这类历史包袱。
 *
 * 形态：8 位 Crockford Base32（去掉 I / L / O / U 四个易混字符），展示成 XXXX-XXXX。
 * 用户粘贴时容忍小写、空格、连字符（normalizeInviteCode 统一收口）。
 *
 * 纯函数 + Node 可直接导入（tests/invite.test.ts），同 tiers.ts / commentgate.ts 模式；
 * 落库与原子核销在 db.ts（insertInviteCode / consumeInvite），权限与业务在 api.ts。
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

/* ---------------- 核销次数与状态（2026-11 会员第五批：一码一人 → 可限量/不限量） ----------------
 * max_uses：1 = 一码一人（默认）；0 = 不限次数（发给会员群当福利码）；N = 限量 N 次。
 * 语义边界要清楚：「一人一次」是**注册本身**保证的（用户名唯一、一个账号只能注册一次），
 * 代码层不做「同一人不能吃第二个码」的额外判定——那需要记录设备/邮箱指纹，代价远大于收益。
 */

/** 可核销次数上限：0 或 1-1000（1000 是防手滑输入 999999 把码变成事实上的不限量） */
export const INVITE_MAX_USES_LIMIT = 1000

/** 核销次数归一化：不合法返回 null（调用方 400）；0 保留为「不限」 */
export function normalizeMaxUses(input: unknown): number | null {
  const n = Math.trunc(Number(input ?? 1))
  if (!Number.isFinite(n) || n < 0 || n > INVITE_MAX_USES_LIMIT) return null
  return n
}

/** 码的三种状态（后台筛选项与服务端谓词同口径，见 db.ts listInvitesAdmin） */
export type InviteState = 'usable' | 'usedup' | 'expired'

/**
 * 现算一个码当前能不能用。**已用完优先于已过期**——码已经用光了，站长不关心它是否还过期。
 * used_count 缺省时回退按 used_at 推（老库刚 ALTER 出列、尚未回填的那一瞬间也能判对）
 */
export function inviteStatus(
  row: { max_uses?: number | null; used_count?: number | null; expires_at?: number | null; used_at?: number | null },
  now = Date.now()
): InviteState {
  const max = Math.max(0, Math.trunc(Number(row.max_uses ?? 1)) || 0)
  const used = row.used_count == null ? (row.used_at != null ? 1 : 0) : Math.max(0, Math.trunc(Number(row.used_count)) || 0)
  if (max > 0 && used >= max) return 'usedup'
  if (row.expires_at != null && row.expires_at <= now) return 'expired'
  return 'usable'
}

/** 剩余可核销次数：不限量返回 Infinity（展示层写「不限」，限量写「还剩 N 次」） */
export function inviteRemaining(row: { max_uses?: number | null; used_count?: number | null; used_at?: number | null }): number {
  const max = Math.max(0, Math.trunc(Number(row.max_uses ?? 1)) || 0)
  if (max === 0) return Infinity
  const used = row.used_count == null ? (row.used_at != null ? 1 : 0) : Math.max(0, Math.trunc(Number(row.used_count)) || 0)
  return Math.max(0, max - used)
}
