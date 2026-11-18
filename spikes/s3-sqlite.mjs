/**
 * S3 spike: node:sqlite 并发写行为
 *
 * 问题：dsh-living 的 tick 每分钟写一次（anchors/state/events），
 *       同一时刻可能还有一轮在写 events。两条连接会不会锁死？
 *
 * 测四件事：
 *   1. WAL 下两个连接同时写，busy_timeout 生效吗（等待 vs 抛错）
 *   2. busy_timeout=0 时的失败长什么样（错误码）
 *   3. 跨进程写（真实场景：另一轮在子进程里）
 *   4. FTS5 + JSON 在 WAL 下可用吗
 *
 * 跑法：node spikes/s3-sqlite.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 's3-'))
const file = join(dir, 'life.db')
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

function open(busyTimeoutMs) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  db.exec('PRAGMA synchronous = NORMAL')
  return db
}

// ── 建表 ────────────────────────────────────────────────────────────────
const a = open(2000)
a.exec(`
  CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, payload TEXT);
  CREATE TABLE IF NOT EXISTS anchors(round_id TEXT PRIMARY KEY, trigger TEXT, outcome TEXT);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`)

// ── 1. FTS5 + JSON 在 WAL 下 ────────────────────────────────────────────
try {
  a.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(kind, payload, content='events', content_rowid='id')`)
  a.exec(`INSERT INTO events_fts(rowid, kind, payload) SELECT id, kind, payload FROM events`)
  const r = a.prepare(`SELECT json_extract('{"a":1}','$.a') AS x`).get()
  record('FTS5 + json 可用', r.x === 1, `json_extract=${r.x}`)
} catch (e) {
  record('FTS5 + json 可用', false, String(e.message))
}

// ── 2. 同进程两连接：持锁期间另一条等得起 ───────────────────────────────
{
  const b = open(2000)
  a.exec('BEGIN IMMEDIATE')
  a.exec(`INSERT INTO anchors(round_id, trigger, outcome) VALUES('r-hold','test','ok')`)

  const t0 = Date.now()
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(${JSON.stringify(file)})
    db.exec('PRAGMA busy_timeout = 3000')
    db.exec("INSERT INTO anchors(round_id, trigger, outcome) VALUES('r-child','test','ok')")
    db.exec('PRAGMA busy_timeout = 0')
  `])
  let childErr = null
  child.on('error', (e) => (childErr = e))

  setTimeout(() => a.exec('COMMIT'), 300)
  await new Promise((res) => child.on('exit', res))
  b.close()

  const waited = Date.now() - t0
  record('跨进程写等待后再成功', childErr === null, `子进程耗时 ${waited}ms（应 ≥300ms，说明它在等锁）`)
}

// ── 3. busy_timeout=0：立即失败，错误可识别 ─────────────────────────────
{
  const c = open(0)
  a.exec('BEGIN IMMEDIATE')
  let code = null
  try {
    c.exec(`INSERT INTO anchors(round_id, trigger, outcome) VALUES('r-fast','test','ok')`)
  } catch (e) {
    code = `${e.code ?? ''}/${e.errcode ?? ''}/${e.errstr ?? ''}`
  }
  a.exec('COMMIT')
  c.close()
  record('busy_timeout=0 立即报错', code !== null, `错误标识：${code}`)
}

// ── 4. 续跑量：一分钟 tick 的写入成本 ────────────────────────────────────
{
  const t0 = Date.now()
  const ins = a.prepare('INSERT INTO events(ts, kind, payload) VALUES(?,?,?)')
  a.exec('BEGIN')
  for (let i = 0; i < 1000; i++) ins.run(Date.now(), 'tick', JSON.stringify({ i }))
  a.exec('COMMIT')
  const ms = Date.now() - t0
  record('1000 条事件批量写', ms < 500, `${ms}ms`)
}

// ── 5. 反例：同线程两条连接交替开写事务 → 必然等到超时 ──────────────────
{
  const d = open(800)
  let code = null
  const t0 = Date.now()
  try {
    a.exec('BEGIN IMMEDIATE')
    a.exec(`INSERT INTO anchors(round_id, trigger, outcome) VALUES('r-t1','tick','ok')`)
    // 单线程里 d 阻塞等锁，setTimeout 永远排不上 → 只能撞超时
    d.exec('BEGIN IMMEDIATE')
    d.exec(`INSERT INTO anchors(round_id, trigger, outcome) VALUES('r-t2','round','ok')`)
    d.exec('COMMIT')
  } catch (e) {
    code = String(e.message)
  } finally {
    try { a.exec('COMMIT') } catch { /* 已提交或已回滚 */ }
  }
  d.close()
  const ms = Date.now() - t0
  record(
    '反例：同线程两连接并行写 → 超时（预期）',
    code !== null && ms >= 700,
    `${ms}ms, ${code}`,
  )
}

// ── 6. 正确做法：所有写走单写队列 → 两条连接也不再撞墙 ──────────────────
{
  const d = open(2000)
  let tail = Promise.resolve()
  /** 串行化所有写；node:sqlite 是同步 API，必须靠这个队列，不能靠 busy_timeout */
  const withWriteLock = (fn) => {
    const next = tail.then(fn)
    tail = next.catch(() => {})
    return next
  }

  const worker = (db, tag, n) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        withWriteLock(() => {
          db.exec('BEGIN IMMEDIATE')
          try {
            db.prepare('INSERT INTO events(ts,kind,payload) VALUES(?,?,?)')
              .run(Date.now(), tag, JSON.stringify({ i }))
            db.exec('COMMIT')
          } catch (e) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw e
          }
        }),
      ),
    )

  let err = null
  try {
    await Promise.all([worker(a, 'w1', 50), worker(d, 'w2', 50)])
  } catch (e) {
    err = String(e.message)
  }
  const count = d.prepare(`SELECT count(*) c FROM events WHERE kind IN ('w1','w2')`).get().c
  d.close()
  record('单写队列下两条连接并行写', err === null && count === 100, `err=${err ?? '无'} count=${count}`)
}

a.close()

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
rmSync(dir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
