#!/usr/bin/env node
/** One-command check of a living home: layout, life.db, gem catalog and store. */

import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SCHEMA_VERSION } from '../packages/core/lib/db.mjs'
import { resolveLayout } from '../packages/core/lib/layout.mjs'
import { loadGemCatalog, scanStoreGems } from '../packages/core/lib/gem-store.mjs'
import { readPendingImport } from '../packages/core/lib/backup.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const homeArg = args.find((arg) => arg.startsWith('--home='))?.slice('--home='.length)
  ?? (args.includes('--home') ? args[args.indexOf('--home') + 1] : null)
const home = homeArg || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'living')
const layout = resolveLayout(home)
const checks = []

function add(status, name, detail) {
  checks.push({ status, name, detail })
}

function safe(label, fn) {
  try {
    fn()
  } catch (error) {
    add('FAIL', label, error.message)
  }
}

add(Number(process.versions.node.split('.')[0]) >= 22 ? 'PASS' : 'FAIL', 'Node 版本', process.versions.node)
add(typeof DatabaseSync === 'function' ? 'PASS' : 'FAIL', 'node:sqlite', '可用')
for (const [name, path] of [['data', layout.dataDir], ['workspace', layout.workspace], ['gems', layout.gemStoreDir], ['宝石数据', layout.gemDataDir]]) {
  add(existsSync(path) ? 'PASS' : 'WARN', `目录 ${name}`, path)
}

if (existsSync(layout.dbPath)) {
  safe('life.db 完整性', () => {
    const db = new DatabaseSync(layout.dbPath, { readOnly: true })
    try {
      const check = db.prepare('PRAGMA integrity_check').all()
      if (!(check.length === 1 && Object.values(check[0])[0] === 'ok')) throw new Error(JSON.stringify(check))
      add('PASS', 'life.db integrity_check', 'ok')
      const version = db.prepare('PRAGMA user_version').get().user_version
      add(version <= SCHEMA_VERSION ? 'PASS' : 'FAIL', 'life.db schema', `v${version} / 支持 v${SCHEMA_VERSION}`)
      for (const [table] of [['events'], ['persona_docs'], ['journal_entries'], ['reports'], ['memory_edges']]) {
        if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
          add('FAIL', `life.db 表 ${table}`, '缺失')
        }
      }
      add('PASS', 'life.db 大小', `${statSync(layout.dbPath).size} 字节`)
    } finally {
      db.close()
    }
  })
} else if (existsSync(join(home, 'life.db'))) {
  add('WARN', 'life.db', `旧布局 ${join(home, 'life.db')}，启动新版本后迁移`)
} else {
  add('WARN', 'life.db', `未初始化（首次启动宿主后生成）: ${layout.dbPath}`)
}

safe('宝石目录', () => {
  const catalog = loadGemCatalog(new URL('../packages/core/gems/catalog.json', import.meta.url))
  add('PASS', '宝石目录', `${catalog.gems.length} 颗：${catalog.gems.map((gem) => gem.id).join(', ')}`)
  const scan = scanStoreGems(layout.gemStoreDir)
  add(scan.errors.length === 0 ? 'PASS' : 'FAIL', '宝石代码', scan.gems.map((gem) => `${gem.manifest.id}@${gem.manifest.version}`).join(', ') || '未安装')
  for (const error of scan.errors) add('FAIL', `宝石清单 ${error.dir}`, error.message)
})

const pending = readPendingImport(layout)
add(pending ? 'WARN' : 'PASS', '待导入记忆库', pending ? `${pending.name}（重启后替换）` : '无')

if (json) {
  console.log(JSON.stringify({ home, checks }, null, 2))
} else {
  console.log(`# living selfcheck: ${home}`)
  for (const check of checks) console.log(`${check.status.padEnd(4)} ${check.name}: ${check.detail}`)
}

process.exit(checks.some((check) => check.status === 'FAIL') ? 1 : 0)
