/** Memory backup and restore: consistent snapshots, validated imports, startup swap. */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { SCHEMA_VERSION } from './db.mjs'

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024
const SQLITE_HEADER = 'SQLite format 3\u0000'
/** Tables every supported schema has; newer tables are added by migration on open. */
const REQUIRED_TABLES = [
  'events',
  'episodes',
  'facts',
  'facets',
  'access',
  'cold',
  'anchors',
  'state',
  'outbox',
  'ingest_seen',
]

export function pendingImportPath(layout) {
  return join(layout.importDir, 'pending.json')
}

export function readPendingImport(layout) {
  const path = pendingImportPath(layout)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function dataInfo({ layout, store = null }) {
  let bytes = null
  try {
    bytes = statSync(layout.dbPath).size
  } catch {}
  return {
    home: layout.root,
    dataDir: layout.dataDir,
    workspace: layout.workspace,
    gemStoreDir: layout.gemStoreDir,
    gemDataDir: layout.gemDataDir,
    dbPath: layout.dbPath,
    dbBytes: bytes,
    schemaVersion: store?.schemaVersion?.() ?? null,
    supportedSchemaVersion: SCHEMA_VERSION,
    pendingImport: readPendingImport(layout),
  }
}

export async function createSnapshot({ store, layout, now = Date.now() }) {
  if (!store || typeof store.snapshotTo !== 'function') throw new RangeError('store 不支持快照')
  mkdirSync(layout.backupDir, { recursive: true })
  const name = `dsh-living-life-${stamp(now)}.db`
  let path = join(layout.backupDir, name)
  for (let index = 2; existsSync(path); index += 1) path = join(layout.backupDir, `dsh-living-life-${stamp(now)}-${index}.db`)
  await store.snapshotTo(path)
  try {
    chmodSync(path, 0o600)
  } catch {}
  return { name: basename(path), path, bytes: statSync(path).size }
}

export function validateBackupFile(path, { maxBytes = MAX_IMPORT_BYTES } = {}) {
  const stat = statSync(path)
  if (!stat.isFile()) throw new RangeError('导入目标不是文件')
  if (stat.size === 0) throw new RangeError('导入文件为空')
  if (stat.size > maxBytes) throw new RangeError(`导入文件超过上限 ${maxBytes} 字节`)
  const fd = openSync(path, 'r')
  const headerBytes = Buffer.alloc(16)
  try {
    readSync(fd, headerBytes, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  if (headerBytes.toString('utf8') !== SQLITE_HEADER) throw new RangeError('不是 SQLite 数据库文件')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const check = db.prepare('PRAGMA integrity_check').all()
    const ok = check.length === 1 && Object.values(check[0])[0] === 'ok'
    if (!ok) throw new RangeError(`数据库完整性检查失败: ${JSON.stringify(check).slice(0, 200)}`)
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version
    if (schemaVersion > SCHEMA_VERSION) {
      throw new RangeError(`数据库 schema v${schemaVersion} 高于当前插件支持的 v${SCHEMA_VERSION}`)
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table))
    if (missing.length > 0) throw new RangeError(`数据库缺少表: ${missing.join(', ')}`)
    return { schemaVersion, tables: [...tables], bytes: stat.size }
  } finally {
    db.close()
  }
}

export function stageImport({ layout, bytes, name = 'life.db', now = Date.now() }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new RangeError('导入内容为空')
  if (bytes.length > MAX_IMPORT_BYTES) throw new RangeError(`导入文件超过上限 ${MAX_IMPORT_BYTES} 字节`)
  mkdirSync(layout.importDir, { recursive: true })
  const safe = (basename(String(name || 'life.db')).replaceAll(/[^\w.-]+/gu, '_') || 'life.db').slice(0, 80)
  const path = join(layout.importDir, `${stamp(now)}-${safe}`)
  writeFileSync(path, bytes, { mode: 0o600 })
  try {
    const info = validateBackupFile(path)
    const pending = {
      path,
      name: safe,
      bytes: info.bytes,
      schemaVersion: info.schemaVersion,
      importedAt: now,
    }
    const tmp = `${pendingImportPath(layout)}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, pendingImportPath(layout))
    return pending
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
}

export function cancelPendingImport(layout) {
  const pending = readPendingImport(layout)
  if (!pending) return { cancelled: false }
  rmSync(pending.path, { force: true })
  rmSync(pendingImportPath(layout), { force: true })
  return { cancelled: true, path: pending.path }
}

/** Swap the staged database in before the store opens; start failed swaps are loud but non-fatal. */
export function applyPendingImport({ layout, logger = console }) {
  const marker = pendingImportPath(layout)
  if (!existsSync(marker)) return { applied: false }
  const pending = readPendingImport(layout)
  if (!pending) {
    try {
      renameSync(marker, join(layout.importDir, `pending.failed-${stamp(Date.now())}.json`))
    } catch {}
    logger.error?.('living: 待导入标记损坏，保留当前库')
    return { applied: false, error: '待导入标记损坏' }
  }
  try {
    if (typeof pending.path !== 'string' || !pending.path.startsWith(layout.importDir + sep)) {
      throw new RangeError(`待导入路径越界: ${pending.path}`)
    }
    validateBackupFile(pending.path)
    const backupDir = join(layout.backupDir, `pre-import-${stamp(Date.now())}`)
    mkdirSync(backupDir, { recursive: true })
    const moved = []
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const source = `${layout.dbPath}${suffix}`
        const target = join(backupDir, `life.db${suffix}`)
        if (existsSync(source)) {
          moveFile(source, target)
          moved.push([target, source])
        }
      }
      copyFileSync(pending.path, layout.dbPath)
      chmodSync(layout.dbPath, 0o600)
      rmSync(pending.path, { force: true })
    } catch (error) {
      rmSync(layout.dbPath, { force: true })
      for (const [source, target] of moved) moveFile(source, target)
      throw error
    }
    rmSync(pendingImportPath(layout), { force: true })
    logger.log?.(`living: 已导入记忆库 ${pending.name}（schema v${pending.schemaVersion}），原库备份在 ${backupDir}`)
    return { applied: true, backupDir, source: pending.path, schemaVersion: pending.schemaVersion }
  } catch (error) {
    const failed = join(layout.importDir, `pending.failed-${stamp(Date.now())}.json`)
    try {
      renameSync(pendingImportPath(layout), failed)
    } catch {}
    logger.error?.(`living: 记忆库导入失败，保留当前库: ${error.message}`)
    return { applied: false, error: error.message }
  }
}

function moveFile(source, target) {
  mkdirSync(dirname(target), { recursive: true })
  try {
    renameSync(source, target)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    copyFileSync(source, target)
    rmSync(source, { force: true })
  }
}

function stamp(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
