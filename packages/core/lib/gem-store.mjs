/** Living-managed gem store: catalog, npm installation, scanning, removal. */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadGem } from './gems.mjs'

const CATALOG_URL = new URL('../gems/catalog.json', import.meta.url)
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 128 * 1024
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/u
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const inFlight = new Map()
const storeLocks = new Map()

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
export function scanStoreGems(storeDir, { loadGemFn = loadGem } = {}) {
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
      gems.push(loadGemFn(dir))
    } catch (error) {
      errors.push({ dir, message: error.message })
    }
  }
  gems.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
  return { gems, errors }
}

export function catalogStatus(catalog, { storeDir, gemDataDir }) {
  return catalog.gems.map((entry) => {
    const dir = storePackageDir(storeDir, entry.package)
    const installed = existsSync(join(dir, 'worldgem.json'))
    let installedVersion = null
    let broken = null
    if (installed) {
      try {
        const gem = loadGem(dir)
        if (gem.manifest.id !== entry.id) throw new RangeError(`包内 id 是 ${gem.manifest.id}，目录期望 ${entry.id}`)
        installedVersion = readInstalledVersion(dir)
      } catch (error) {
        broken = error.message
      }
    }
    const dataDir = join(gemDataDir, entry.id)
    return {
      ...entry,
      installed,
      installedVersion,
      broken,
      dataDir,
      hasMedia: existsSync(join(dataDir, 'media')),
    }
  })
}

export function installGem({ entry, storeDir, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, logger = console }) {
  const key = `${resolve(storeDir)}:${entry.package}`
  const running = inFlight.get(key)
  if (running) return running
  const task = withStoreLock(storeDir, () => doInstall({ entry, storeDir, timeoutMs, signal, logger }))
    .finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

async function doInstall({ entry, storeDir, timeoutMs, signal, logger }) {
  mkdirSync(storeDir, { recursive: true })
  const installedDir = storePackageDir(storeDir, entry.package)
  if (existsSync(join(installedDir, 'worldgem.json'))) {
    try {
      const version = readInstalledVersion(installedDir)
      if (version === entry.version) {
        const gem = loadGem(installedDir)
        if (gem.manifest.id === entry.id) {
          ensureStoreDependency(storeDir, entry.package, version)
          return { id: entry.id, package: entry.package, version, dir: installedDir }
        }
      }
    } catch {}
  }
  const manifestPath = join(storeDir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({ name: 'dsh-living-gems', private: true }, null, 2)}\n`)
  }
  const spec = `${entry.package}@${entry.version}`
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
  if (result.code !== 0) throw new Error(`宝石安装失败（${entry.package}@${entry.version}）: ${tail(result.stderr || result.stdout)}`)
  const dir = storePackageDir(storeDir, entry.package)
  try {
    const gem = loadGem(dir)
    if (gem.manifest.id !== entry.id) throw new RangeError(`包 ${entry.package} 的宝石 id 是 ${gem.manifest.id}，目录期望 ${entry.id}`)
    const installedVersion = readInstalledVersion(dir)
    ensureStoreDependency(storeDir, entry.package, installedVersion)
    logger.log?.(`living: 宝石已安装 ${entry.id} ${entry.package}@${installedVersion}`)
    return { id: entry.id, package: entry.package, version: installedVersion, dir }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
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
