import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  catalogStatus,
  installGem,
  loadGemCatalog,
  resolveLatestVersion,
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

function writeGem(dir, { id = 'testgem', packageName = 'dsh-gem-test', version = '0.1.0', engines } = {}) {
  mkdirSync(dir, { recursive: true })
  const manifest = { id, name: '测试宝石', version, skill: 'SKILL.md', ...(engines ? { engines } : {}) }
  writeFileSync(join(dir, 'worldgem.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: packageName, version }))
  writeFileSync(join(dir, 'SKILL.md'), '# 测试宝石\n')
}

function useFakeNpm(t, root, fixtures) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const npm = join(bin, 'npm')
  writeFileSync(npm, `#!/bin/sh
prefix=""; spec=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --registry) shift 2 ;;
    --*) shift ;;
    *) spec="$1"; shift ;;
  esac
done
version="\${spec##*@}"
mkdir -p "$prefix/node_modules/dsh-gem-test"
cp -R "$FIXTURES/$version"/. "$prefix/node_modules/dsh-gem-test/"
`)
  chmodSync(npm, 0o755)
  const previousPath = process.env.PATH
  const previousFixtures = process.env.FIXTURES
  process.env.PATH = `${bin}:${previousPath}`
  process.env.FIXTURES = fixtures
  t.after(() => {
    process.env.PATH = previousPath
    process.env.FIXTURES = previousFixtures
  })
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

  const [status] = await catalogStatus({ version: 1, gems: [entry] }, {
    storeDir,
    gemDataDir,
    resolveLatest: async () => '0.1.1',
  })
  assert.equal(status.installed, true)
  assert.equal(status.installedVersion, '0.1.0')
  assert.equal(status.targetVersion, '0.1.1')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.hasMedia, true)

  const result = await uninstallGem({ id: 'testgem', storeDir, gemDataDir, logger: silent })
  assert.equal(result.removed, true)
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(join(gemDataDir, 'testgem', 'media')), false)
  assert.equal(existsSync(join(gemDataDir, 'testgem', 'config.json')), true)
  assert.equal(scanStoreGems(storeDir).gems.length, 0)
})

test('resolveLatestVersion：解析 npm view 的数组 JSON', { skip: process.platform === 'win32' }, async (t) => {
  const root = temp(t)
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const npm = join(bin, 'npm')
  writeFileSync(npm, '#!/bin/sh\necho \'["0.9.9"]\'\n')
  chmodSync(npm, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  t.after(() => { process.env.PATH = previousPath })

  const version = await resolveLatestVersion({ entry: { package: 'dsh-gem-unknown-test' } })
  assert.equal(version, '0.9.9')
})

test('安装：调用包管理器、校验清单、记录精确版本', { skip: process.platform === 'win32' }, async (t) => {
  const root = temp(t)
  const storeDir = join(root, 'gems')
  const fixtures = join(root, 'fixtures')
  writeGem(join(fixtures, '0.1.0'))
  useFakeNpm(t, root, fixtures)

  const result = await installGem({ entry, storeDir, resolveLatest: async () => '0.1.0', logger: silent })
  assert.equal(result.id, 'testgem')
  assert.equal(result.version, '0.1.0')
  assert.equal(result.changed, true)
  assert.equal(existsSync(join(result.dir, 'worldgem.json')), true)
  assert.equal(scanStoreGems(storeDir).gems[0].manifest.id, 'testgem')
})

test('安装：按 registry latest 升级，保留旧版本信息', { skip: process.platform === 'win32' }, async (t) => {
  const root = temp(t)
  const storeDir = join(root, 'gems')
  const fixtures = join(root, 'fixtures')
  writeGem(join(fixtures, '0.1.0'))
  writeGem(join(fixtures, '0.2.0'), { version: '0.2.0' })
  writeGem(join(storeDir, 'node_modules', 'dsh-gem-test'))
  useFakeNpm(t, root, fixtures)

  const result = await installGem({
    entry,
    storeDir,
    coreVersion: '0.3.13',
    resolveLatest: async () => '0.2.0',
    logger: silent,
  })
  assert.equal(result.previousVersion, '0.1.0')
  assert.equal(result.version, '0.2.0')
  assert.equal(result.targetVersion, '0.2.0')
  assert.equal(result.changed, true)
  assert.equal(scanStoreGems(storeDir).gems[0].manifest.version, '0.2.0')
})

test('安装：registry latest 低于已装时不动，不降级', async (t) => {
  const root = temp(t)
  const storeDir = join(root, 'gems')
  writeGem(join(storeDir, 'node_modules', 'dsh-gem-test'), { version: '0.2.0' })
  const previousPath = process.env.PATH
  process.env.PATH = join(root, 'empty-bin')
  t.after(() => { process.env.PATH = previousPath })

  const result = await installGem({
    entry,
    storeDir,
    resolveLatest: async () => '0.1.0',
    logger: silent,
  })
  assert.equal(result.changed, false)
  assert.equal(result.version, '0.2.0')
  assert.equal(result.noDowngrade, true)
})

test('安装：engines 不兼容时拒绝并恢复旧版', { skip: process.platform === 'win32' }, async (t) => {
  const root = temp(t)
  const storeDir = join(root, 'gems')
  const fixtures = join(root, 'fixtures')
  writeGem(join(fixtures, '0.1.0'), { engines: { 'dsh-living': '>=0.3.0 <0.4.0' } })
  writeGem(join(fixtures, '0.2.0'), { version: '0.2.0', engines: { 'dsh-living': '>=9.0.0 <10.0.0' } })
  writeGem(join(storeDir, 'node_modules', 'dsh-gem-test'), { engines: { 'dsh-living': '>=0.3.0 <0.4.0' } })
  useFakeNpm(t, root, fixtures)

  await assert.rejects(
    installGem({
      entry,
      storeDir,
      coreVersion: '0.3.13',
      resolveLatest: async () => '0.2.0',
      logger: silent,
    }),
    /dsh-living/,
  )
  assert.equal(scanStoreGems(storeDir).gems[0].manifest.version, '0.1.0')
})
