import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureLayout, resolveLayout } from '../lib/layout.mjs'
import { createStore } from '../lib/store.mjs'
import { openDatabase, SCHEMA_VERSION } from '../lib/db.mjs'

const silent = { log: () => {}, warn: () => {}, error: () => {} }

test('ensureLayout: 建目录并把旧 life.db / 宝石数据 / 旧文件迁入', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'living-layout-'))
  const home = join(root, 'living')
  mkdirSync(home, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const store = createStore({ path: join(home, 'life.db') })
  await store.appendEvent({ id: 'e1', ts: 1, kind: 'note' })
  await store.close()
  mkdirSync(join(root, 'living-gems', 'bili'), { recursive: true })
  writeFileSync(join(root, 'living-gems', 'bili', 'config.json'), '{}\n')
  writeFileSync(join(home, 'charter.md'), '旧 charter')
  mkdirSync(join(home, 'journal'), { recursive: true })
  writeFileSync(join(home, 'journal', '2026-01-01.md'), '旧 journal')

  const layout = ensureLayout({ home, logger: silent })
  assert.equal(layout.dbPath, join(home, 'data', 'life.db'))
  assert.equal(existsSync(join(home, 'data', 'life.db')), true)
  assert.equal(existsSync(join(home, 'life.db')), false)
  assert.equal(existsSync(join(home, 'workspace')), true)
  assert.equal(existsSync(join(home, 'gems')), true)
  assert.equal(existsSync(join(home, 'data', 'gems', 'bili', 'config.json')), true)
  assert.equal(existsSync(join(root, 'living-gems', 'bili', 'config.json')), false)
  assert.equal(existsSync(join(home, 'data', 'legacy', 'charter.md')), true)
  assert.equal(existsSync(join(home, 'data', 'legacy', 'journal', '2026-01-01.md')), true)

  const again = ensureLayout({ home, logger: silent })
  assert.equal(again.dbPath, layout.dbPath)
})

test('resolveLayout: 三个目录都在 living 根下', () => {
  const layout = resolveLayout('/tmp/living-layout-probe')
  assert.equal(layout.workspace, '/tmp/living-layout-probe/workspace')
  assert.equal(layout.gemStoreDir, '/tmp/living-layout-probe/gems')
  assert.equal(layout.dataDir, '/tmp/living-layout-probe/data')
})

test('openDatabase: 更高 schema 的库大声拒绝，不静默打开', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'living-schema-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'life.db')
  const db = openDatabase(path)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  db.close()
  assert.throws(() => openDatabase(path), /高于当前插件支持的/)
})
