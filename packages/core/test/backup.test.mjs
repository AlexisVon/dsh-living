import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { SCHEMA_VERSION } from '../lib/db.mjs'
import { resolveLayout } from '../lib/layout.mjs'
import {
  applyPendingImport,
  cancelPendingImport,
  createSnapshot,
  pendingImportPath,
  readPendingImport,
  stageImport,
  validateBackupFile,
} from '../lib/backup.mjs'

const silent = { log: () => {}, warn: () => {}, error: () => {} }

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'living-backup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('快照 → 校验 → 暂存 → 下次启动替换，旧库自动备份', async (t) => {
  const home = temp(t)
  const layout = resolveLayout(home)
  const store = createStore({ path: layout.dbPath })
  await store.appendEvent({ id: 'e1', ts: 1, kind: 'note', payload: { text: '记得这件事' } })
  const snapshot = await createSnapshot({ store, layout })
  assert.ok(snapshot.bytes > 0)
  const info = validateBackupFile(snapshot.path)
  assert.equal(info.schemaVersion, SCHEMA_VERSION)

  const pending = stageImport({ layout, bytes: readFileSync(snapshot.path), name: 'memory.db' })
  assert.equal(pending.name, 'memory.db')
  assert.deepEqual(readPendingImport(layout)?.path, pending.path)
  await store.close()

  const applied = applyPendingImport({ layout, logger: silent })
  assert.equal(applied.applied, true)
  assert.equal(existsSync(pendingImportPath(layout)), false)
  assert.equal(existsSync(join(applied.backupDir, 'life.db')), true)

  const reopened = createStore({ path: layout.dbPath })
  assert.equal(reopened.getEvent('e1')?.payload.text, '记得这件事')
  await reopened.close()
})

test('非法文件 / 更高 schema / 越界路径都拒绝', async (t) => {
  const home = temp(t)
  const layout = resolveLayout(home)
  mkdirSync(layout.importDir, { recursive: true })

  const text = join(home, 'not-a-db.txt')
  writeFileSync(text, 'hello')
  assert.throws(() => validateBackupFile(text), /SQLite/)

  const newer = join(home, 'newer.db')
  const db = new DatabaseSync(newer)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  db.close()
  assert.throws(() => validateBackupFile(newer), /高于当前插件支持的/)

  const pending = join(layout.importDir, 'pending.json')
  writeFileSync(pending, JSON.stringify({ path: '/etc/passwd', name: 'x', schemaVersion: 1 }))
  const applied = applyPendingImport({ layout, logger: silent })
  assert.equal(applied.applied, false)
  assert.equal(existsSync(pending), false, '失败标记被移走，避免反复尝试')
})

test('取消待导入会删除暂存文件', async (t) => {
  const home = temp(t)
  const layout = resolveLayout(home)
  const store = createStore({ path: layout.dbPath })
  await store.appendEvent({ id: 'e1', ts: 1, kind: 'note' })
  const snapshot = await createSnapshot({ store, layout })
  await store.close()
  const pending = stageImport({ layout, bytes: readFileSync(snapshot.path), name: 'memory.db' })
  const cancelled = cancelPendingImport(layout)
  assert.equal(cancelled.cancelled, true)
  assert.equal(existsSync(pending.path), false)
  assert.equal(readPendingImport(layout), null)
})
