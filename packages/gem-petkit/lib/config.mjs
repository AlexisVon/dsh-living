import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const GEM_ID = 'petkit'
export const MANUAL_FEED_VALUES = Object.freeze([10, 20, 30, 40, 50])
const DEFAULT_TIMEZONE = 'Asia/Shanghai'

export function gemHome() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return process.env.PETKIT_GEM_HOME || process.env.LIVING_GEM_HOME || join(dshHome, 'living', 'data', 'gems', GEM_ID)
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

export function credentialPath(home = gemHome()) {
  return join(home, 'credential.json')
}

export function statePath(home = gemHome()) {
  return join(home, 'state.json')
}

export function devicesPath(home = gemHome()) {
  return join(home, 'devices.json')
}

export function selectedPath(home = gemHome()) {
  return join(home, 'selected.json')
}

export function loadCredential(home = gemHome()) {
  const cred = readJson(credentialPath(home))
  if (!cred?.sessionId || !cred?.gateway) return null
  return {
    ...cred,
    region: String(cred.region ?? 'CN').toUpperCase(),
    timezone: String(cred.timezone ?? DEFAULT_TIMEZONE),
  }
}

export function saveCredential(credential, home = gemHome()) {
  writeJsonPrivate(credentialPath(home), credential)
}

export function loadDevices(home = gemHome()) {
  const devices = readJson(devicesPath(home), [])
  return Array.isArray(devices) ? devices : []
}

export function saveDevices(devices, home = gemHome()) {
  writeJsonPrivate(devicesPath(home), devices)
}

export function loadSelected(home = gemHome()) {
  return readJson(selectedPath(home), {})?.id ?? null
}

export function saveSelected(id, home = gemHome()) {
  writeJsonPrivate(selectedPath(home), { id: String(id) })
}

export function loadConfig(home = gemHome()) {
  const file = readJson(join(home, 'config.json'), {}) ?? {}
  return {
    maxPortion: clampPortion(file.maxPortion),
    dailyFeedCap: clampInt(file.dailyFeedCap, 10, 200, 40),
    feedVerifySeconds: clampInt(file.feedVerifySeconds, 0, 60, 15),
    pollSeconds: clampInt(file.pollSeconds, 60, 600, 120),
    historyDays: clampInt(file.historyDays, 1, 30, 7),
    foodLowLevel: clampInt(file.foodLowLevel, 0, 10, 1),
    desiccantWarnDays: clampInt(file.desiccantWarnDays, 0, 30, 7),
    offlineMinutes: clampInt(file.offlineMinutes, 5, 240, 30),
    batteryLowPercent: clampInt(file.batteryLowPercent, 0, 100, 20),
    timezone: normalizeTimezone(file.timezone),
  }
}

export function loadState(home = gemHome()) {
  return readJson(statePath(home), {}) ?? {}
}

export function saveState(state, home = gemHome()) {
  writeJsonPrivate(statePath(home), state)
}

export function feedStatePath(home = gemHome()) {
  return join(home, 'feed-state.json')
}

export function loadFeedState(home = gemHome()) {
  return readJson(feedStatePath(home), {}) ?? {}
}

export function saveFeedState(state, home = gemHome()) {
  writeJsonPrivate(feedStatePath(home), state)
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function clampPortion(value) {
  const n = Number(value)
  return MANUAL_FEED_VALUES.includes(n) ? n : 20
}

function normalizeTimezone(value) {
  const timezone = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
    return timezone
  } catch {
    return DEFAULT_TIMEZONE
  }
}
