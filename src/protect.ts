/* ---------------- 文章访问口令（两档站级密码） ----------------
 * 站长为全站配两把共享口令（后台「设置 → 访问密码」），文章按档位三选一：
 *   all    所有人可见
 *   fixed  固定密码可见（谁拿到密码谁都能读，适合公开给一群人的内容）
 *   member 会员密码可见（站长随时更换，一换所有旧解锁立即失效）
 * 两档是包含关系：输对会员密码的人也能读固定密码文章（高档覆盖低档）。
 *
 * 为什么用站级口令而不是会员身份：口令只需维护两行 hash，没有注册、登录、积分、
 * 档位这些状态；改密码天然就是「撤销所有已发出的访问权」，不需要台账。
 *
 * 解锁令牌 `level.exp.hmac`，HMAC 的 key 就是**该档当前的 password hash**——
 * 改密码 → 该档所有旧 Cookie 自动失效，无需站点级密钥，也无需任何撤销表。
 * 注意口径：hash 带随机盐，所以「重新保存同一个密码」也会换 hash、也会让所有人重输。
 * 后台设置页因此把留空当成「保持原值」，只有明确改/清除才写库。
 *
 * 独立成模块（同 src/trash.ts 的理由）：不依赖 hono / 主题，Node 测试可直接导入。
 * 防泄漏铁律（新增公开面必须过一遍，详见 AGENTS.md「文章访问口令」防线节）：
 * 口令 hash 不出任何后台响应；受保护文章的正文不出现在 RSS 全文 / 搜索 / meta 摘要。
 */
import { hashPassword, safeEqual } from './auth'

/** Cookie 名与解锁有效期：bloghao_ 前缀与 SESSION_COOKIE 同族 */
export const GATE_COOKIE = 'bloghao_gate'
export const GATE_TTL_MS = 30 * 86_400_000

/** 两档口令 */
export type GateLevel = 'fixed' | 'member'
/** 文章可见档位（对应 posts.min_tier） */
export type PostAccess = 'all' | GateLevel

/** 口令未配置时文章页的提示：不暴露正文，也不假装文章不存在 */
export const GATE_UNSET_NOTICE = '这篇文章设置了访问密码，但站长还没有配置对应口令，暂时无法阅读。'

export interface GateHashes {
  fixed: string
  member: string
}

/**
 * posts.min_tier → 三档。脏值（coffee / top / 自定义档位 / 空）一律当 member：
 * 会员体系里的档位是「比公开更严」的语义，收敛时宁可锁紧也不误放成全网可见。
 */
export function normalizeAccess(minTier: string | null | undefined): PostAccess {
  const v = (minTier || '').trim()
  if (v === 'all' || v === '') return 'all'
  if (v === 'fixed') return 'fixed'
  return 'member'
}

/** 该档在 settings 里的键名（两档口令只存 hash，明文永不落库） */
export function gateSettingKey(level: GateLevel): 'gateFixedPassword' | 'gateMemberPassword' {
  return level === 'fixed' ? 'gateFixedPassword' : 'gateMemberPassword'
}

/** 生成存储格式 `salt:hash`（复用 auth.ts 的 PBKDF2-SHA256，10 万次迭代与登录口令同强度） */
export async function hashGatePassword(password: string): Promise<string> {
  const { hash, salt } = await hashPassword(password)
  return `${salt}:${hash}`
}

/** 从设置里取出两档 hash（脏值当未配置，不抛错） */
export function gateHashesOf(s: Record<string, string>): GateHashes {
  return { fixed: s.gateFixedPassword || '', member: s.gateMemberPassword || '' }
}

/** 校验某档口令：存储格式非法 / 该档未配置 / 密码不对一律 false */
export async function verifyGatePassword(stored: string, password: string): Promise<boolean> {
  if (!stored || !password) return false
  const i = stored.indexOf(':')
  if (i <= 0) return false
  const salt = stored.slice(0, i)
  const hash = stored.slice(i + 1)
  const { hash: calc } = await hashPassword(password, salt)
  return safeEqual(calc, hash)
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(keyText: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)))
}

/** 解锁令牌：`level.exp.hmac` */
async function signToken(level: GateLevel, hash: string, now: number): Promise<string> {
  const exp = now + GATE_TTL_MS
  return `${level}.${exp}.${await hmacHex(hash, `${level}.${exp}`)}`
}

/** 当前 Cookie 里已经解锁的档位集合（签名对当前 hash 重算，改密码即失效） */
export async function unlockedLevels(cookieValue: string | null, hashes: GateHashes, now: number): Promise<Set<GateLevel>> {
  const out = new Set<GateLevel>()
  if (!cookieValue) return out
  for (const entry of cookieValue.split(',')) {
    const parts = entry.split('.')
    if (parts.length !== 3) continue
    const level = parts[0]
    if (level !== 'fixed' && level !== 'member') continue
    const hash = hashes[level]
    if (!hash) continue
    const exp = Number(parts[1])
    if (!Number.isFinite(exp) || exp <= now) continue
    if (safeEqual(await hmacHex(hash, `${level}.${exp}`), parts[2])) out.add(level)
  }
  return out
}

/**
 * 能否读取某档文章：all 恒可；fixed 认 fixed 或 member 令牌（会员密码是高档，覆盖低档）；
 * member 只认 member 令牌。都没配口令时永远解不开（由页面给明确提示，不静默放行）。
 */
export async function canRead(cookieValue: string | null, need: PostAccess, hashes: GateHashes, now: number): Promise<boolean> {
  if (need === 'all') return true
  const levels = await unlockedLevels(cookieValue, hashes, now)
  if (need === 'fixed') return levels.has('fixed') || levels.has('member')
  return levels.has('member')
}

/** 该档文章在当前设置下**是否还有解锁途径**：两档都没配 = 站长还没开工，页面要先说清楚 */
export function canEverUnlock(need: PostAccess, hashes: GateHashes): boolean {
  if (need === 'all') return true
  if (need === 'fixed') return !!hashes.fixed || !!hashes.member
  return !!hashes.member
}

/**
 * 解锁成功后的 Cookie 值：并入本次令牌、清掉过期与旧密码下的条目。
 * 只有两档，最多两条，不需要容量上限——一个档位一条，重复解锁原地替换。
 */
export async function mergeGateCookie(existing: string | null, level: GateLevel, hashes: GateHashes, now: number): Promise<string> {
  const keep: string[] = []
  for (const entry of (existing || '').split(',')) {
    const parts = entry.split('.')
    if (parts.length !== 3) continue
    const lv = parts[0]
    if (lv !== 'fixed' && lv !== 'member') continue
    if (lv === level) continue // 同档旧令牌作废（可能是旧密码签的）
    const exp = Number(parts[1])
    if (!Number.isFinite(exp) || exp <= now) continue
    // 保留另一档：签名仍要对该档当前 hash 有效，否则一并清掉
    const hash = hashes[lv]
    if (!hash || !safeEqual(await hmacHex(hash, `${lv}.${exp}`), parts[2])) continue
    keep.push(entry)
  }
  keep.push(await signToken(level, hashes[level], now))
  return keep.join(',')
}

/** 受保护文章在解锁前的 meta / JSON-LD 描述：作者摘要照常展示，否则用固定话术 */
export function protectedDescription(summary: string): string {
  if (summary) return summary
  return '本文章需要访问密码，输入后可阅读全文。'
}

/** 解锁前文章页的正文替换：服务端直出的口令表单（纯 HTML form POST + 303 回跳，无 JS 依赖） */
export function gateFormHtml(
  slug: string,
  o: { need: GateLevel; error?: 'wrong' | 'slow' | 'unset' }
): string {
  const label = o.need === 'fixed' ? '访问密码' : '会员密码'
  const tip =
    o.need === 'fixed'
      ? '这篇文章需要访问密码，输入后即可阅读全文，解锁状态保留 30 天。'
      : '这篇文章仅对会员开放，输入站长告知的会员密码即可阅读，解锁状态保留 30 天。'
  const err =
    o.error === 'unset'
      ? `<p class="gp-err">${GATE_UNSET_NOTICE}</p>`
      : o.error === 'slow'
        ? `<p class="gp-err">尝试次数过多，请 10 分钟后再试。</p>`
        : o.error === 'wrong'
          ? `<p class="gp-err">密码不对，再试试。</p>`
          : ''
  return `<div class="gp-box">
<form class="gp-form" method="post" action="/post/${encodeURIComponent(slug)}/unlock">
  <p class="gp-title">🔒 这篇文章需要密码</p>
  <p class="gp-tip">${tip}</p>
  <div class="gp-row">
    <input class="gp-input" type="password" name="password" maxlength="64" required placeholder="${label}" aria-label="${label}" autocomplete="off">
    <button class="gp-btn" type="submit">解锁</button>
  </div>
  ${err}
</form>
</div>`
}

/** 表单样式：随主题 CSS 注入 <head>（style-src 'unsafe-inline' 已放行），currentColor 适配各主题明暗 */
export const GATE_CSS = `
.gp-box{max-width:420px;margin:32px auto;padding:28px 22px;border:1px solid rgba(127,127,127,.3);border-radius:14px;text-align:center}
.gp-title{font-size:17px;font-weight:600;margin:0 0 8px}
.gp-tip{font-size:13px;opacity:.72;margin:0 0 18px;line-height:1.7}
.gp-row{display:flex;gap:8px}
.gp-input{flex:1;min-width:0;font-size:16px;padding:10px 12px;border:1px solid rgba(127,127,127,.45);border-radius:10px;background:transparent;color:inherit}
.gp-btn{font-size:15px;padding:10px 18px;border:1px solid currentColor;border-radius:10px;background:transparent;color:inherit;cursor:pointer}
.gp-btn:hover{opacity:.75}
.gp-err{font-size:13px;color:#d64545;margin:14px 0 0;line-height:1.7}
@media (max-width:480px){.gp-box{margin:20px 0;padding:22px 14px}.gp-row{flex-wrap:wrap}.gp-btn{width:100%}}
`
