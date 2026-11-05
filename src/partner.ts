/**
 * 跨站会员继承（分站模式，2026-11）
 * =================================
 * 场景：blog.btchao.com 走付费会员（`paid`），blog.xiaowuleyi.com 走个人生活博客 + 轻付费内容。
 * 在 btchao 付过费的人，到主站自动是「永久会员」——**单向授予，不做双向联邦**。
 *
 * 为什么是分站而不是「一号通」：
 * 两站是**两个独立实例**（各自 TENANTS_DIR、各自 tenants.json、各自 blog.db），不是同一实例的
 * 两个租户。想做「一个账号通行」就得建身份中心、迁移现有会员、处理档位语义错位——为一个
 * 几十人的会员盘子付这个代价不划算。分站模式只付「一条单向通道」的成本，两站会员表互不读写。
 *
 * 通道形态：**同邮箱认领**（站长口径，零操作）
 *  - 来源站开会员时把 {issuer, subject, email, tier} 推给目标站（api.ts 的 PUT /admin/members/:id）；
 *  - 目标站按邮箱找本地会员：有 → 立即授予；没有 → 进 partner_grants 待认领，等他注册/登录时兜上；
 *  - 认领靠「邮箱一致」，所以**邮箱在目标站必须是已填的**。主站注册邮箱选填，没填就认领不到——
 *    这是本方案唯一的运营依赖，后台「跨站继承」页会把待认领记录列出来，缺邮箱的一眼可见。
 *
 * 已知风险（站长知情接受，见 docs/PARTNER.md）：
 * 主站注册不验证邮箱，所以「填别人的付费邮箱」理论上能白拿永久会员。两道闸：
 *  1. 一个 (issuer, subject) 在目标站只能绑一个账号（idx_members_remote 唯一索引）——先到先得，
 *     真会员后到时会被明确告知「已绑定其他账号」，站长可查可撤；
 *  2. 后台「跨站继承」列表逐条记录来源与时间，撤销一键完成。
 * 不做邮箱验证是因为项目还没有邮件服务；等 B1 落地后可在此处补一道验证，接口不用改。
 *
 * 生效口径：授予的是**永久档**（`permanent: true`），tier_expires_at 置 NULL。
 * 站长选了「到期不收回」，所以来源站会员后来到期/退款，主站档位不跟。这是刻意的：一次付费终身。
 */

import type { MemberTierDef } from './tiers'
import { tierByKey } from './tiers'

/** 站点标识形态（落库进 partner_grants.issuer / members.remote_issuer） */
export const PARTNER_ID_RE = /^[a-z][a-z0-9_-]{0,23}$/

/** 邮箱归一化：trim + 小写 + 截断。注册入库与认领比较**必须**走同一个函数，
 *  否则「A@qq.com」和「a@qq.com」会变成两个人（历史数据里大小写混着有） */
export function normalizeEmail(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().slice(0, 100)
}

/** 一条继承记录（来源站推送的 payload，也是签名覆盖的全部字段） */
export interface PartnerGrant {
  /** 来源站标识，如 'btchao' */
  issuer: string
  /** 来源站的会员 id（稳定不变的那个，用户名可改但 id 不改） */
  subject: string
  /** 来源站会员邮箱（认领键） */
  email: string
  /** 目标站档位 key（如 'lifetime'）。必须已存在于目标站的 memberTiers 定义，否则拒收 */
  tier: string
  /** 备注（后台展示用，如「btchao 付费会员 2026-11」） */
  note: string
  /** 过期时刻（毫秒）。只防重放，与会员权益有效期无关——权益是永久的 */
  exp: number
}

/** 待认领记录的 member_id 哨兵值：-1 = 认领冲突（该来源会员已绑了别的账号），
 *  0 = 尚未认领，正数 = 已认领的本地会员 id */
export const GRANT_CONFLICT = -1

/**
 * 签名原文：字段按固定顺序换行拼接，**不含 secret**。
 * 顺序与分隔符改动即破坏兼容——两端必须用同一份代码（同一镜像的两个实例）。
 */
export function partnerPayloadString(g: Pick<PartnerGrant, 'issuer' | 'subject' | 'email' | 'tier' | 'note' | 'exp'>): string {
  return [g.issuer, g.subject, g.email, g.tier, g.note ?? '', String(g.exp)].join('\n')
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  return Array.from(new Uint8Array(sig), (x) => x.toString(16).padStart(2, '0')).join('')
}

export function partnerSign(secret: string, g: PartnerGrant): Promise<string> {
  return hmacHex(secret, partnerPayloadString(g))
}

/** 校验签名：常量时间比较（长度不等也扫完，不泄露长度差），口径同 auth.ts safeEqual */
export async function verifyPartnerSignature(secret: string, g: PartnerGrant, sig: string): Promise<boolean> {
  if (!secret || !sig) return false
  const want = await partnerSign(secret, g)
  const a = want
  const b = sig.trim().toLowerCase()
  const len = Math.max(a.length, b.length)
  let r = a.length === b.length ? 0 : 1
  for (let i = 0; i < len; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return r === 0
}

/** 签名有效窗口：±5 分钟。时钟偏差容忍 + 重放窗口收敛，与短信验证码同级 */
const SIGN_WINDOW_MS = 5 * 60_000

export function partnerGrantExpired(g: PartnerGrant, now = Date.now()): boolean {
  return !Number.isFinite(g.exp) || Math.abs(g.exp - now) > SIGN_WINDOW_MS
}

/** 从任意 JSON 里取出并规整一条 grant；形状不对返回 null（调用方 400，不静默降级） */
export function cleanPartnerGrant(raw: unknown, now = Date.now()): PartnerGrant | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const issuer = String(b.issuer ?? '').trim()
  const subject = String(b.subject ?? '').trim()
  const tier = String(b.tier ?? '').trim()
  if (!PARTNER_ID_RE.test(issuer)) return null
  if (!subject || subject.length > 64) return null
  if (!tier || tier.length > 24) return null
  const email = normalizeEmail(b.email)
  // 邮箱可空（来源站会员没填邮箱）：仍然入待认领，站长后台可手动补邮箱后认领
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  const note = String(b.note ?? '').trim().slice(0, 120)
  const exp = Number(b.exp ?? 0)
  if (!Number.isFinite(exp) || Math.abs(exp - now) > SIGN_WINDOW_MS) return null
  return { issuer, subject, email, tier, note, exp }
}

/**
 * 把一条继承记录落库。同 (issuer, subject) 重复推送按更新处理——来源站改了档位/邮箱再推一次，
 * 目标站不该出现两条打架的记录。
 * 返回 'granted'（当场授予）/ 'pending'（等人来认领）/ 'conflict'（该来源会员已绑了别的账号）。
 */
export async function receivePartnerGrant(
  db: D1Database,
  g: PartnerGrant,
  defs: MemberTierDef[],
  now = Date.now()
): Promise<'granted' | 'pending' | 'conflict' | 'unknown-tier'> {
  const def = tierByKey(defs, g.tier)
  // 只认永久档：跨站继承的语义是「一次付费终身」，把限时档接进来会顺手把 tier_expires_at 置 NULL，
  // 等于把年费会员悄悄变成永久——这条路必须堵在入口，而不是事后靠人发现
  if (!def || !def.permanent) return 'unknown-tier'
  await db
    .prepare(
      `INSERT INTO partner_grants (issuer, subject, email, member_id, tier, note, created_at, claimed_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, NULL)
       ON CONFLICT (issuer, subject) DO UPDATE SET email = excluded.email, tier = excluded.tier, note = excluded.note`
    )
    .bind(g.issuer, g.subject, g.email, g.tier, g.note, now)
    .run()
  const row = await db
    .prepare('SELECT * FROM partner_grants WHERE issuer = ? AND subject = ?')
    .bind(g.issuer, g.subject)
    .first<PartnerGrantRow>()
  if (!row) return 'pending'
  if (row.member_id !== 0) return row.member_id === GRANT_CONFLICT ? 'conflict' : 'granted'
  // 邮箱为空 = 来源站会员没填，无处认领，留在待认领队列
  if (!g.email) return 'pending'
  // 同邮箱可能有多条（邮箱在 members 上没有唯一约束）：取最早注册的那个，
  // 已是别的来源绑定过的（remote_issuer 非空）跳过，避免把两条继承链叠到一个账号上
  const member = await db
    .prepare('SELECT id FROM members WHERE LOWER(email) = ? AND remote_issuer = \'\' ORDER BY id ASC LIMIT 1')
    .bind(g.email)
    .first<{ id: number }>()
  if (!member) return 'pending'
  return (await claimGrant(db, row, member.id, defs, now)) ? 'granted' : 'conflict'
}

interface PartnerGrantRow {
  id: number
  issuer: string
  subject: string
  email: string
  member_id: number
  tier: string
  note: string
  created_at: number
  claimed_at: number | null
}

/**
 * 认领一条记录到指定会员。返回 false = 该来源会员已被别的账号绑定（不改任何数据）。
 * 档位只升不降：会员本来就在更高档（例如站长手动给了更高权益），继承不该把他拽下来。
 */
async function claimGrant(
  db: D1Database,
  row: PartnerGrantRow,
  memberId: number,
  defs: MemberTierDef[],
  now: number
): Promise<boolean> {
  const def = tierByKey(defs, row.tier)
  if (!def || !def.permanent) return false
  // 反向唯一：一个来源会员只能绑一个本地账号
  const taken = await db
    .prepare('SELECT id FROM members WHERE remote_issuer = ? AND remote_subject = ? AND id <> ?')
    .bind(row.issuer, row.subject, memberId)
    .first<{ id: number }>()
  if (taken) {
    await db.prepare('UPDATE partner_grants SET member_id = ?, note = ? WHERE id = ?').bind(GRANT_CONFLICT, row.note, row.id).run()
    return false
  }
  const self = await db
    .prepare('SELECT tier, tier_expires_at FROM members WHERE id = ?')
    .bind(memberId)
    .first<{ tier: string; tier_expires_at: number | null }>()
  if (!self) return false
  const cur = tierByKey(defs, self.tier)
  const curRank = cur ? (cur.rank ?? 1) : 0
  const nextRank = def.rank ?? 1
  // 只升不降：继承来的档位低于当前生效档位时，只记绑定关系，不动档位
  if (nextRank > curRank) {
    await db
      .prepare(
        `UPDATE members SET tier = ?, tier_expires_at = NULL, tier_source = 'partner',
         remote_issuer = ?, remote_subject = ?, updated_at = ? WHERE id = ?`
      )
      .bind(def.key, row.issuer, row.subject, now, memberId)
      .run()
  } else {
    await db
      .prepare('UPDATE members SET remote_issuer = ?, remote_subject = ?, updated_at = ? WHERE id = ?')
      .bind(row.issuer, row.subject, now, memberId)
      .run()
  }
  await db.prepare('UPDATE partner_grants SET member_id = ?, claimed_at = ? WHERE id = ?').bind(memberId, now, row.id).run()
  return true
}

/**
 * 认领入口：会员注册 / 登录时带上邮箱扫一遍待认领队列。
 * 邮箱为空直接返回（绝大多数游客与未填邮箱的会员不走这里，零成本）。
 * 返回实际授予的条数——调用方用它决定要不要刷新会员视图。
 */
export async function claimPartnerGrants(
  db: D1Database,
  memberId: number,
  email: string | null | undefined,
  defs: MemberTierDef[],
  now = Date.now()
): Promise<number> {
  const mail = normalizeEmail(email)
  if (!mail) return 0
  const rows = await db
    .prepare('SELECT * FROM partner_grants WHERE LOWER(email) = ? AND member_id = 0 ORDER BY id ASC LIMIT 5')
    .bind(mail)
    .all<PartnerGrantRow>()
  let granted = 0
  for (const row of rows.results ?? []) {
    if (await claimGrant(db, row, memberId, defs, now)) granted++
  }
  return granted
}

/**
 * 撤销继承（后台一键）：清掉绑定关系，把档位降回基础档。
 * 「永久不收回」说的是来源站到期不自动收；站长手动撤销是另一回事——冒领/退款争议得能撤。
 */
export async function revokePartnerGrant(db: D1Database, memberId: number, baseTierKey: string, now = Date.now()): Promise<void> {
  await db
    .prepare(
      `UPDATE members SET tier = ?, tier_expires_at = NULL, tier_source = 'manual',
       remote_issuer = '', remote_subject = '', updated_at = ? WHERE id = ?`
    )
    .bind(baseTierKey, now, memberId)
    .run()
  await db.prepare('UPDATE partner_grants SET member_id = 0, claimed_at = NULL WHERE member_id = ?').bind(memberId).run()
}

/**
 * 把一条继承记录推给目标站（来源站侧，后台开完会员后调用）。
 * 超时 3 秒、失败返回 false —— 调用方**不能**因为它失败就回滚会员授予：
 * 会员在来源站已经付过费，通道抖动最多让目标站晚一步认领（再点一次「同步」即可）。
 */
export async function pushPartnerGrant(
  url: string,
  secret: string,
  g: PartnerGrant,
  timeoutMs = 3000
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const base = url.trim().replace(/\/+$/, '')
  if (!base) return { ok: false, error: '未配置推送地址' }
  const sig = await partnerSign(secret, g)
  try {
    const res = await fetch(`${base}/api/partner/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Partner-Signature': sig },
      body: JSON.stringify(g),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      return { ok: false, error: `${res.status} ${text}` }
    }
    const data = (await res.json().catch(() => null)) as { result?: string } | null
    return { ok: true, result: data?.result }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e).slice(0, 200) }
  }
}

