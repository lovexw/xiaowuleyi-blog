/**
 * 评论圈层可见（会员档位门控评论）
 * =====================================
 * 站长定的口径：**普通会员与游客的评论对所有人可见；高档位会员的评论只在圈层内可见**——
 * 咖啡会员及以上档位的评论，只有同档及以上的会员与管理员能看到正文、能回复；游客与低档会员
 * 只看到「这里有一条 XXX 会员的评论」的占位块，正文一个字节都不下发。
 *
 * 设计取舍（都是这个仓库踩过的坑）：
 * 1. **服务端截断，不做前端遮挡**——遮罩在 applyCommentGate 里把 content 清空，SSR HTML 与
 *    微博评论 JSON 出参都是空的。前端只负责把占位块画出来（同付费墙 teaserHtml 口径）。
 * 2. **不落库、不加列**：评论列表查询本就 LEFT JOIN members 带出 member_tier /
 *    tier_expires_at，作者等级在读取瞬间用 effectiveTier 判定——档位过期即回落基础档（该会员
 *    的历史评论随之恢复公开，与付费墙「过期即时降级」同一套语义），无回填、无双写。
 * 3. **父级遮罩向下继承**：一条回复属于它所在线程的圈层（父被遮 = 子一并遮），否则「占位块
 *    下面挂着公开回复」会漏出上下文。写侧同样按**线程根**的档位判定回复权限。
 * 4. **门槛档位 key 失效时宁严勿松**：站长把该档删了 / 改了 key，未知 key 按「所有会员评论
 *    仅会员可见」处理（gateRank=1）——静默放开等于把私密评论一次性公开，是不可接受的失败方向。
 *
 * 纯函数 + Node 可直接导入（tests/commentgate.test.ts），同 tiers.ts / protect.ts 三件套模式。
 */

import { effectiveTier, tierByKey, type MemberTierDef } from './tiers'

/** 门槛关闭的等价写法：空串 / '0' / 'off' / 'all' */
const GATE_OFF_VALUES = ['', '0', 'off', 'all']

/** 参与门控判定所需的评论字段（CommentRow 的子集，纯函数不拖 D1 类型） */
export interface GateTierComment {
  id: number
  parent_id?: number | null
  is_admin?: number | null
  /** 作者的档位 key（LEFT JOIN members 带出；游客评论为空） */
  member_tier?: string | null
  member_tier_expires_at?: number | null
}

/** 遮罩出参字段（不落库，只用于出参与渲染） */
export interface GateFields {
  /** true = 本条对当前读者隐藏（正文已清空） */
  gated?: boolean
  /** 作者生效档位名（"咖啡会员"）：占位块文案用，徽标开关关掉也要有 */
  gate_tier_name?: string
  /** 被折叠的回复条数（遮罩项的子孙，全部同属私密线程） */
  gate_hidden?: number
}

/** 档位门控上下文：一次请求算一次，读侧三处（文章页 / 留言板 / 微博评论）共用 */
export interface GateContext {
  defs: MemberTierDef[]
  /** 门槛等级：0 = 关闭（什么都没遮）；>=1 = 该等级的评论进私密圈 */
  gateRank: number
  /** 当前读者等级：0 = 游客（未登录或非会员） */
  viewerRank: number
  /** 当前读者是管理员：无视一切遮罩 */
  admin: boolean
  now: number
}

/**
 * settings.commentGateTier → 门槛等级（0 = 关闭）。
 * 未知 key（档位被删 / key 被改）按最严口径 1 = 所有会员评论仅会员可见——见文件头取舍 4。
 */
export function commentGateRank(defs: MemberTierDef[], raw: string | null | undefined): number {
  const v = (raw || '').trim().toLowerCase()
  if (GATE_OFF_VALUES.includes(v)) return 0
  const def = tierByKey(defs, v)
  if (def) return def.rank ?? 1
  return 1
}

/** 会员会话 → 读者等级（0 = 游客；过期即时降级基础档，不碰 members.tier 原值） */
export function commentGateViewerRank(
  defs: MemberTierDef[],
  member: { tier?: string | null; tier_expires_at?: number | null } | null | undefined,
  now = Date.now()
): number {
  if (!member || !member.tier) return 0
  return effectiveTier(defs, member.tier, member.tier_expires_at ?? null, now).rank
}

/** 组一份门控上下文（读侧三处的唯一入口，别在调用点各算一遍） */
export function commentGateContext(
  defs: MemberTierDef[],
  raw: string | null | undefined,
  member: { tier?: string | null; tier_expires_at?: number | null } | null | undefined,
  isAdmin: boolean,
  now = Date.now()
): GateContext {
  return {
    defs,
    gateRank: commentGateRank(defs, raw),
    viewerRank: commentGateViewerRank(defs, member, now),
    admin: isAdmin,
    now,
  }
}

/** 作者的生效档位（等级 + 展示名）：游客 / 管理员评论返回 rank 0（永不进入私密圈） */
function authorTier(defs: MemberTierDef[], c: GateTierComment, now: number): { rank: number; name: string } {
  if (c.is_admin) return { rank: 0, name: '' }
  if (!c.member_tier) return { rank: 0, name: '' }
  const eff = effectiveTier(defs, c.member_tier, c.member_tier_expires_at ?? null, now)
  return { rank: eff.rank, name: eff.name }
}

/**
 * 批量判定 + 脱敏（读侧唯一出口）：
 * 返回与入参等长同序的新数组——未遮罩的行原样引用，遮罩行是清空正文的副本（带 gated /
 * gate_tier_name / gate_hidden）。**调用方必须用返回值出参/渲染**，别拿回原数组。
 */
export function applyCommentGate<T extends GateTierComment>(rows: T[], ctx: GateContext): Array<T & GateFields> {
  if (ctx.gateRank <= 0 || !rows.length || ctx.admin) return rows as Array<T & GateFields>

  const meta = new Map<number, { rank: number; name: string }>()
  for (const r of rows) meta.set(r.id, authorTier(ctx.defs, r, ctx.now))

  // ① 直接遮罩：作者等级够门槛，而读者等级不够
  const gated = new Set<number>()
  for (const r of rows) {
    const a = meta.get(r.id)!
    if (a.rank >= ctx.gateRank && ctx.viewerRank < a.rank) gated.add(r.id)
  }
  if (!gated.size) return rows as Array<T & GateFields>

  // ② 父级继承：回复永远跟着线程根走（父子链可能多级，逐轮传播直到稳定）
  const byId = new Map<number, T>()
  for (const r of rows) byId.set(r.id, r)
  for (let pass = 0; pass < rows.length; pass++) {
    let changed = false
    for (const r of rows) {
      const pid = r.parent_id || 0
      if (pid && gated.has(pid) && !gated.has(r.id)) {
        gated.add(r.id)
        changed = true
      }
    }
    if (!changed) break
  }

  // ③ 子孙计数（占位块上写「另有 N 条回复」）：只在被遮罩的行上算，且只沿本地列表走
  const kids = new Map<number, number[]>()
  for (const r of rows) {
    const pid = r.parent_id || 0
    if (!pid || !byId.has(pid)) continue
    const list = kids.get(pid)
    if (list) list.push(r.id)
    else kids.set(pid, [r.id])
  }
  const descCount = new Map<number, number>()
  const countDesc = (id: number, seen: Set<number>): number => {
    const hit = descCount.get(id)
    if (hit !== undefined) return hit
    const list = kids.get(id) || []
    let n = 0
    for (const k of list) {
      if (seen.has(k)) continue
      seen.add(k)
      n += 1 + countDesc(k, seen)
    }
    descCount.set(id, n)
    return n
  }

  return rows.map((r) => {
    if (!gated.has(r.id)) return r as T & GateFields
    const a = meta.get(r.id)!
    return {
      ...r,
      content: '',
      gated: true,
      gate_tier_name: a.name,
      gate_hidden: countDesc(r.id, new Set([r.id])),
    } as T & GateFields
  })
}

/**
 * 占位块文案（SSR 与 site.js 同一套口径，文案在这里单一来源）。
 * viewerRank 只影响第二行提示：游客让他登录，低档会员让他升级。
 */
export function commentGateText(tierName: string, viewerRank: number): { title: string; hint: string } {
  const who = tierName || '会员'
  return {
    title: `这条评论仅对${who}及以上可见`,
    hint: viewerRank > 0 ? '升级档位后可见' : '登录会员后可见',
  }
}

/** 折叠回复提示（占位块下方的灰字） */
export function commentGateMoreText(tierName: string, count: number): string {
  const who = tierName || '会员'
  return `另有 ${count} 条回复，同样仅对${who}及以上可见`
}

/**
 * 写侧判定：能不能回复这条评论（parent 是被点的那条，可见性由线程根决定）。
 * rootRank / rootTierName 传线程根的作者档位——回复一律挂线程根（publicComment 既有口径），
 * 所以「能不能进这个楼」按根的圈层判，别按被点的那条判（否则高档会员的回复会把低档会员挡在自己楼外）。
 */
export function canReplyGatedComment(
  viewerRank: number,
  isAdmin: boolean,
  root: { rank: number; name: string } | null,
  gateRank: number
): boolean {
  if (isAdmin) return true
  if (gateRank <= 0 || !root || root.rank < gateRank) return true
  return viewerRank >= root.rank
}

/** 线程根的作者档位（写侧用）：入参与 authorTier 同形，导出成稳定名字避免调用点自己拼 */
export function threadRootTier(defs: MemberTierDef[], c: GateTierComment, now = Date.now()): { rank: number; name: string } {
  return authorTier(defs, c, now)
}
