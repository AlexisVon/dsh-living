import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const GEM_ID = 'wechat'

export function gemHome() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return process.env.WECHAT_GEM_HOME || process.env.LIVING_GEM_HOME || join(dshHome, 'living', 'data', 'gems', GEM_ID)
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback
  const text = readFileSync(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new RangeError(`${path} 不是合法 JSON: ${error.message}`)
  }
}

export function writeJsonPrivate(path, value) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {}
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {}
}

export function tokenPath(home = gemHome()) {
  return join(home, 'auth', 'token.json')
}

export function syncBufPath(home = gemHome()) {
  return join(home, 'sync-buf.json')
}

export function loadToken(home = gemHome()) {
  const token = readJson(tokenPath(home))
  if (!token?.token) return null
  return token
}

export function saveToken(token, home = gemHome()) {
  writeJsonPrivate(tokenPath(home), token)
}

export function statePath(home = gemHome()) {
  return join(home, 'state.json')
}

export function loadState(home = gemHome()) {
  return readJson(statePath(home), {}) ?? {}
}

export function saveState(state, home = gemHome()) {
  writeJsonPrivate(statePath(home), state)
}

export function clearSyncBuf(home = gemHome()) {
  try {
    if (existsSync(syncBufPath(home))) unlinkSync(syncBufPath(home))
  } catch {}
}

export function loadSyncBuf(home = gemHome()) {
  return readJson(syncBufPath(home), {})?.get_updates_buf ?? ''
}

export function saveSyncBuf(buf, home = gemHome()) {
  writeJsonPrivate(syncBufPath(home), { get_updates_buf: buf })
}

export function loadConfig(home = gemHome()) {
  const file = readJson(join(home, 'config.json'), {}) ?? {}
  return {
    outboxPollSeconds: clampInt(file.outboxPollSeconds, 2, 300, 5),
    baseUrl: typeof file.baseUrl === 'string' && file.baseUrl ? file.baseUrl : null,
    botType: typeof file.botType === 'string' && file.botType ? file.botType : '3',
    textChunkLimit: clampInt(file.textChunkLimit, 200, 4000, 4000),
    allowedUsers: Array.isArray(file.allowedUsers) ? file.allowedUsers.map(String) : [],
    cdnBaseUrl: typeof file.cdnBaseUrl === 'string' && file.cdnBaseUrl
      ? file.cdnBaseUrl.replace(/\/$/, '')
      : 'https://novac2c.cdn.weixin.qq.com/c2c',
    maxMediaBytes: clampInt(file.maxMediaBytes, 1024 * 1024, 100 * 1024 * 1024, 20 * 1024 * 1024),
    sendPerMinute: clampInt(file.sendPerMinute, 1, 60, 5),
    proactiveDaily: clampInt(file.proactiveDaily, 0, 500, 20),
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
