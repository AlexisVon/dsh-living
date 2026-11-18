/**
 * Living home layout and one-time migration from the pre-0.1 flat layout:
 * data/ (life.db, gem data), workspace/ (agent cwd), gems/ (npm code).
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export function resolveLayout(home) {
  if (typeof home !== 'string' || home === '') throw new RangeError('living home 必填')
  const root = resolve(home)
  return {
    root,
    dataDir: join(root, 'data'),
    workspace: join(root, 'workspace'),
    gemStoreDir: join(root, 'gems'),
    gemDataDir: join(root, 'data', 'gems'),
    dbPath: join(root, 'data', 'life.db'),
    backupDir: join(root, 'data', 'backups'),
    importDir: join(root, 'data', 'imports'),
    legacyDir: join(root, 'data', 'legacy'),
  }
}

export function ensureLayout({ home, logger = console } = {}) {
  const layout = resolveLayout(home)
  for (const dir of [layout.dataDir, layout.workspace, layout.gemStoreDir, layout.gemDataDir, layout.backupDir, layout.importDir, layout.legacyDir]) {
    mkdirSync(dir, { recursive: true })
  }
  migrateDatabase(layout, logger)
  migrateGemHomes(layout, logger)
  migrateLegacyFiles(layout, logger)
  return layout
}

function migrateDatabase(layout, logger) {
  const source = join(layout.root, 'life.db')
  if (!existsSync(source)) return
  if (existsSync(layout.dbPath)) {
    logger.warn?.(`living: 迁移跳过 life.db，目标已存在: ${layout.dbPath}`)
    return
  }
  for (const suffix of ['', '-wal', '-shm']) {
    moveEntry(join(layout.root, `life.db${suffix}`), join(layout.dataDir, `life.db${suffix}`), logger, 'life.db')
  }
  logger.log?.(`living: life.db 已迁移到 ${layout.dbPath}`)
}

function migrateGemHomes(layout, logger) {
  const candidates = new Set([join(dirname(layout.root), 'living-gems')])
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  if (resolve(layout.root) === resolve(join(dshHome, 'living'))) candidates.add(join(dshHome, 'living-gems'))
  for (const source of candidates) {
    if (!existsSync(source) || resolve(source) === resolve(layout.gemDataDir)) continue
    let names = []
    try {
      names = readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== 'packages').map((entry) => entry.name)
    } catch {
      continue
    }
    for (const name of names) {
      moveEntry(join(source, name), join(layout.gemDataDir, name), logger, '宝石数据')
    }
  }
}
function migrateLegacyFiles(layout, logger) {
  for (const name of ['charter.md', 'self.md', 'journal', 'reports']) {
    moveEntry(join(layout.root, name), join(layout.legacyDir, name), logger, '旧数据')
  }
}

function moveEntry(source, target, logger, label) {
  if (!existsSync(source)) return false
  if (existsSync(target)) {
    logger.warn?.(`living: ${label} 迁移跳过，目标已存在: ${target}`)
    return false
  }
  mkdirSync(dirname(target), { recursive: true })
  try {
    renameSync(source, target)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    const stat = statSync(source)
    if (stat.isDirectory()) cpSync(source, target, { recursive: true, preserveTimestamps: true })
    else copyFileSync(source, target)
    rmSync(source, { recursive: true, force: true })
  }
  logger.log?.(`living: ${label} 已迁移 ${source} -> ${target}`)
  return true
}
