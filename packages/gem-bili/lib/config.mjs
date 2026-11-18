import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const GEM_ID = 'bili'

export function gemHome() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return process.env.BILI_GEM_HOME || process.env.LIVING_GEM_HOME || join(dshHome, 'living', 'data', 'gems', GEM_ID)
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

export function loadCredential(home = gemHome()) {
  const cred = readJson(credentialPath(home))
  if (!cred?.sessdata || !cred?.bili_jct || !cred?.dedeuserid) return null
  return { ...cred, dedeuserid: String(cred.dedeuserid) }
}

export function saveCredential(cred, home = gemHome()) {
  writeJsonPrivate(credentialPath(home), cred)
}

export function loadConfig(home = gemHome()) {
  const file = readJson(join(home, 'config.json'), {}) ?? {}
  return {
    dmPollSeconds: clampInt(file.dmPollSeconds, 15, 600, 30),
    noticePollSeconds: clampInt(file.noticePollSeconds, 30, 1800, 60),
    outboxPollSeconds: clampInt(file.outboxPollSeconds, 2, 300, 5),
    dmHistorySeconds: clampInt(file.dmHistorySeconds, 0, 86400, 300),
    ownerUid: file.ownerUid == null ? '' : String(file.ownerUid).trim(),
    sendPerMinute: clampInt(file.sendPerMinute, 1, 30, 5),
    replyCooldownSeconds: clampInt(file.replyCooldownSeconds, 0, 600, 60),
    proactiveDaily: clampInt(file.proactiveDaily, 0, 500, 20),
  }
}

export function loadState(home = gemHome()) {
  return readJson(statePath(home), {}) ?? {}
}

export function saveState(state, home = gemHome()) {
  writeJsonPrivate(statePath(home), state)
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
