import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  claimPartnerGrants,
  cleanPartnerGrant,
  normalizeEmail,
  partnerSign,
  receivePartnerGrant,
  revokePartnerGrant,
  verifyPartnerSignature,
  type PartnerGrant,
} from '../src/partner.ts'
import type { MemberTierDef } from '../src/tiers.ts'

// ── 跨站会员继承（src/partner.ts）──
// 纯函数 + 真 SQL（node:sqlite 内存库，D1 接口用最小 shim 套上）。
// 只建 partner 相关的两张表：schema 全量一致性由 tests/member-schema.test.ts 守着，
// 这里要验的是「授予 / 待认领 / 冲突 / 只升不降」这些判定逻辑。

/** D1 → node:sqlite 的最小适配：partner.ts 只用到 prepare/bind/first/all/run */
function d1Of(sqlite: DatabaseSync): D1Database {
  function prepare(query: string) {
    let args: unknown[] = []
    const stmt = {
      bind(...a: unknown[]) {
        args = a
        return stmt
      },
      async run() {
        const r = sqlite.prepare(query).run(...(args as never[]))
        return { success: true, meta: { changes: r.changes } }
      },
      async first(col?: string) {
        const row = sqlite.prepare(query).get(...(args as never[])) as Record<string, unknown> | undefined
        if (!row) return null
        return col ? (row[col] ?? null) : row
      },
      async all() {
        const rows = sqlite.prepare(query).all(...(args as never[]))
        return { results: rows, success: true }
      },
    }
    return stmt
  }
  return { prepare } as unknown as D1Database
}

const DEFS: MemberTierDef[] = [
  { key: 'normal', name: '注册会员', color: '', permanent: true, days: 0, fallback: '', rank: 1 },
  { key: 'premium', name: '优质会员', color: '', permanent: true, days: 0, fallback: '', rank: 2 },
  { key: 'coffee', name: '咖啡会员', color: '', permanent: false, days: 365, fallback: 'premium', rank: 3 },
  { key: 'lifetime', name: '永久会员', color: '', permanent: true, days: 0, fallback: '', rank: 4 },
]

function freshDb(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE members (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT    NOT NULL UNIQUE,
      email           TEXT    NOT NULL DEFAULT '',
      tier            TEXT    NOT NULL DEFAULT 'normal',
      tier_expires_at INTEGER,
      tier_source     TEXT    NOT NULL DEFAULT '',
      remote_issuer   TEXT    NOT NULL DEFAULT '',
      remote_subject  TEXT    NOT NULL DEFAULT '',
      updated_at      INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_members_remote ON members (remote_issuer, remote_subject) WHERE remote_issuer <> '';
    CREATE TABLE partner_grants (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      issuer     TEXT    NOT NULL,
      subject    TEXT    NOT NULL,
      email      TEXT    NOT NULL DEFAULT '',
      member_id  INTEGER NOT NULL DEFAULT 0,
      tier       TEXT    NOT NULL DEFAULT '',
      note       TEXT    NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      claimed_at INTEGER
    );
    CREATE UNIQUE INDEX idx_partner_grants_subject ON partner_grants (issuer, subject);
    CREATE INDEX idx_partner_grants_email ON partner_grants (email, member_id);
  `)
  return { db: d1Of(sqlite), sqlite }
}

function addMember(sqlite: DatabaseSync, username: string, email = '', tier = 'normal'): number {
  const r = sqlite
    .prepare('INSERT INTO members (username, email, tier, updated_at) VALUES (?, ?, ?, ?)')
    .run(username, email, tier, Date.now())
  return Number(r.lastInsertRowid)
}

function grant(over: Partial<PartnerGrant> = {}): PartnerGrant {
  return {
    issuer: 'btchao',
    subject: '42',
    email: 'reader@qq.com',
    tier: 'lifetime',
    note: 'btchao 付费会员',
    exp: Date.now(),
    ...over,
  }
}

const SECRET = 'test-secret-0123456789'

test('normalizeEmail：去空白 + 小写 + 截断', () => {
  assert.equal(normalizeEmail('  Reader@QQ.com '), 'reader@qq.com')
  assert.equal(normalizeEmail(null), '')
  assert.equal(normalizeEmail(undefined), '')
  assert.equal(normalizeEmail('a'.repeat(200)).length, 100)
})

test('cleanPartnerGrant：形状与时间窗逐项把关', () => {
  const g = cleanPartnerGrant({ ...grant(), exp: Date.now() })
  assert.ok(g)
  assert.equal(g.issuer, 'btchao')
  assert.equal(g.email, 'reader@qq.com')

  // 非法 issuer（大写 / 保留形态 / 超长）
  assert.equal(cleanPartnerGrant({ ...grant(), issuer: 'BTChao' }), null)
  assert.equal(cleanPartnerGrant({ ...grant(), issuer: '1abc' }), null)
  assert.equal(cleanPartnerGrant({ ...grant(), issuer: 'a'.repeat(30) }), null)
  // 空 subject / 空 tier
  assert.equal(cleanPartnerGrant({ ...grant(), subject: '' }), null)
  assert.equal(cleanPartnerGrant({ ...grant(), tier: '' }), null)
  // 邮箱格式错 → 拒；邮箱为空 → 收（来源站会员没填邮箱，仍进待认领队列）
  assert.equal(cleanPartnerGrant({ ...grant(), email: 'not-an-email' }), null)
  assert.equal(cleanPartnerGrant({ ...grant(), email: '' })?.email, '')
  // 时间戳超出 ±5 分钟窗口
  assert.equal(cleanPartnerGrant({ ...grant(), exp: Date.now() - 10 * 60_000 }), null)
  assert.equal(cleanPartnerGrant({ ...grant(), exp: Date.now() + 10 * 60_000 }), null)
  assert.equal(cleanPartnerGrant(null), null)
})

test('签名：任一字段被改即失效，换密钥即失效', async () => {
  const g = grant()
  const sig = await partnerSign(SECRET, g)
  assert.equal(await verifyPartnerSignature(SECRET, g, sig), true)
  // 大小写归一（服务端把收到的签名 trim + lower）
  assert.equal(await verifyPartnerSignature(SECRET, g, ` ${sig.toUpperCase()} `), true)
  // 篡改邮箱 / 档位 / 主体任一字段
  assert.equal(await verifyPartnerSignature(SECRET, { ...g, email: 'evil@qq.com' }, sig), false)
  assert.equal(await verifyPartnerSignature(SECRET, { ...g, tier: 'premium' }, sig), false)
  assert.equal(await verifyPartnerSignature(SECRET, { ...g, subject: '43' }, sig), false)
  // 换密钥 / 空签名
  assert.equal(await verifyPartnerSignature('other-secret', g, sig), false)
  assert.equal(await verifyPartnerSignature(SECRET, g, ''), false)
})

test('目标站已有同邮箱会员：立刻授予永久档并落来源绑定', async () => {
  const { db, sqlite } = freshDb()
  const id = addMember(sqlite, 'reader', 'reader@qq.com')
  assert.equal(await receivePartnerGrant(db, grant(), DEFS), 'granted')
  const row = sqlite.prepare('SELECT * FROM members WHERE id = ?').get(id) as Record<string, unknown>
  assert.equal(row.tier, 'lifetime')
  assert.equal(row.tier_expires_at, null)
  assert.equal(row.tier_source, 'partner')
  assert.equal(row.remote_issuer, 'btchao')
  assert.equal(row.remote_subject, '42')
  const g = sqlite.prepare('SELECT * FROM partner_grants').get() as Record<string, unknown>
  assert.equal(g.member_id, id)
  assert.ok(g.claimed_at)
})

test('目标站还没有这个邮箱：进待认领，注册后认领一次即授予', async () => {
  const { db, sqlite } = freshDb()
  assert.equal(await receivePartnerGrant(db, grant(), DEFS), 'pending')
  const pending = sqlite.prepare('SELECT * FROM partner_grants').get() as Record<string, unknown>
  assert.equal(pending.member_id, 0)
  assert.equal(pending.claimed_at, null)

  const id = addMember(sqlite, 'newbie', 'reader@qq.com')
  assert.equal(await claimPartnerGrants(db, id, 'READER@qq.com ', DEFS), 1)
  const row = sqlite.prepare('SELECT * FROM members WHERE id = ?').get(id) as Record<string, unknown>
  assert.equal(row.tier, 'lifetime')
  // 再认领一次是幂等的：记录已不再是 member_id = 0
  assert.equal(await claimPartnerGrants(db, id, 'reader@qq.com', DEFS), 0)
})

test('邮箱为空：只入队不认领，任何会员都拿不到', async () => {
  const { db, sqlite } = freshDb()
  assert.equal(await receivePartnerGrant(db, grant({ email: '' }), DEFS), 'pending')
  const id = addMember(sqlite, 'someone', 'someone@qq.com')
  assert.equal(await claimPartnerGrants(db, id, 'someone@qq.com', DEFS), 0)
  const row = sqlite.prepare('SELECT tier FROM members WHERE id = ?').get(id) as Record<string, unknown>
  assert.equal(row.tier, 'normal')
})

test('一个来源会员只能绑一个账号：后到者拿不到，记录标记冲突', async () => {
  const { db, sqlite } = freshDb()
  const first = addMember(sqlite, 'first', 'reader@qq.com')
  assert.equal(await receivePartnerGrant(db, grant(), DEFS), 'granted')
  // 同邮箱又注册了一个账号（邮箱没有唯一约束），认领时应被反向唯一挡住
  const second = addMember(sqlite, 'second', 'reader@qq.com')
  sqlite.prepare('UPDATE partner_grants SET member_id = 0, claimed_at = NULL WHERE member_id = ?').run(first)
  assert.equal(await claimPartnerGrants(db, second, 'reader@qq.com', DEFS), 0)
  const g = sqlite.prepare('SELECT member_id FROM partner_grants').get() as Record<string, unknown>
  assert.equal(g.member_id, -1)
  const row = sqlite.prepare('SELECT tier FROM members WHERE id = ?').get(second) as Record<string, unknown>
  assert.equal(row.tier, 'normal')
})

test('只升不降：会员本来就在更高档时只记绑定，不动档位', async () => {
  const { db, sqlite } = freshDb()
  const id = addMember(sqlite, 'vip', 'reader@qq.com', 'premium')
  assert.equal(await receivePartnerGrant(db, grant({ tier: 'premium' }), DEFS), 'granted')
  // 目标档与现有档同级 → 不降也不升，但绑定要落下
  const row = sqlite.prepare('SELECT * FROM members WHERE id = ?').get(id) as Record<string, unknown>
  assert.equal(row.tier, 'premium')
  assert.equal(row.remote_issuer, 'btchao')
})

test('同 (issuer, subject) 重复推送是更新而不是新增', async () => {
  const { db, sqlite } = freshDb()
  await receivePartnerGrant(db, grant(), DEFS)
  await receivePartnerGrant(db, grant({ email: 'newmail@qq.com', note: '改邮箱' }), DEFS)
  const n = sqlite.prepare('SELECT COUNT(*) AS n FROM partner_grants').get() as Record<string, unknown>
  assert.equal(n.n, 1)
  const g = sqlite.prepare('SELECT * FROM partner_grants').get() as Record<string, unknown>
  assert.equal(g.email, 'newmail@qq.com')
})

test('目标站没定义这一档：回 unknown-tier，不写任何记录', async () => {
  const { db, sqlite } = freshDb()
  addMember(sqlite, 'reader', 'reader@qq.com')
  assert.equal(await receivePartnerGrant(db, grant({ tier: 'nonexistent' }), DEFS), 'unknown-tier')
  const n = sqlite.prepare('SELECT COUNT(*) AS n FROM partner_grants').get() as Record<string, unknown>
  assert.equal(n.n, 0)
})

test('限时档拒收：把年费档接成永久等于偷偷续命', async () => {
  const { db, sqlite } = freshDb()
  const id = addMember(sqlite, 'reader', 'reader@qq.com')
  // coffee 在 DEFS 里是 365 天档：接进来会因为「永久档清空有效期」白送终身权益
  assert.equal(await receivePartnerGrant(db, grant({ tier: 'coffee' }), DEFS), 'unknown-tier')
  const row = sqlite.prepare('SELECT tier FROM members WHERE id = ?').get(id) as Record<string, unknown>
  assert.equal(row.tier, 'normal')
})

test('撤销继承：档位回基础档，绑定清空，记录退回待认领', async () => {
  const { db, sqlite } = freshDb()
  const id = addMember(sqlite, 'reader', 'reader@qq.com')
  await receivePartnerGrant(db, grant(), DEFS)
  await revokePartnerGrant(db, id, 'normal')
  const row = sqlite.prepare('SELECT * FROM members WHERE id = ?').get(id) as Record<string, unknown>
  assert.equal(row.tier, 'normal')
  assert.equal(row.remote_issuer, '')
  assert.equal(row.remote_subject, '')
  const g = sqlite.prepare('SELECT * FROM partner_grants').get() as Record<string, unknown>
  assert.equal(g.member_id, 0)
  assert.equal(g.claimed_at, null)
})
