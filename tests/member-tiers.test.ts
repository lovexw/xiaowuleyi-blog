import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { canReadTiers, effectiveTier, parseMemberTiers } from '../src/tiers'
import {
  listMemberComments,
  listMemberLikes,
  listMemberReplies,
  listMemberVisits,
  recordMemberLike,
  recordMemberVisit,
  removeMemberLike,
  saveSettings,
} from '../src/db'

/* ── 会员 3.0 预备：自定义档位时效 / 会员回复 / 点赞与足迹（真库薄壳，同 tests/fanrank.test.ts） ── */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

// api.ts 经 render.ts 引主题（.css）——先挂顶替 hook 再动态加载（同 tests/themes.test.ts）
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))

function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, import('node:sqlite').StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      const info = stmtOf(sql).run(...(binds as never[]))
      return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } }
    },
    all: async <T>() => ({ results: stmtOf(sql).all(...(binds as never[])) as T[] }),
    first: async <T>() => ((stmtOf(sql).get(...(binds as never[])) as T | undefined) ?? null),
  })
  return {
    prepare: (sql: string) => {
      const unbound = handlers(sql, [])
      return { ...unbound, bind: (...binds: unknown[]) => handlers(sql, binds) }
    },
    batch: async (stmts: { run: () => Promise<{ meta: { changes: number } }> }[]) => {
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  } as unknown as D1Database
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function setupDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  const { ensureSchema } = await import('../src/db')
  await ensureSchema(d1)
  await saveSettings(d1, { membersEnabled: '1' })
  // 两篇测试文：公开一篇、付费会员档锁一篇；分类不参与
  const now = Date.now()
  await d1
    .prepare(
      "INSERT INTO posts (slug, title, content, status, min_tier, published_at, created_at, updated_at) VALUES ('open-post', '公开文', '<p>hi</p>', 'published', 'all', ?, ?, ?)"
    )
    .bind(now, now, now)
    .run()
  await d1
    .prepare(
      "INSERT INTO posts (slug, title, content, status, min_tier, published_at, created_at, updated_at) VALUES ('paid-post', '付费文', '<p>secret</p>', 'published', 'coffee', ?, ?, ?)"
    )
    .bind(now, now, now)
    .run()
  return { db, d1 }
}

async function registerMember(d1: D1Database, username: string): Promise<string> {
  const { api } = await import('../src/api')
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
    const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never
  const res = await api.request(
    'https://x.example.com/member/register',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username, password: 'member-pass-123', email: `${username}@example.com` }) },
    env,
    ec
  )
  assert.equal(res.status, 200, `注册 ${username} 失败：${await res.text()}`)
  return (res.headers.get('set-cookie') || '').split(';')[0]
}

test('注册开关：memberRegOpen=0 时注册 403（老会员登录不受影响口径在端点分支）', async () => {
  const { db, d1 } = await setupDb()
  const { api } = await import('../src/api')
  await saveSettings(d1, { memberRegOpen: '0' })
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
    const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never
  const res = await api.request(
    'https://x.example.com/member/register',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'late01', password: 'member-pass-123' }) },
    env,
    ec
  )
  assert.equal(res.status, 403)
  assert.equal(((await res.json()) as { error: string }).error.includes('注册'), true)
})

test('会员回复链路：会员可回复楼中楼、游客回复被拒、被回复方在「收到的回复」里能看到', async () => {
  const { db, d1 } = await setupDb()
  const cookieA = await registerMember(d1, 'replya')
  const cookieB = await registerMember(d1, 'replyb')
  const { api } = await import('../src/api')
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
    const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never

  // A 在公开文留言（先审后展关着 = 即时展示）
  const c1 = await api.request(
    'https://x.example.com/public/comments',
    { method: 'POST', headers: { ...JSON_HEADERS, Cookie: cookieA }, body: JSON.stringify({ slug: 'open-post', content: 'A 的主楼' }) },
    env,
    ec
  )
  assert.equal(c1.status, 200)
  const commentId = db.prepare("SELECT id FROM comments WHERE content = 'A 的主楼'").get() as { id: number }

  // B 回复 A 的评论 → 200
  const r1 = await api.request(
    'https://x.example.com/public/comments',
    { method: 'POST', headers: { ...JSON_HEADERS, Cookie: cookieB }, body: JSON.stringify({ slug: 'open-post', content: 'B 回复 A', parentId: commentId.id }) },
    env,
    ec
  )
  assert.equal(r1.status, 200)

  // 游客回复 → 403（会员 3.0 只放开会员，不放开游客）
  const g1 = await api.request(
    'https://x.example.com/public/comments',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ slug: 'open-post', content: '游客想回复', nickname: '游客', parentId: commentId.id }) },
    env,
    ec
  )
  assert.equal(g1.status, 403)

  // A 的「收到的回复」含 B 那条；B 的不含自己的
  const repliesA = await listMemberReplies(d1, (db.prepare("SELECT id FROM members WHERE username = 'replya'").get() as { id: number }).id)
  assert.equal(repliesA.length, 1)
  assert.equal(repliesA[0].content, 'B 回复 A')
  assert.equal(repliesA[0].nickname, 'replyb')
  assert.equal(repliesA[0].postSlug, 'open-post')
  // 线程根作者档位随行带出（P3-26 圈层过滤的数据契约）：B 是默认注册档、线程根是 A
  assert.ok('rootTier' in repliesA[0], 'rootTier 字段必须在场（pages.ts 圈层过滤依赖）')
  const repliesB = await listMemberReplies(d1, (db.prepare("SELECT id FROM members WHERE username = 'replyb'").get() as { id: number }).id)
  assert.equal(repliesB.length, 0, '自己发的回复不进自己的收件箱')

  // A 的「我的评论」两路都看得到（主楼 + 收到回复的主楼仍是自己的评论）
  const mineA = await listMemberComments(d1, (db.prepare("SELECT id FROM members WHERE username = 'replya'").get() as { id: number }).id)
  assert.equal(mineA.length, 1)
  assert.equal(mineA[0].postTitle, '公开文')
})

test('会员开关守卫：membersEnabled=0 时残留会员会话按游客发言、不计分（P1-3）', async () => {
  const { db, d1 } = await setupDb()
  const cookie = await registerMember(d1, 'legacy01')
  const { api } = await import('../src/api')
  await saveSettings(d1, { membersEnabled: '0' })
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
  const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never

  // 浏览器里残留 xw_member_session 的用户在公开留言接口发言 → 必须走游客路径
  const res = await api.request(
    'https://x.example.com/public/comments',
    {
      method: 'POST',
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: JSON.stringify({ slug: 'open-post', content: '关闭后的留言', nickname: '旧会员' }),
    },
    env,
    ec
  )
  assert.equal(res.status, 200, `应按游客放行：${await res.text()}`)
  const row = db.prepare("SELECT member_id, nickname FROM comments WHERE content = '关闭后的留言'").get() as {
    member_id: number | null
    nickname: string
  }
  assert.ok(!row.member_id, '不得以会员身份落库（游客口径 member_id=0）')
  assert.equal(row.nickname, '旧会员', '按游客路径使用表单昵称')
  const mid = (db.prepare("SELECT id FROM members WHERE username = 'legacy01'").get() as { id: number }).id
  const pointsBefore = (
    db.prepare('SELECT COUNT(*) AS n FROM member_points_log WHERE member_id = ?').get(mid) as { n: number }
  ).n
  // 关闭态发言不得新增积分（注册本身记的每日登录积分不算；此时还没跑对照组）
  const pointsAfterClosed = (
    db.prepare('SELECT COUNT(*) AS n FROM member_points_log WHERE member_id = ?').get(mid) as { n: number }
  ).n
  assert.equal(pointsAfterClosed, pointsBefore, '关闭会员后发言不得新增任何积分')

  // 对照组：开关重新打开后同一会员发言照常落 member_id（防线只针对关闭态，不影响正常功能）
  await saveSettings(d1, { membersEnabled: '1' })
  const res2 = await api.request(
    'https://x.example.com/public/comments',
    {
      method: 'POST',
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: JSON.stringify({ slug: 'open-post', content: '开启后的留言' }),
    },
    env,
    ec
  )
  assert.equal(res2.status, 200, `开启后会员发言应正常：${await res2.text()}`)
  const row2 = db.prepare("SELECT member_id FROM comments WHERE content = '开启后的留言'").get() as {
    member_id: number | null
  }
  assert.equal(row2.member_id, mid, '开启后会员身份恢复')
})

test('会员点赞链路：点赞记账 / 取消赞删行 / 足迹同日去重', async () => {
  const { db, d1 } = await setupDb()
  const cookie = await registerMember(d1, 'liker01')
  const { api } = await import('../src/api')
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
    const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never
  const memberId = (db.prepare("SELECT id FROM members WHERE username = 'liker01'").get() as { id: number }).id

  // 点赞公开文 → 记账
  const like1 = await api.request(
    'https://x.example.com/public/like/open-post',
    { method: 'POST', headers: { ...JSON_HEADERS, Cookie: cookie }, body: JSON.stringify({ delta: 1 }) },
    env,
    ec
  )
  assert.equal(like1.status, 200)
  await Promise.allSettled(tasks) // waitUntil 的点赞记账是异步的，断言前收水
  const likes1 = await listMemberLikes(d1, memberId)
  assert.equal(likes1.length, 1)
  assert.equal(likes1[0].targetType, 'post')
  assert.equal(likes1[0].slug, 'open-post')

  // 重复点赞幂等（唯一索引）
  await recordMemberLike(d1, memberId, 'post', (db.prepare("SELECT id FROM posts WHERE slug = 'open-post'").get() as { id: number }).id, Date.now())
  assert.equal((await listMemberLikes(d1, memberId)).length, 1)

  // 取消赞 → 删行
  const like2 = await api.request(
    'https://x.example.com/public/like/open-post',
    { method: 'POST', headers: { ...JSON_HEADERS, Cookie: cookie }, body: JSON.stringify({ delta: -1 }) },
    env,
    ec
  )
  assert.equal(like2.status, 200)
  await Promise.allSettled(tasks)
  assert.equal((await listMemberLikes(d1, memberId)).length, 0)
  await removeMemberLike(d1, memberId, 'post', 999999) // 不存在的目标静默

  // 浏览足迹：同文同日两行合一（去重键 member_id+post_id+day）
  await recordMemberVisit(d1, memberId, 1, '第一次标题', '2026-10-21', 1000)
  await recordMemberVisit(d1, memberId, 1, '第二次标题', '2026-10-21', 2000)
  await recordMemberVisit(d1, memberId, 2, '另一篇', '2026-10-21', 3000)
  const visits = await listMemberVisits(d1, memberId)
  assert.equal(visits.length, 2)
  assert.equal(visits[0].postId, 2, '最新浏览在前')
  const first = visits.find((v) => v.postId === 1)
  assert.equal(first?.title, '第二次标题', '同日重复浏览刷新标题快照')
})

test('档位时效链路：过期会员读不了付费档（canReadTiers），后台改档位带有效期生效', async () => {
  const { db, d1 } = await setupDb()
  const { api } = await import('../src/api')
  const defs = parseMemberTiers(undefined)
  const now = Date.now()

  // 直接落两个会员：一个 top 已过期、一个 top 未过期（绕开注册走 db 直插，聚焦判定）
  const { hashPassword } = await import('../src/auth')
  const { hash, salt } = await hashPassword('member-pass-123')
  const ins = async (username: string, tier: string, exp: number | null) => {
    await d1
      .prepare(
        "INSERT INTO members (username, password_hash, salt, email, display_name, avatar, tier, tier_expires_at, points, status, created_at, updated_at) VALUES (?, ?, ?, '', ?, '', ?, ?, 0, 'active', ?, ?)"
      )
      .bind(username, hash, salt, username, tier, exp, now, now)
      .run()
  }
  await ins('expired1', 'coffee', now - 1000)
  await ins('living1', 'coffee', now + 86_400_000)
  const expiredRow = db.prepare("SELECT * FROM members WHERE username = 'expired1'").get() as { id: number; tier: string; tier_expires_at: number }
  const livingRow = db.prepare("SELECT * FROM members WHERE username = 'living1'").get() as { id: number; tier: string; tier_expires_at: number }

  assert.equal(canReadTiers(defs, 'coffee', expiredRow, now), false, '过期会员读不了咖啡档')
  assert.equal(canReadTiers(defs, 'member', expiredRow, now), true, '过期会员仍算登录会员')
  assert.equal(canReadTiers(defs, 'coffee', livingRow, now), true, '未过期会员正常可读')
  assert.equal(effectiveTier(defs, 'coffee', expiredRow.tier_expires_at, now).expired, true)
  assert.equal(effectiveTier(defs, 'coffee', expiredRow.tier_expires_at, now).key, 'premium', '到期不消失，降到优质会员')

  // 管理员改档位：PUT 带 tierExpiresAt 日期串 → 落库生效
  const { createSession } = await import('../src/auth')
  await d1.prepare("INSERT INTO users (username, password_hash, salt, display_name, role, created_at, updated_at) VALUES ('admin', 'x', 'y', '站长', 'admin', ?, ?)").bind(now, now).run()
  const adminId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number }).id
  const adminToken = await createSession(d1, adminId)
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
    const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never

  const put1 = await api.request(
    `https://x.example.com/admin/members/${expiredRow.id}`,
    { method: 'PUT', headers: { ...JSON_HEADERS, Cookie: `bloghao_session=${adminToken}` }, body: JSON.stringify({ tier: 'coffee', tierExpiresAt: '2027-10-21' }) },
    env,
    ec
  )
  assert.equal(put1.status, 200, `分配档位失败：${await put1.text()}`)
  const after = db.prepare("SELECT tier, tier_expires_at FROM members WHERE id = ?").get(expiredRow.id) as { tier: string; tier_expires_at: number }
  assert.equal(after.tier, 'coffee')
  // 2027-10-21 23:59:59 北京时间 = 15:59:59 UTC
  assert.equal(after.tier_expires_at, Date.UTC(2027, 9, 21, 15, 59, 59))

  // 永久档自动清有效期；未知档位 400
  await api.request(
    `https://x.example.com/admin/members/${expiredRow.id}`,
    { method: 'PUT', headers: { ...JSON_HEADERS, Cookie: `bloghao_session=${adminToken}` }, body: JSON.stringify({ tier: 'normal' }) },
    env,
    ec
  )
  const after2 = db.prepare('SELECT tier, tier_expires_at FROM members WHERE id = ?').get(expiredRow.id) as { tier: string; tier_expires_at: number | null }
  assert.equal(after2.tier, 'normal')
  assert.equal(after2.tier_expires_at, null, '永久档强制清有效期')
  const putBad = await api.request(
    `https://x.example.com/admin/members/${expiredRow.id}`,
    { method: 'PUT', headers: { ...JSON_HEADERS, Cookie: `bloghao_session=${adminToken}` }, body: JSON.stringify({ tier: 'ghost' }) },
    env,
    ec
  )
  assert.equal(putBad.status, 400)
})

test('设置 PUT：memberTiers 走 cleanMemberTiers 校验（合法入库 / 非法 400）', async () => {
  const { db, d1 } = await setupDb()
  const { api } = await import('../src/api')
  const now = Date.now()
  const { createSession } = await import('../src/auth')
  await d1.prepare("INSERT INTO users (username, password_hash, salt, display_name, role, created_at, updated_at) VALUES ('admin', 'x', 'y', '站长', 'admin', ?, ?)").bind(now, now).run()
  const adminId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number }).id
  const adminToken = await createSession(d1, adminId)
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
    const tasks: Promise<unknown>[] = []
  const ec = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} } as never
  const auth = { ...JSON_HEADERS, Cookie: `bloghao_session=${adminToken}` }

  const good = await api.request(
    'https://x.example.com/admin/settings',
    {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({
        memberTiers: JSON.stringify([
          { key: 'normal', name: '普通会员', permanent: true, days: 0 },
          { key: 'silver', name: '白银会员', color: '#abc', permanent: false, days: 90 },
        ]),
      }),
    },
    env,
    ec
  )
  assert.equal(good.status, 200, `合法档位保存失败：${await good.text()}`)
  const stored = (db.prepare("SELECT value FROM settings WHERE key = 'memberTiers'").get() as { value: string }).value
  const defs = parseMemberTiers(stored)
  assert.equal(defs[1].key, 'silver')
  assert.equal(defs[1].color, '#abc')

  const bad = await api.request(
    'https://x.example.com/admin/settings',
    { method: 'PUT', headers: auth, body: JSON.stringify({ memberTiers: '[{"key":"member","name":"冒名","permanent":true,"days":0}]' }) },
    env,
    ec
  )
  assert.equal(bad.status, 400, '保留字 key 必须被拒')
})

test('注册邮箱：必填 / 格式 / 一邮箱一账号 / 入库转小写', async () => {
  const { db, d1 } = await setupDb()
  const { api } = await import('../src/api')
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
  const ec = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  // 每次换 IP：注册限流是「每 IP 10 分钟 5 次」，本用例会超这个额度
  let seq = 0
  const reg = (body: Record<string, unknown>) =>
    api.request(
      'https://x.example.com/member/register',
      { method: 'POST', headers: { ...JSON_HEADERS, 'CF-Connecting-IP': `10.77.0.${++seq}` }, body: JSON.stringify(body) },
      env,
      ec
    )

  // 缺邮箱：邮箱是跨站会员继承唯一的身份凭据，不能空着注册
  const noMail = await reg({ username: 'nomail01', password: 'member-pass-123' })
  assert.equal(noMail.status, 400)
  assert.match(((await noMail.json()) as { error: string }).error, /邮箱/)

  const badMail = await reg({ username: 'badmail01', password: 'member-pass-123', email: 'not-a-mail' })
  assert.equal(badMail.status, 400)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members WHERE username = 'badmail01'").get<{ n: number }>()?.n, 0)

  // 正常注册：前后空白与大小写归一后入库
  const ok = await reg({ username: 'MixedMail', password: 'member-pass-123', email: '  MiXeD@Example.COM  ' })
  assert.equal(ok.status, 200, await ok.clone().text())
  const row = db.prepare("SELECT email FROM members WHERE username = 'MixedMail'").get() as { email: string }
  assert.equal(row.email, 'mixed@example.com', '入库统一小写：跨站认领按 LOWER(email) 比对')

  // 同邮箱（大小写不同也算同一个）不能注册第二个账号：
  // 跨站认领是先到先得，同邮箱双账号会让「谁拿权益」变成竞态
  const dup = await reg({ username: 'mixedmail2', password: 'member-pass-123', email: 'MIXED@example.com' })
  assert.equal(dup.status, 400)
  assert.match(((await dup.json()) as { error: string }).error, /邮箱已被/)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members WHERE username = 'mixedmail2'").get<{ n: number }>()?.n, 0, '被拒的注册不留半成品会员')
})
