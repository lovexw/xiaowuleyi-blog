import type { SessionUser } from './types'
import { sha256Hex } from './utils'

const enc = new TextEncoder()
const PBKDF2_ITERATIONS = 100_000 // Workers 上限即 10 万次

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** 会话 token 落库一律存 SHA-256：D1 里的 sessions 不再有可直接
 *  重放的明文 token（库泄露 ≠ 会话被冒用）；查询时对 Cookie 里的 token 同样哈希后比对 */
export function tokenHash(token: string): Promise<string> {
  return sha256Hex(enc.encode(token).buffer as ArrayBuffer)
}

export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const s = salt ?? randomToken(16)
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(s), iterations: PBKDF2_ITERATIONS },
    key,
    256
  )
  const hash = Array.from(new Uint8Array(bits), (x) => x.toString(16).padStart(2, '0')).join('')
  return { hash, salt: s }
}

/** 常量时间字符串比较：长度不等时同样扫完（时间与等长情形一致，不泄露长度差） */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const len = Math.max(a.length, b.length)
  let r = a.length === b.length ? 0 : 1
  for (let i = 0; i < len; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return r === 0
}

export const SESSION_COOKIE = 'bloghao_session'
const SESSION_TTL = 30 * 24 * 3600 * 1000 // 30 天

/** 会话 Cookie 是否加 Secure：https 直连（Workers 生产恒为 https）或可信反代告知 https
 *  （Caddy 默认会设 X-Forwarded-Proto）时加；明文 http 不加——Secure 在非 https 源会被浏览器
 *  直接丢弃，手机连局域网 IP（http://192.168.x.x）登录/签到会全废。docker-poc 的 server.ts
 *  shim 已有同口径决策（isHttps 由 resolveScheme 判定后摘 Secure），这里是 Worker 侧的同一条。 */
export function isSecureRequest(req: Request): boolean {
  if (new URL(req.url).protocol === 'https:') return true
  return req.headers.get('X-Forwarded-Proto') === 'https'
}

export function getCookie(req: Request, name: string): string | null {
  const h = req.headers.get('Cookie') || ''
  for (const part of h.split(/; */)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim())
      } catch {
        return part.slice(i + 1).trim()
      }
    }
  }
  return null
}

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = randomToken(32)
  const expires = Date.now() + SESSION_TTL
  await db
    .prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await tokenHash(token), userId, expires, Date.now())
    .run()
  return token
}

export function sessionCookie(token: string, secure = true): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export async function getSessionUser(db: D1Database, req: Request): Promise<SessionUser | null> {
  const token = getCookie(req, SESSION_COOKIE)
  if (!token) return null
  return db
    .prepare(
      'SELECT u.id, u.username, u.display_name, u.avatar FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
    )
    .bind(await tokenHash(token), Date.now())
    .first<SessionUser>()
}

export async function destroySession(db: D1Database, req: Request): Promise<void> {
  const token = getCookie(req, SESSION_COOKIE)
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await tokenHash(token)).run()
}

/** 清理已过期会话（随每晚备份 cron 跑一次即可），防止 sessions 表无限增长 */
export async function purgeExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run()
}

/** 改密码后踢掉其他设备：保留当前会话（改密码的人自己不能被登出去），其余全部失效。
 *  keepToken 是 Cookie 里的明文 token——落库存的是 SHA-256（tokenHash），比较前必须先哈希
 *  （拿明文直比恒不相等，会把「保留当前会话」写成「删光全部会话」） */
export async function destroyOtherSessions(db: D1Database, userId: number, keepToken: string): Promise<void> {
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
    .bind(userId, await tokenHash(keepToken))
    .run()
}

/**
 * 简单内存限流（按作用域生效，尽力而为）。
 * scope 传请求的 env 实例：Workers 每 isolate 一份 env（行为与历史一致）；
 * docker-poc 单进程多租户每租户一份 env——同 IP 的限流桶从此不跨站点共享
 * （2026-11 全项目审计 P0-1：A 站登录失败曾会锁死 B 站同 IP 用户，backup:global
 * 等字面量桶跨站互斥）。key => 每窗口最多 limit 次。
 * 调用方一律传 c.env，别在 key 里手工拼 host（scope 维度统一在这层处理）。
 */
const bucketScopes = new WeakMap<object, Map<string, { n: number; reset: number }>>()
export function rateLimit(scope: object, key: string, limit: number, windowMs: number): boolean {
  let buckets = bucketScopes.get(scope)
  if (!buckets) {
    buckets = new Map()
    bucketScopes.set(scope, buckets)
  }
  const now = Date.now()
  // 淘汰在插入时执行：先清过期项；仍超容量则丢最旧的，保证 Map 有界
  if (buckets.size >= 5000) {
    for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k)
    while (buckets.size >= 5000) {
      const oldest = buckets.keys().next().value
      if (oldest === undefined) break
      buckets.delete(oldest)
    }
  }
  const e = buckets.get(key)
  if (!e || e.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs })
    return true
  }
  if (e.n >= limit) return false
  e.n++
  return true
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ||
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  )
}
