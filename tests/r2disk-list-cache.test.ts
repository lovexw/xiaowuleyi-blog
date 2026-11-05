import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createR2Disk } from '../docker-poc/shims/r2disk.ts'

/* r2disk.list 的 key 索引缓存（2026-11 复核）
 *
 * 背景：listAllKeys 是全树同步遍历，2.2 万个文件约 70ms；媒体体检按 1000 一页翻，
 * 旧实现每页重走一次整棵树 → 一轮体检把事件循环卡住 1.4 秒。缓存之后一轮翻页只遍历一次。
 * 这组用例锁住三件事：翻页不重复遍历、外部删文件不炸、TTL 到点必须重新遍历
 * （外部进程写的变体文件只能靠 TTL 被看见）。
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r2disk-cache-'))
}

/** 统计目录遍历次数：patch 掉 fs.readdirSync（r2disk 用的是同一个 fs 对象） */
function countWalks<T>(fn: () => Promise<T>): Promise<{ result: T; walks: number }> {
  const orig = fs.readdirSync
  let walks = 0
  ;(fs as unknown as { readdirSync: unknown }).readdirSync = (...args: unknown[]) => {
    walks++
    return (orig as (...a: unknown[]) => unknown)(...args)
  }
  return fn()
    .then((result) => ({ result, walks }))
    .finally(() => {
      ;(fs as unknown as { readdirSync: unknown }).readdirSync = orig
    })
}

test('r2disk.list：连续翻页复用同一份索引，不再逐页遍历整棵树', async () => {
  const root = tmpRoot()
  try {
    for (let i = 0; i < 4; i++) fs.mkdirSync(path.join(root, 'u', `m${i % 2}`), { recursive: true })
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, 'u', `m${i % 2}`, `f${String(i).padStart(2, '0')}.jpg`), 'x')
    const disk = createR2Disk(root)

    const { result, walks } = await countWalks(async () => {
      const p1 = await disk.list({ limit: 5 })
      const p2 = await disk.list({ limit: 5, cursor: p1.cursor })
      const p3 = await disk.list({ limit: 5, cursor: p2.cursor })
      return { p1, p2, p3 }
    })
    const { p1, p2, p3 } = result
    const keys = [...p1.objects, ...p2.objects, ...p3.objects].map((o) => o.key)
    assert.equal(keys.length, 12, '三页读完恰好 12 个对象')
    assert.equal(new Set(keys).size, 12, '翻页不重不漏')
    assert.equal(p1.objects.length, 5)
    assert.equal(p3.truncated, false)
    // 一次遍历 = 根目录 readdir 1 次 + 子目录（u/、u/m0、u/m1）各 1 次，共 4 次；
    // 旧实现每页都重走一遍 → 三页就是 12 次
    assert.equal(walks, 4, `三页只遍历一次目录树（实际 readdir ${walks} 次）`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('r2disk.list：索引比磁盘旧时跳过已删对象，不抛异常', async () => {
  const root = tmpRoot()
  try {
    fs.mkdirSync(path.join(root, 'u'), { recursive: true })
    for (const n of ['a.jpg', 'b.jpg', 'c.jpg']) fs.writeFileSync(path.join(root, 'u', n), 'x')
    const disk = createR2Disk(root)
    const first = await disk.list({ limit: 100 })
    assert.equal(first.objects.length, 3)

    // 绕过 shim 直接删（模拟另一条路径/外部进程在 2 秒窗口内删了文件）
    fs.rmSync(path.join(root, 'u', 'b.jpg'))
    const second = await disk.list({ limit: 100 }) // 仍命中旧索引
    assert.deepEqual(
      second.objects.map((o) => o.key),
      ['u/a.jpg', 'u/c.jpg'],
      '列不出来的对象跳过，与真 R2 行为一致'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('r2disk.list：索引 2 秒过期后重新遍历（外部写入的变体文件才能被看见）', async () => {
  const root = tmpRoot()
  try {
    fs.mkdirSync(path.join(root, 'u'), { recursive: true })
    fs.writeFileSync(path.join(root, 'u', 'a.jpg'), 'x')
    const disk = createR2Disk(root)
    assert.equal((await disk.list({ limit: 100 })).objects.length, 1)

    fs.writeFileSync(path.join(root, 'u', 'a.jpg@480.webp'), 'v')
    assert.equal((await disk.list({ limit: 100 })).objects.length, 1, 'TTL 内看不到（已知代价）')

    // 不真等 2 秒：把时钟往前拨过 TTL
    const realNow = Date.now
    Date.now = () => realNow() + 3000
    try {
      const after = await disk.list({ limit: 100 })
      assert.deepEqual(after.objects.map((o) => o.key), ['u/a.jpg', 'u/a.jpg@480.webp'])
    } finally {
      Date.now = realNow
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
