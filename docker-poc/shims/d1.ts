/**
 * D1 → node:sqlite 适配层（自托管 POC，docker-poc/ 独立目录，不影响仓库主代码）。
 *
 * 只覆盖业务代码实际用到的 API 面（对 src/ 全量 grep 过）：
 *   db.prepare(sql).bind(...).first() / .all() / .run()
 *   db.batch([stmt, ...])
 *   res.meta.changes / res.meta.last_row_id
 * 未用到 exec / raw / withSession，这里给保底实现，将来误用时报错可读。
 *
 * 两个方言差异的处理：
 * - node:sqlite 查出来的行是 null 原型对象，统一展开成普通对象
 *   （业务代码大量解构 / JSON 序列化 / hasOwnProperty 判断，普通对象最安全）
 * - D1 不接受 undefined / boolean 绑定，这里 undefined→null、boolean→1/0
 *
 * 语句缓存（2026-11 第三批）：原先每次 first/all/run 都要 db.prepare(sql) 重新解析一遍
 * SQL。热路径里同一条 SQL（getSettings、计数、会话校验…）每请求反复出现，解析纯属浪费。
 * 按 SQL 文本缓存 StatementSync；DDL / PRAGMA 执行时清空缓存，避免 ALTER TABLE /
 * CREATE INDEX 之后旧编译结果引用过期的 schema。缓存按 createD1 实例隔离，并设上限
 * 防止动态拼出来的 SQL（IN 占位符个数不同）无限增长。
 */
import { DatabaseSync } from 'node:sqlite'

function normValue(v: unknown): null | number | string {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string') return v
  throw new Error(`[d1-shim] 不支持的绑定类型: ${typeof v}（SQL 绑定值只允许 null/number/string）`)
}

type Row = Record<string, unknown>
type Prepared = ReturnType<DatabaseSync['prepare']>

/** 语句缓存上限：超过就整体丢弃重建（SQL 都是固定串，动态串最多几十种，256 足够） */
const STMT_CACHE_MAX = 256
/** 会改变 schema 或依赖实时 schema 的语句不缓存，且执行前清掉已有缓存 */
const SCHEMA_SQL = /^\s*(CREATE|ALTER|DROP|PRAGMA|REINDEX|VACUUM|ATTACH|DETACH)\b/i
/** 有结果集的语句（batch 里必须走 all()；其余走 run() 取 changes） */
const READ_SQL = /^\s*(?:SELECT|WITH|VALUES|PRAGMA|EXPLAIN)\b/i

function plainRow(row: Row | undefined | null): Row | null {
  return row ? { ...row } : null
}

class ShimStatement {
  sql: string
  args: (null | number | string)[] = []
  private stmt: (sql: string) => Prepared

  constructor(sql: string, stmt: (sql: string) => Prepared) {
    this.sql = sql
    this.stmt = stmt
  }

  bind(...args: unknown[]): ShimStatement {
    this.args = args.map(normValue)
    return this
  }

  /** run 的同步版：batch 在同一事务里逐条执行时用 */
  _runSync(): { success: true; meta: { changes: number; last_row_id: number; duration: number } } {
    const info = this.stmt(this.sql).run(...(this.args as never[]))
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
        duration: 0,
      },
    }
  }

  /** batch 里的读语句：必须走 all() 才有结果集（2026-11-06 修） */
  _allSync<T = Row>(): { results: T[]; success: true; meta: Record<string, never> } {
    const rows = this.stmt(this.sql).all(...(this.args as never[])) as Row[]
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} }
  }

  /** 这条语句会不会返回结果集（决定 batch 里走 all 还是 run） */
  _returnsRows(): boolean {
    const s = this.sql
    // INSERT/UPDATE/DELETE ... RETURNING 也带结果集
    if (/\breturning\b/i.test(s)) return true
    return READ_SQL.test(s)
  }

  async run() {
    return this._runSync()
  }

  async first<T = Row>(): Promise<T | null> {
    const row = this.stmt(this.sql).get(...(this.args as never[])) as Row | undefined
    return plainRow(row) as T | null
  }

  async all<T = Row>(): Promise<{ results: T[]; meta: Record<string, never> }> {
    const rows = this.stmt(this.sql).all(...(this.args as never[])) as Row[]
    return { results: rows.map((r) => ({ ...r })) as T[], meta: {} }
  }

  async raw<T = Row>(): Promise<unknown[][]> {
    const rows = this.stmt(this.sql).all(...(this.args as never[])) as Row[]
    return rows.map((r) => Object.values(r))
  }
}

export type D1Shim = ReturnType<typeof createD1>

export function createD1(file: string) {
  const db = new DatabaseSync(file)
  // WAL：读不阻塞写；busy_timeout 防多进程（未来分实例）偶发锁冲突
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')

  const stmtCache = new Map<string, Prepared>()
  function stmt(sql: string): Prepared {
    // DDL / PRAGMA 可能改变 schema：旧 statement 里编译好的列信息会过期，整表作废最省心
    if (SCHEMA_SQL.test(sql)) {
      stmtCache.clear()
      return db.prepare(sql)
    }
    let s = stmtCache.get(sql)
    if (!s) {
      if (stmtCache.size >= STMT_CACHE_MAX) stmtCache.clear()
      s = db.prepare(sql)
      stmtCache.set(sql, s)
    }
    return s
  }

  /**
   * 批量执行（对齐 D1 语义：逐条按顺序执行，写操作整体原子）。
   *
   * 2026-11-06 修：原实现对**每一条**语句都调 run()，于是 batch 里的 SELECT 只拿到
   * `{success, meta:{changes,last_row_id}}`——没有 results，changes 还是上一条语句的残留值。
   * 线上表现是媒体体检「未引用」把整库 6176 个文件全列了出来（引用源一条都没读到），
   * 一键清理会据此删光图床；同族受害者还有邀请码核销的 changes 判定、往年今日的两个
   * SELECT、回收站彻底删除的 changes 判定。真 D1 的 batch 对读语句返回 results，
   * 这里按语句形态分流：有结果集的走 all()，其余走 run()。
   */
  async function batch(stmts: ShimStatement[]) {
    const out: unknown[] = []
    const hasWrite = stmts.some((s) => !s._returnsRows())
    // 纯读批次不开事务：体检这类大结果集读取不该占住写锁；真 D1 的原子性对只读没有意义
    if (hasWrite) db.exec('BEGIN IMMEDIATE')
    try {
      for (const s of stmts) out.push(s._returnsRows() ? s._allSync() : s._runSync())
      if (hasWrite) db.exec('COMMIT')
    } catch (e) {
      if (hasWrite) db.exec('ROLLBACK')
      throw e
    }
    return out
  }

  return {
    prepare: (sql: string) => new ShimStatement(sql, stmt),
    batch,
    // D1.exec 用于多语句脚本；node:sqlite 原生支持（脚本里通常带 DDL，先清缓存）
    exec: async (sql: string) => {
      stmtCache.clear()
      db.exec(sql)
      return []
    },
    withSession: () => {
      throw new Error('[d1-shim] withSession 未实现（业务代码未用到）')
    },
    close: () => {
      stmtCache.clear()
      db.close()
    },
  }
}
