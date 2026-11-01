#!/usr/bin/env node
/**
 * 会员档位迁移（2026-11，v2.9 一批）
 * ==================================
 * 把旧三档「普通会员 / 咖啡会员 / 付费会员（top）」迁成新三档
 * 「注册会员 / 优质会员 / 咖啡会员」，并把历史数据里的 tier / min_tier = 'top'
 * 改写为 'premium'（优质会员）；顺带补齐会员第五批的结构（tier_source 列、
 * invite_uses 表、邀请码的 max_uses / used_count）。
 *
 * 为什么要脚本：**档位定义存在 settings.memberTiers**（JSON），线上已经是老的三档，
 * 光改代码里的默认值不会影响已有站点——库里那份 JSON 才是事实源。而旧键 'top'
 * 在新定义里不存在，不迁移的话原来设过『付费会员可见』的文章会按最高档兜底（读侧
 * minTierRank 的保守映射），老 top 会员则会掉到基础档。
 *
 * 两段式（--phase），对应上线顺序：
 *   ① ddl  只加表加列 + 回填计数。纯增量，**对还在跑的旧代码完全无感** → 部署前先跑
 *   ② data 档位定义替换 / 'top' 数据改写 / 换页缓存。**旧代码读到新档位会掉权** → 部署后跑
 * 缺省 all（两段连着跑，适合本地或一次性补课）。
 *
 * 幂等：跑第二遍不会重复改写（已经是新定义就跳过；'top' 行改完就没了；列已存在不再 ALTER）。
 * 自定义过档位的站不会被覆盖：只有 key 序列恰好是旧三档时才替换定义，其余情况只提示。
 *
 * 用法（在项目根目录，已登录 wrangler）：
 *   node scripts/migrate-tiers-3.mjs --local --dry-run     # 本地库体检，不改
 *   node scripts/migrate-tiers-3.mjs --local              # 本地库执行
 *   node scripts/migrate-tiers-3.mjs --phase=ddl           # 线上：只加结构（部署前）
 *   node scripts/migrate-tiers-3.mjs --phase=data          # 线上：只改数据（部署后）
 *   node scripts/migrate-tiers-3.mjs                       # 线上：两段一起（默认 --phase=all）
 *   node scripts/migrate-tiers-3.mjs --dry-run            # 线上库体检
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const args = process.argv.slice(2)
const local = args.includes('--local')
const dryRun = args.includes('--dry-run')
const target = local ? '--local' : '--remote'
const phaseArg = (args.find((a) => a.startsWith('--phase=')) || '--phase=all').split('=')[1]
if (!['all', 'ddl', 'data'].includes(phaseArg)) {
  console.error('--phase 只支持 ddl / data / all')
  process.exit(1)
}
const doDdl = phaseArg === 'all' || phaseArg === 'ddl'
const doData = phaseArg === 'all' || phaseArg === 'data'

/** 新三档（与 src/tiers.ts DEFAULT_MEMBER_TIERS 保持一致） */
const NEW_TIERS = [
  { key: 'normal', name: '注册会员', color: '', permanent: true, days: 0, fallback: '', rank: 1 },
  { key: 'premium', name: '优质会员', color: '#2f7fd0', permanent: true, days: 0, fallback: '', rank: 2 },
  { key: 'coffee', name: '咖啡会员', color: '#c9803e', permanent: false, days: 365, fallback: 'premium', rank: 3 },
]
const OLD_KEYS = ['normal', 'coffee', 'top']

/** 跑一条 D1 SQL 并返回结果行；wrangler 的 --json 输出是 [{results:[...]}] */
async function d1(sql) {
  const { stdout } = await run('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--json', '--command', sql], {
    maxBuffer: 32 * 1024 * 1024,
  })
  // wrangler 偶尔会在 JSON 前面打进度行，只取第一段 '[' 开始的内容
  const text = stdout.slice(stdout.indexOf('['))
  return JSON.parse(text)
}
const rows = async (sql) => (await d1(sql))[0]?.results ?? []
const esc = (s) => String(s).replace(/'/g, "''")

/** 执行写操作（dry-run 时只打印） */
async function exec(sql, label) {
  if (dryRun) {
    console.log(`  [dry-run] ${label}`)
    return
  }
  await d1(sql)
  console.log(`  ✓ ${label}`)
}

const main = async () => {
  console.log(
    `\n会员迁移 → ${local ? '本地库（--local）' : '线上库（--remote）'} · 阶段 ${phaseArg}${dryRun ? ' · 仅体检' : ''}\n`
  )

  /* ───────── 结构段（部署前跑；纯增量，旧代码无感） ───────── */
  if (doDdl) {
    console.log('【结构】')
    // 邀请码表：全新站会在这里被建出来（线上多半还没有这张表）；老形态的站 IF NOT EXISTS 不做事，
    // 缺的列由后面的 ALTER 补
    await exec(
      `CREATE TABLE IF NOT EXISTS invite_codes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        code         TEXT    NOT NULL UNIQUE,
        tier         TEXT    NOT NULL DEFAULT 'premium',
        note         TEXT    NOT NULL DEFAULT '',
        max_uses     INTEGER NOT NULL DEFAULT 1,
        used_count   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER,
        used_at      INTEGER,
        used_by      INTEGER NOT NULL DEFAULT 0,
        used_by_name TEXT    NOT NULL DEFAULT ''
      )`,
      '建表 invite_codes（无则建）'
    )
    await exec(
      `CREATE TABLE IF NOT EXISTS invite_uses (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        invite_id   INTEGER NOT NULL,
        code        TEXT    NOT NULL DEFAULT '',
        member_id   INTEGER NOT NULL DEFAULT 0,
        member_name TEXT    NOT NULL DEFAULT '',
        tier        TEXT    NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL
      )`,
      '建表 invite_uses（无则建）'
    )

    // ALTER TABLE 没有 IF NOT EXISTS，先查 PRAGMA 再决定加不加（SQLite 重复加列会直接报错）
    const colsOf = async (table) => new Set((await rows(`PRAGMA table_info(${table})`)).map((r) => r.name))
    const mCols = await colsOf('members')
    if (!mCols.has('tier_source')) {
      await exec("ALTER TABLE members ADD COLUMN tier_source TEXT NOT NULL DEFAULT ''", 'members 加列 tier_source')
    } else {
      console.log("  · members.tier_source 已存在")
    }
    const iCols = await colsOf('invite_codes')
    for (const [col, ddl] of [
      ['max_uses', 'ALTER TABLE invite_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1'],
      ['used_count', 'ALTER TABLE invite_codes ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!iCols.has(col)) await exec(ddl, `invite_codes 加列 ${col}`)
      else console.log(`  · invite_codes.${col} 已存在`)
    }

    // 回填：老库的 used_at 非空就是「已经用过一次」，计数得跟上，否则旧码会变成「还能再用」。
    // dry-run 时列还没真加上，这条查询必然报错 → 直接跳过（体检只需要知道会做这一步）
    if (dryRun) {
      console.log('  [dry-run] 回填旧码的已用次数（used_at 非空 → used_count = 1）')
    } else {
      const backfill = (await rows('SELECT COUNT(*) AS n FROM invite_codes WHERE used_at IS NOT NULL AND used_count = 0'))[0]?.n ?? 0
      if (backfill) await exec('UPDATE invite_codes SET used_count = 1 WHERE used_at IS NOT NULL AND used_count = 0', `回填 ${backfill} 个旧码的已用次数`)
      else console.log('  · 没有需要回填的旧码')
    }

    await exec('CREATE INDEX IF NOT EXISTS idx_invite_uses_invite ON invite_uses (invite_id, created_at DESC)', '建索引 idx_invite_uses_invite')
    console.log(doData ? '' : '\n结构段完成（数据段未跑）。\n')
  }

  if (!doData) {
    if (dryRun) console.log('体检完成，未做任何改动。\n')
    return
  }
  console.log('【数据】')

  // ① 档位定义：只在「还是旧默认三档」时替换，自定义过的不动
  const defRows = await rows("SELECT value FROM settings WHERE key = 'memberTiers'")
  const raw = defRows[0]?.value || ''
  let keys = []
  try {
    keys = raw ? JSON.parse(raw).map((d) => d.key) : []
  } catch {
    keys = []
  }
  if (!raw.trim()) {
    console.log('① 档位定义：库里没存过（走代码默认，已经是新三档），无需迁移')
  } else if (JSON.stringify(keys) === JSON.stringify(OLD_KEYS)) {
    await exec(
      `INSERT INTO settings (key, value) VALUES ('memberTiers', '${esc(JSON.stringify(NEW_TIERS))}') ` +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      '档位定义 普通/咖啡/付费 → 注册/优质/咖啡'
    )
  } else if (JSON.stringify(keys) === JSON.stringify(NEW_TIERS.map((d) => d.key))) {
    console.log(`① 档位定义：已是新三档（${keys.join(' / ')}），跳过`)
  } else {
    console.log(`① 档位定义：检测到自定义档位（${keys.join(' / ')}），不覆盖。`)
    console.log('   如需切成新三档，请到「后台 → 会员 → 会员设置」手动调整；')
    console.log("   老 key 'top' 的会员要手动改成目标档位（本脚本仍会改写 tier='top' 的数据行）")
  }

  // ② 会员档位：'top' → 'premium'
  const mCnt = (await rows("SELECT COUNT(*) AS n FROM members WHERE tier = 'top'"))[0]?.n ?? 0
  if (mCnt) await exec("UPDATE members SET tier = 'premium', updated_at = " + Date.now() + " WHERE tier = 'top'", `${mCnt} 位会员 top → premium`)
  else console.log('② 会员档位：没有 tier=\'top\' 的会员')

  // ③ 文章付费墙档位：'top' → 'premium'
  const pCnt = (await rows("SELECT COUNT(*) AS n FROM posts WHERE min_tier = 'top'"))[0]?.n ?? 0
  if (pCnt) await exec("UPDATE posts SET min_tier = 'premium' WHERE min_tier = 'top'", `${pCnt} 篇文章 min_tier top → premium`)
  else console.log("③ 文章档位：没有 min_tier='top' 的文章")

  // ④ 换一代页缓存，否则边缘还挂着用旧档位名渲染的页面
  if (!dryRun && (mCnt || pCnt || JSON.stringify(keys) === JSON.stringify(OLD_KEYS))) {
    await exec(
      `INSERT INTO settings (key, value) VALUES ('pageCacheEpoch', '${Date.now()}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      '页缓存换一代（pageCacheEpoch）'
    )
  }
  console.log(dryRun ? '\n体检完成，未做任何改动。\n' : '\n迁移完成。\n')
}

main().catch((e) => {
  console.error('迁移失败：', e.message)
  process.exit(1)
})
