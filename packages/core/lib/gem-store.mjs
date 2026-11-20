/** Living-managed gem store: catalog, npm installation, scanning, removal. */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadGem } from './gems.mjs'
import { chooseTargetVersion, compareSemver } from './semver.mjs'

const CATALOG_URL = new URL('../gems/catalog.json', import.meta.url)
const DEFAULT_TIMEOUT_MS = 120_000
const LATEST_TIMEOUT_MS = 8_000
const LATEST_TTL_MS = 5 * 60_000
const MAX_OUTPUT_BYTES = 128 * 1024
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/u
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const inFlight = new Map()
const storeLocks = new Map()
const latestCache = new Map()

export function loadGemCatalog(file = CATALOG_URL) {
  return validateGemCatalog(JSON.parse(readFileSync(file, 'utf8')))
}

export function validateGemCatalog(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new RangeError('宝石目录必须是对象')
  if (doc.version !== 1) throw new RangeError(`宝石目录版本不支持: ${doc.version}`)
  if (!Array.isArray(doc.gems)) throw new RangeError('宝石目录缺 gems 数组')
  const ids = new Set()
  const packages = new Set()
  const gems = doc.gems.map((entry, index) => {
    const at = `gems[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new RangeError(`${at} 必须是对象`)
    if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) throw new RangeError(`${at}.id 不合法`)
    if (ids.has(entry.id)) throw new RangeError(`${at}.id 重复: ${entry.id}`)
    ids.add(entry.id)
    if (typeof entry.name !== 'string' || entry.name.trim() === '') throw new RangeError(`${at}.name 必填`)
    if (typeof entry.package !== 'string' || !PACKAGE_RE.test(entry.package)) throw new RangeError(`${at}.package 不合法`)
    if (packages.has(entry.package)) throw new RangeError(`${at}.package 重复: ${entry.package}`)
    packages.add(entry.package)
    if (typeof entry.version !== 'string' || !SEMVER_RE.test(entry.version)) throw new RangeError(`${at}.version 必须是精确版本`)
    const out = {
      id: entry.id,
      name: entry.name.trim(),
      package: entry.package,
      version: entry.version,
      description: typeof entry.description === 'string' ? entry.description.trim() : '',
      repository: entry.repository === undefined ? null : httpsUrl(entry.repository, `${at}.repository`),
      registry: entry.registry === undefined ? null : httpsUrl(entry.registry, `${at}.registry`),
      capabilities: plainBooleans(entry.capabilities, `${at}.capabilities`),
    }
    return out
  })
  return { version: 1, gems }
}

export function storePackageDir(storeDir, pkg) {
  if (typeof pkg !== 'string' || !PACKAGE_RE.test(pkg)) throw new RangeError(`非法包名: ${pkg}`)
  return join(storeDir, 'node_modules', ...pkg.split('/'))
}

export function findStoreGem(storeDir, id) {
  for (const gem of scanStoreGems(storeDir).gems) {
    if (gem.manifest.id === id) return gem
  }
  return null
}

/** Scan installed packages for worldgem.json; broken manifests are reported, not hidden. */
export function scanStoreGems(storeDir, { loadGemFn = loadGem, coreVersion = null } = {}) {
  const modules = join(storeDir, 'node_modules')
  if (!existsSync(modules)) return { gems: [], errors: [] }
  const dirs = []
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scope = join(modules, entry.name)
      if (!isDirectory(scope)) continue
      for (const sub of readdirSync(scope, { withFileTypes: true })) {
        if (sub.name.startsWith('.')) continue
        const dir = join(scope, sub.name)
        if (isDirectory(dir)) dirs.push(dir)
      }
      continue
    }
    const dir = join(modules, entry.name)
    if (isDirectory(dir)) dirs.push(dir)
  }
  const gems = []
  const errors = []
  for (const dir of dirs) {
    if (!existsSync(join(dir, 'worldgem.json'))) continue
    try {
      gems.push(loadGemFn(dir, { coreVersion }))
    } catch (error) {
      errors.push({ dir, message: error.message })
    }
  }
  gems.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
  return { gems, errors }
}

export async function catalogStatus(catalog, {
  storeDir,
  gemDataDir,
  coreVersion = null,
  loadedVersions = {},
  resolveLatest = resolveLatestVersion,
} = {}) {
  return Promise.all(catalog.gems.map(async (entry) => {
    const dir = storePackageDir(storeDir, entry.package)
    const installed = existsSync(join(dir, 'worldgem.json'))
    let installedVersion = null
    let broken = null
    if (installed) {
      try {
        const gem = loadGem(dir, { coreVersion })
        if (gem.manifest.id !== entry.id) throw new RangeError(`包内 id 是 ${gem.manifest.id}，目录期望 ${entry.id}`)
        installedVersion = readInstalledVersion(dir)
      } catch (error) {
        broken = error.message
      }
    }
    let latestVersion = null
    let latestError = null
    try {
      latestVersion = await resolveLatest({ entry })
    } catch (error) {
      latestError = error.message
    }
    const { resolved, action, noDowngrade } = chooseTargetVersion({
      installed: installedVersion,
      floor: entry.version,
      latest: latestVersion,
    })
    const loadedVersion = loadedVersions[entry.id] ?? null
    const dataDir = join(gemDataDir, entry.id)
    return {
      ...entry,
      installed,
      installedVersion,
      latestVersion,
      latestError,
      targetVersion: resolved,
      updateAvailable: action === 'upgrade',
      noDowngrade,
      loadedVersion,
      restartRequired: loadedVersion !== null && installedVersion !== null && compareSemver(loadedVersion, installedVersion) !== 0,
      broken,
      dataDir,
      hasMedia: existsSync(join(dataDir, 'media')),
    }
  }))
}

export async function resolveLatestVersion({ entry, timeoutMs = LATEST_TIMEOUT_MS, signal = null } = {}) {
  const key = `${entry.registry ?? ''}|${entry.package}`
  const cached = latestCache.get(key)
  const nowMs = Date.now()
  if (cached && nowMs - cached.at < LATEST_TTL_MS) return cached.version
  const registry = entry.registry ? ['--registry', entry.registry] : []
  const result = await runCommand('npm', ['view', `${entry.package}@latest`, 'version', '--json', ...registry], {
    cwd: process.cwd(),
    timeoutMs,
    signal,
  })
  if (result.code !== 0) throw new Error(`读取 ${entry.package} 最新版本失败: ${tail(result.stderr || result.stdout)}`)
  let parsed
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error(`读取 ${entry.package} 最新版本失败: npm 返回不是 JSON`)
  }
  const version = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new Error(`读取 ${entry.package} 最新版本失败: 非法版本 ${String(version)}`)
  }
  latestCache.set(key, { at: nowMs, version })
  return version
}

export function installGem({
  entry,
  storeDir,
  coreVersion = null,
  resolveLatest = resolveLatestVersion,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
  logger = console,
}) {
  const key = `${resolve(storeDir)}:${entry.package}`
  const running = inFlight.get(key)
  if (running) return running
  const task = withStoreLock(storeDir, () => doInstall({ entry, storeDir, coreVersion, resolveLatest, timeoutMs, signal, logger }))
    .finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

async function doInstall({ entry, storeDir, coreVersion, resolveLatest, timeoutMs, signal, logger }) {
  mkdirSync(storeDir, { recursive: true })
  const installedDir = storePackageDir(storeDir, entry.package)
  let installedVersion = null
  if (existsSync(join(installedDir, 'worldgem.json'))) {
    try {
      installedVersion = readInstalledVersion(installedDir)
    } catch {}
  }
  let latestVersion = null
  let latestError = null
  try {
    latestVersion = await resolveLatest({ entry, timeoutMs: Math.min(timeoutMs, LATEST_TIMEOUT_MS), signal })
  } catch (error) {
    latestError = error.message
  }
  const { resolved, action, noDowngrade } = chooseTargetVersion({
    installed: installedVersion,
    floor: entry.version,
    latest: latestVersion,
  })
  const head = {
    id: entry.id,
    package: entry.package,
    previousVersion: installedVersion,
    latestVersion,
    latestError,
    targetVersion: resolved,
    noDowngrade,
  }
  if (action === 'none') {
    const gem = loadGem(installedDir, { coreVersion })
    if (gem.manifest.id !== entry.id) throw new RangeError(`包 ${entry.package} 的宝石 id 是 ${gem.manifest.id}，目录期望 ${entry.id}`)
    ensureStoreDependency(storeDir, entry.package, installedVersion)
    return { ...head, version: installedVersion, dir: installedDir, changed: false }
  }
  const manifestPath = join(storeDir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({ name: 'dsh-living-gems', private: true }, null, 2)}\n`)
  }
  try {
    await installExact({ entry, storeDir, version: resolved, timeoutMs, signal })
  } catch (error) {
    await restoreInstall({ entry, storeDir, installedVersion, timeoutMs, signal, error })
    throw error
  }
  const dir = storePackageDir(storeDir, entry.package)
  try {
    const gem = loadGem(dir, { coreVersion })
    if (gem.manifest.id !== entry.id) throw new RangeError(`包 ${entry.package} 的宝石 id 是 ${gem.manifest.id}，目录期望 ${entry.id}`)
    const version = readInstalledVersion(dir)
    ensureStoreDependency(storeDir, entry.package, version)
    logger.log?.(`living: 宝石已安装 ${entry.id} ${entry.package}@${version}`)
    return { ...head, version, dir, changed: version !== installedVersion }
  } catch (error) {
    await restoreInstall({ entry, storeDir, installedVersion, timeoutMs, signal, error })
    throw error
  }
}

async function installExact({ entry, storeDir, version, timeoutMs, signal }) {
  const spec = `${entry.package}@${version}`
  const registry = entry.registry ? ['--registry', entry.registry] : []
  const commands = [
    { command: 'npm', args: ['install', '--prefix', storeDir, '--save', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', ...registry, spec] },
    { command: 'pnpm', args: ['add', '--dir', storeDir, '--save-exact', '--ignore-scripts', '--config.minimum-release-age=0', ...registry, spec] },
  ]
  let result = null
  for (const candidate of commands) {
    try {
      result = await runCommand(candidate.command, candidate.args, { cwd: storeDir, timeoutMs, signal })
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (!result) throw new Error('找不到 npm 或 pnpm，无法安装宝石')
  if (result.code !== 0) throw new Error(`宝石安装失败（${spec}）: ${tail(result.stderr || result.stdout)}`)
}

async function restoreInstall({ entry, storeDir, installedVersion, timeoutMs, signal, error }) {
  const dir = storePackageDir(storeDir, entry.package)
  if (installedVersion === null) {
    rmSync(dir, { recursive: true, force: true })
    removeFromStoreManifest(storeDir, entry.package)
    return
  }
  try {
    await installExact({ entry, storeDir, version: installedVersion, timeoutMs, signal })
    ensureStoreDependency(storeDir, entry.package, installedVersion)
    error.message = `${error.message}；已恢复 ${entry.package}@${installedVersion}`
  } catch (restoreError) {
    error.message = `${error.message}；恢复 ${installedVersion} 也失败：${restoreError.message}`
  }
}

export async function upgradeInstalledGems({
  catalog,
  storeDir,
  coreVersion = null,
  resolveLatest = resolveLatestVersion,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  const results = []
  for (const entry of catalog.gems) {
    if (!existsSync(join(storePackageDir(storeDir, entry.package), 'worldgem.json'))) continue
    try {
      const result = await installGem({ entry, storeDir, coreVersion, resolveLatest, timeoutMs, logger })
      results.push({
        id: entry.id,
        changed: result.changed,
        version: result.version,
        previousVersion: result.previousVersion,
        latestVersion: result.latestVersion,
        latestError: result.latestError,
      })
    } catch (error) {
      logger.warn?.(`living: 宝石自动更新失败 ${entry.id}: ${error.message}`)
      results.push({ id: entry.id, error: error.message })
    }
  }
  return results
}

export function uninstallGem({ id, package: packageHint = null, storeDir, gemDataDir, logger = console }) {
  return withStoreLock(storeDir, () => {
    let dir = packageHint ? storePackageDir(storeDir, packageHint) : null
    let packageName = packageHint
    if (!dir || !existsSync(dir)) {
      const gem = findStoreGem(storeDir, id)
      if (!gem) return { removed: false, id }
      dir = gem.dir
      packageName = relativePackageName(storeDir, dir)
    }
    removeFromStoreManifest(storeDir, packageName)
    rmSync(dir, { recursive: true, force: true })
    const dataDir = join(gemDataDir, id)
    const mediaDir = join(dataDir, 'media')
    const mediaRemoved = existsSync(mediaDir)
    if (mediaRemoved) rmSync(mediaDir, { recursive: true, force: true })
    logger.log?.(`living: 宝石已卸载 ${id}（${packageName}）；配置、凭据与记忆保留`)
    return { removed: true, id, package: packageName, dir, dataDir, mediaRemoved }
  })
}

function withStoreLock(storeDir, fn) {
  const key = resolve(storeDir)
  const previous = storeLocks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  storeLocks.set(key, next.then(() => {}, () => {}))
  return next
}

function relativePackageName(storeDir, dir) {
  const modules = join(storeDir, 'node_modules')
  return dir.slice(modules.length + 1).split('\\').join('/')
}

function ensureStoreDependency(storeDir, packageName, version) {
  const path = join(storeDir, 'package.json')
  let manifest = { name: 'dsh-living-gems', private: true }
  if (existsSync(path)) {
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
  }
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [packageName]: version }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function removeFromStoreManifest(storeDir, packageName) {
  const path = join(storeDir, 'package.json')
  if (existsSync(path)) {
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (manifest.dependencies && Object.hasOwn(manifest.dependencies, packageName)) {
        delete manifest.dependencies[packageName]
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
      }
    } catch {}
  }
  rmSync(join(storeDir, 'package-lock.json'), { force: true })
  rmSync(join(storeDir, 'pnpm-lock.yaml'), { force: true })
  rmSync(join(storeDir, 'node_modules', '.package-lock.json'), { force: true })
}

function readInstalledVersion(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    throw new RangeError(`${dir}/package.json 版本不合法`)
  }
  return manifest.version
}

function runCommand(command, args, { cwd, timeoutMs, signal }) {
  return new Promise((resolvePromise, reject) => {
    const executable = process.platform === 'win32' ? `${command}.cmd` : command
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, npm_config_ignore_scripts: 'true', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const append = (current, chunk) => (current + chunk.toString()).slice(-MAX_OUTPUT_BYTES)
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(Object.assign(new Error(`命令超时: ${command} ${args.join(' ')}`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    timer.unref?.()
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(signal.reason ?? new Error('安装已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolvePromise({ code: child.exitCode, stdout, stderr })
    }
    child.on('error', (error) => finish(Object.assign(error, { code: error.code ?? 'spawn-error' })))
    child.on('close', () => finish(null))
  })
}

function tail(text) {
  return String(text ?? '').trim().split('\n').slice(-8).join('\n')
}

function httpsUrl(value, at) {
  if (typeof value !== 'string' || value === '') throw new RangeError(`${at} 必须是非空字符串`)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new RangeError(`${at} 必须是绝对 URL`)
  }
  if (url.protocol !== 'https:') throw new RangeError(`${at} 必须使用 https`)
  if (url.username !== '' || url.password !== '') throw new RangeError(`${at} 不能包含凭据`)
  return url.href
}

function plainBooleans(value, at) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError(`${at} 必须是对象`)
  const out = {}
  for (const [key, member] of Object.entries(value)) {
    if (typeof member !== 'boolean') throw new RangeError(`${at}.${key} 必须是布尔值`)
    out[key] = member
  }
  return out
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
