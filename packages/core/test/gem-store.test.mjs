import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  catalogStatus,
  installGem,
  loadGemCatalog,
  scanStoreGems,
  uninstallGem,
  validateGemCatalog,
} from '../lib/gem-store.mjs'

const silent = { log: () => {}, warn: () => {}, error: () => {} }

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'living-gem-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeGem(dir, { id = 'testgem', packageName = 'dsh-gem-test', version = '0.1.0' } = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'worldgem.json'), JSON.stringify({ id, name: '测试宝石', version, skill: 'SKILL.md' }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: packageName, version }))
  writeFileSync(join(dir, 'SKILL.md'), '# 测试宝石\n')
}

const entry = { id: 'testgem', name: '测试宝石', package: 'dsh-gem-test', version: '0.1.0' }

test('内置目录合法，重复 id / 非法版本大声失败', () => {
  const catalog = loadGemCatalog()
  assert.equal(catalog.version, 1)
  assert.ok(catalog.gems.length >= 2)
  const base = { version: 1, gems: [{ ...entry }] }
  assert.equal(validateGemCatalog(base).gems[0].package, 'dsh-gem-test')
  assert.throws(() => validateGemCatalog({ version: 1, gems: [{ ...entry }, { ...entry }] }), /重复/)
  assert.throws(() => validateGemCatalog({ version: 1, gems: [{ ...entry, version: 'latest' }] }), /精确版本/)
  assert.throws(() => validateGemCatalog({ version: 1, gems: [{ ...entry, registry: 'http://x' }] }), /https/)
})

test('扫描、状态、卸载：删代码与 media，保留配置', async (t) => {
  const root = temp(t)
  const storeDir = join(root, 'gems')
  const gemDataDir = join(root, 'data', 'gems')
  const dir = join(storeDir, 'node_modules', 'dsh-gem-test')
  writeGem(dir)
  mkdirSync(join(gemDataDir, 'testgem', 'media'), { recursive: true })
  writeFileSync(join(gemDataDir, 'testgem', 'config.json'), '{}\n')
  writeFileSync(join(gemDataDir, 'testgem', 'media', 'a.jpg'), 'x')

  const scan = scanStoreGems(storeDir)
  assert.equal(scan.gems[0].manifest.id, 'testgem')
  assert.deepEqual(scan.errors, [])

  const [status] = catalogStatus({ version: 1, gems: [entry] }, { storeDir, gemDataDir })
  assert.equal(status.installed, true)
  assert.equal(status.installedVersion, '0.1.0')
  assert.equal(status.hasMedia, true)

  const result = await uninstallGem({ id: 'testgem', storeDir, gemDataDir, logger: silent })
  assert.equal(result.removed, true)
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(join(gemDataDir, 'testgem', 'media')), false)
  assert.equal(existsSync(join(gemDataDir, 'testgem', 'config.json')), true)
  assert.equal(scanStoreGems(storeDir).gems.length, 0)
})

test('安装：调用包管理器、校验清单、记录精确版本', { skip: process.platform === 'win32' }, async (t) => {
  const root = temp(t)
  const storeDir = join(root, 'gems')
  const fixture = join(root, 'fixture')
  const bin = join(root, 'bin')
  writeGem(fixture)
  mkdirSync(bin, { recursive: true })
  const npm = join(bin, 'npm')
  writeFileSync(npm, `#!/bin/sh
prefix=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --registry) shift 2 ;;
    --*) shift ;;
    *) shift ;;
  esac
done
mkdir -p "$prefix/node_modules/dsh-gem-test"
cp -R "$FIXTURE"/. "$prefix/node_modules/dsh-gem-test/"
`)
  chmodSync(npm, 0o755)
  const previousPath = process.env.PATH
  const previousFixture = process.env.FIXTURE
  process.env.PATH = `${bin}:${previousPath}`
  process.env.FIXTURE = fixture
  t.after(() => {
    process.env.PATH = previousPath
    process.env.FIXTURE = previousFixture
  })

  const result = await installGem({ entry, storeDir, logger: silent })
  assert.equal(result.id, 'testgem')
  assert.equal(result.version, '0.1.0')
  assert.equal(existsSync(join(result.dir, 'worldgem.json')), true)
  assert.equal(scanStoreGems(storeDir).gems[0].manifest.id, 'testgem')
})
