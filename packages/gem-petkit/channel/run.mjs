#!/usr/bin/env node
import { PetkitClient, FEEDER_TYPES, todayIn } from '../lib/client.mjs'
import { loadConfig, gemHome, loadCredential, saveCredential, loadState, saveState, loadDevices, loadSelected } from '../lib/config.mjs'
import { createCoreClient } from '../lib/core.mjs'
import { alarmEvents, feedEvents, offlineAlarm, onlineRecovery } from '../lib/events.mjs'
import { isAuthError } from '../lib/errors.mjs'

const baseUrl = process.env.LIVING_BASE_URL || 'http://127.0.0.1:3000'
const gem = process.env.LIVING_GEM_ID || 'petkit'
const token = process.env.LIVING_GEM_TOKEN

if (!token) {
  console.error('[petkit] LIVING_GEM_TOKEN 未设置；从 DSH 配置的 gemTokensJson 里取')
  process.exit(2)
}

const home = gemHome()
let credential = loadCredential(home)
if (!credential) {
  console.error('[petkit] 未登录：在宝石页输入小佩账号密码')
  process.exit(2)
}

const config = loadConfig(home)
const devices = loadDevices(home)
const selectedId = loadSelected(home)
const storedDevice = devices.find((device) => device.id === selectedId)
  ?? (devices.filter((device) => FEEDER_TYPES.has(device.deviceType)).length === 1
    ? devices.find((device) => FEEDER_TYPES.has(device.deviceType))
    : null)
if (!storedDevice) {
  console.error('[petkit] 没有选中的喂食器：重新登录或检查 devices.json')
  process.exit(2)
}

const state = loadState(home)
// Feed state is owned by the MCP server; the channel only owns seen feeds and alarms.
delete state.gemFeeds
delete state.pendingFeedAt
state.seenFeedIds ??= []
state.alarms ??= {}
let seen = new Set(state.seenFeedIds)
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
  })
}

const log = (message) => console.log(`${new Date().toISOString()} [petkit] ${message}`)
const core = createCoreClient({ baseUrl, gem, token })
const client = new PetkitClient({
  credential,
  config,
  log: process.env.PETKIT_DEBUG === '1' ? (line) => console.error(line) : () => {},
})

function sleep(ms) {
  return new Promise((resolve) => {
    const end = Date.now() + ms
    const tick = () => {
      if (stopping || Date.now() >= end) return resolve()
      setTimeout(tick, Math.min(1000, end - Date.now()))
    }
    tick()
  })
}

async function ingest(event) {
  try {
    await core.ingest(event)
    log(`事件 ${event.meta?.alarm ?? 'feed'}: ${event.text}`)
  } catch (error) {
    log(`事件写入失败: ${error.message}`)
  }
}

async function ensureSession() {
  if (credential.expiresAt && credential.expiresAt - Date.now() > 5 * 60_000) return
  const next = await client.refresh()
  credential = { ...credential, ...next }
  saveCredential(credential, home)
  client.setSession(credential)
  log('会话已刷新')
}

let failureSince = 0
let offlineAnnounced = false

async function pollOnce() {
  await ensureSession()
  const detail = await client.detail(storedDevice)
  const device = { ...storedDevice, name: detail?.name || storedDevice.name }
  const day = todayIn(config.timezone)

  if (offlineAnnounced) {
    await ingest(onlineRecovery(device))
    offlineAnnounced = false
  }
  failureSince = 0

  for (const event of alarmEvents({ detail, config, state, device, day })) await ingest(event)
  saveState(state, home)

  try {
    const records = await client.records(device, day)
    const { events, seen: nextSeen } = feedEvents(device, records, seen)
    for (const event of events) await ingest(event)
    seen = new Set([...nextSeen].slice(-500))
    state.seenFeedIds = [...seen]
    saveState(state, home)
  } catch (error) {
    if (isAuthError(error)) throw error
    log(`读取出粮记录失败: ${error.message}`)
  }
}

async function main() {
  log(`通道启动：${storedDevice.id} ${storedDevice.deviceType}，轮询 ${config.pollSeconds}s`)
  while (!stopping) {
    try {
      await pollOnce()
    } catch (error) {
      if (isAuthError(error)) {
        log('登录态失效，退出等待重新登录')
        process.exit(2)
      }
      if (failureSince === 0) failureSince = Date.now()
      if (!offlineAnnounced && Date.now() - failureSince >= config.offlineMinutes * 60_000) {
        await ingest(offlineAlarm(storedDevice))
        offlineAnnounced = true
      }
      log(`轮询失败: ${error.message}`)
    }
    await sleep(config.pollSeconds * 1000)
  }
  log('收到停止信号')
}

main().catch((error) => {
  console.error(`[petkit] 通道异常: ${error.stack ?? error.message}`)
  process.exit(1)
})
