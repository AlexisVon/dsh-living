/** Gem home inspection and config editing for the authenticated settings UI. */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateGemConfigValues } from 'dsh-living-protocol'

const MAX_JSON_BYTES = 64 * 1024
const CREDENTIAL_FILES = ['credential.json', join('auth', 'token.json')]
const SAFE_CREDENTIAL_FIELDS = ['savedAt', 'uname', 'mid', 'dedeuserid', 'accountId', 'userId', 'baseUrl']

export function defaultGemHome(gemDataDir, id) {
  if (typeof gemDataDir !== 'string' || gemDataDir === '') throw new RangeError('宝石数据目录必填')
  return join(gemDataDir, id)
}

export function resolveGemHomes(gems, overrides = {}, { gemDataDir } = {}) {
  for (const [id, value] of Object.entries(overrides ?? {})) {
    if (typeof value !== 'string' || value.trim() === '') throw new RangeError(`gemHomesJson.${id} 必须是非空字符串`)
  }
  const homes = {}
  for (const gem of gems) {
    const id = gem.manifest.id
    const override = overrides?.[id]
    homes[id] = override?.trim() ? override : defaultGemHome(gemDataDir, id)
  }
  return homes
}

export function readGemConfig(home) {
  const path = join(home, 'config.json')
  if (!existsSync(path)) return { config: {}, configText: '{}\n', configError: null, configMtime: null }
  const stat = statSync(path)
  if (stat.size > MAX_JSON_BYTES) {
    return { config: null, configText: '', configError: 'config.json 超过 64KB', configMtime: stat.mtimeMs }
  }
  const configText = readFileSync(path, 'utf8')
  try {
    const config = JSON.parse(configText)
    if (!isPlainObject(config)) throw new Error('config.json 必须是 JSON 对象')
    return { config, configText, configError: null, configMtime: stat.mtimeMs }
  } catch (error) {
    return { config: null, configText, configError: error.message, configMtime: stat.mtimeMs }
  }
}

export function writeGemConfig(home, config, fields = null) {
  if (!isPlainObject(config)) throw new RangeError('gem config 必须是 JSON 对象')
  if (Array.isArray(fields)) {
    const result = validateGemConfigValues(fields, config)
    if (!result.ok) {
      const error = new RangeError(`宝石配置不合法: ${result.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`)
      error.errors = result.errors
      throw error
    }
  }
  const text = `${JSON.stringify(config, null, 2)}\n`
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new RangeError('gem config 超过 64KB')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  try {
    chmodSync(home, 0o700)
  } catch {}
  const path = join(home, 'config.json')
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
  return config
}

export function readCredentialStatus(home) {
  for (const relative of CREDENTIAL_FILES) {
    const path = join(home, relative)
    if (!existsSync(path)) continue
    const stat = statSync(path)
    const fallbackSavedAt = new Date(stat.mtimeMs).toISOString()
    if (stat.size > MAX_JSON_BYTES) return { present: true, savedAt: fallbackSavedAt, error: '凭据文件超过 64KB', account: {} }
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      const account = {}
      for (const field of SAFE_CREDENTIAL_FIELDS) {
        if (value?.[field] !== undefined && value[field] !== null && value[field] !== '') account[field] = String(value[field])
      }
      return { present: true, savedAt: account.savedAt || fallbackSavedAt, account }
    } catch {
      return { present: true, savedAt: fallbackSavedAt, error: '凭据文件不是合法 JSON', account: {} }
    }
  }
  return { present: false, savedAt: null, error: null, account: {} }
}

export function gemSummaries({ gems, gemHomes, gemDataDir, health = [], tokens = {} }) {
  const healthById = new Map(health.map((row) => [row.id, row]))
  return gems.map((gem) => {
    const id = gem.manifest.id
    const home = gemHomes[id] ?? defaultGemHome(gemDataDir, id)
    const config = readGemConfig(home)
    const credential = readCredentialStatus(home)
    const state = healthById.get(id) ?? {}
    return {
      id,
      name: gem.manifest.name,
      version: gem.manifest.version,
      description: gem.manifest.description ?? '',
      dir: gem.dir,
      home,
      available: state.available ?? true,
      failures: state.failures ?? 0,
      lastError: state.lastError ?? null,
      degradedUntil: state.degradedUntil ?? 0,
      capabilities: gem.manifest.capabilities ?? {},
      limits: gem.manifest.limits ?? {},
      notify: gem.manifest.notify ?? null,
      etiquette: gem.manifest.etiquette ?? [],
      failureHints: gem.manifest.failure_hints ?? {},
      configSchema: gem.manifest.config ?? null,
      tokenConfigured: tokens[id] === true,
      hasSkill: Boolean(gem.skill),
      hasLoginRpc: existsSync(join(gem.dir, 'channel', 'login-rpc.mjs')),
      ...config,
      credential,
    }
  })
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
