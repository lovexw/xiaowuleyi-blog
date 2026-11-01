#!/usr/bin/env node
/**
 * 会员档位迁移（2026-11，v2.9 一批）
 * ==================================
 * 把旧三档「普通会员 / 咖啡会员 / 付费会员（top）」迁成新三档
 * 「注册会员 / 优质会员 / 咖啡会员」，并把历史数据里的 tier / min_tier = 'top'
 * 改写为 'premium'（优质会员）。
 *
 * 为什么要脚本：**档位定义存在 settings.memberTiers**（JSON），线上已经是老的三档，
 * 光改代码里的默认值不会影响已有站点——库里那份 JSON 才是事实源。而旧键 'top'
 * 在新定义里不存在，不迁移的话原来设过『付费会员可见』的文章会按最高档兜底（读侧
 * minTierRank 的保守映射），老 top 会员则会掉到基础档。
 *
 * 幂等：跑第二遍不会重复改写（已经是新定义就跳过；'top' 行改完就没了）。
 * 自定义过档位的站不会被覆盖：只有 key 序列恰好是旧三档时才替换定义，其余情况只提示。
 *
 * 用法（在项目根目录，已登录 wrangler）：
 *   node scripts/migrate-tiers-3.mjs --local --dry-run     # 本地库体检，不改
 *   node scripts/migrate-tiers-3.mjs --local              # 本地库执行
 *   node scripts/migrate-tiers-3.mjs                     # 线上库执行（默认 remote）
 *   node scripts/migrate-tiers-3.mjs --dry-run            # 线上库体检
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const args = process.argv.slice(2)
const local = args.includes('--local')
const dryRun = args.includes('--dry-run')
const target = local ? '--local' : '--remote'

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
  console.log(`\n会员档位迁移 → ${local ? '本地库（--local）' : '线上库（--remote）'}${dryRun ? ' · 仅体检' : ''}\n`)

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
