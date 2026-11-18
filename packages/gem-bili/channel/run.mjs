#!/usr/bin/env node
import { fetchDmMessages, getMsgfeed, listDmSessions, sendOutbound } from '../lib/api.mjs'
import { createCoreClient, dmEvent, failureCodeFor, isCoreUnreachable, noticeEvent } from '../lib/channel.mjs'
import { gemHome, loadConfig, loadCredential, loadState, saveState } from '../lib/config.mjs'
import { createProactiveLimit } from '../lib/limits.mjs'

const baseUrl = process.env.LIVING_BASE_URL || 'http://127.0.0.1:3000'
const gem = process.env.LIVING_GEM_ID || 'bili'
const token = process.env.LIVING_GEM_TOKEN

if (!token) {
  console.error('[bili] LIVING_GEM_TOKEN 未设置；从 DSH 配置的 gemTokensJson 里取')
  process.exit(2)
}

const home = gemHome()
let cred = loadCredential(home)
if (!cred) {
  console.error(`[bili] 未登录：先运行 node channel/login.mjs（凭据目录 ${home}）`)
  process.exit(2)
}

const config = loadConfig(home)
const state = loadState(home)
state.dm ??= {}
state.notices ??= {}
state.seenNotices ??= []
const seen = new Set(state.seenNotices)
const proactive = createProactiveLimit({ state, config, save: () => saveState(state, home) })
const core = createCoreClient({ baseUrl, gem, token })

function quotaReport() {
  const snapshot = proactive.snapshot()
  return { day: snapshot.day, cap: config.proactiveDaily, sent: snapshot.proactiveSent }
}

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    log(`收到 ${signal}，停止`)
    setTimeout(() => process.exit(0), 100)
  })
}

function log(message) {
  console.log(`${new Date().toISOString()} [bili] ${message}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const sendWindow = []
const lastByTarget = new Map()

/** Sliding-window rate limit plus per-target cooldown; waits instead of hammering B站. */
async function waitForSendSlot(to) {
  for (;;) {
    const now = Date.now()
    while (sendWindow.length > 0 && now - sendWindow[0] >= 60_000) sendWindow.shift()
    const cooldownLeft = (lastByTarget.get(to) ?? 0) + config.replyCooldownSeconds * 1000 - now
    const rateLeft = sendWindow.length >= config.sendPerMinute ? 60_000 - (now - sendWindow[0]) : 0
    const wait = Math.max(cooldownLeft, rateLeft, 0)
    if (wait <= 0) {
      sendWindow.push(now)
      lastByTarget.set(to, now)
      return
    }
    log(`外发节流：${to} 等待 ${Math.ceil(wait / 1000)}s`)
    await sleep(Math.min(wait, 60_000))
  }
}

function reloadCredential(error) {
  if (error?.kind !== 'auth') return
  const next = loadCredential(home)
  if (next) cred = next
}

async function pollDm() {
  const sessions = await listDmSessions({ cred })
  const nowSec = Math.floor(Date.now() / 1000)
  for (const session of sessions) {
    if (stopping) return
    const firstRun = !(session.uid in state.dm)
    const cursor = firstRun ? nowSec - config.dmHistorySeconds : Math.max(state.dm[session.uid], nowSec - 86400)
    if (!firstRun && session.lastTs > 0 && session.lastTs < cursor) continue

    const messages = await fetchDmMessages(session.uid, { cred })
    if (messages.length === 0) continue
    // >= keeps same-second messages from being skipped; core dedupes by msg_key.
    let fresh = messages.filter((message) => !message.fromMe && message.ts >= cursor)
    if (firstRun && session.unread > 0) {
      const unread = messages.filter((message) => !message.fromMe).slice(-Math.min(session.unread, 5))
      const merged = new Map([...fresh, ...unread].map((message) => [message.key, message]))
      fresh = [...merged.values()].sort((a, b) => a.ts - b.ts)
    }

    for (const message of fresh) {
      await core.ingest(dmEvent({ uid: session.uid, message, gem, ownerUid: config.ownerUid }))
      log(`私信 ${session.uid}: ${message.text.slice(0, 60)}`)
    }
    state.dm[session.uid] = Math.max(cursor, ...messages.map((message) => message.ts))
    saveState(state, home)
  }
}

async function pollNotices() {
  const floor = Date.now() - 24 * 3600 * 1000
  for (const kind of ['at', 'reply']) {
    if (stopping) return
    const items = await getMsgfeed(kind, { cred })
    const last = Math.max(state.notices[kind] ?? 0, floor)
    const fresh = items
      .filter((item) => item.ts >= last && !seen.has(`${kind}:${item.id}`))
      .sort((a, b) => a.ts - b.ts)
    for (const item of fresh) {
      await core.ingest(noticeEvent(item, { gem, ownerUid: config.ownerUid }))
      seen.add(`${kind}:${item.id}`)
      log(`${kind} 通知: ${item.name || item.uid} ${item.text.slice(0, 60)}`)
    }
    if (fresh.length > 0) state.notices[kind] = Math.max(last, ...fresh.map((item) => item.ts))
    state.seenNotices = [...seen].slice(-300)
    saveState(state, home)
  }
}

async function pollOutbox() {
  const items = await core.pullOutbox(20)
  for (const item of items) {
    try {
      if (Array.isArray(item.media) && item.media.length > 0) {
        await core.ack(item.id, { ok: false, code: 'config_invalid', quota: quotaReport() })
        log(`拒绝媒体外发 ${item.id}：B站宝石不支持附件`)
        continue
      }
      if (!String(item.text ?? '').trim()) {
        await core.ack(item.id, { ok: false, code: 'config_invalid', quota: quotaReport() })
        log(`拒绝空外发 ${item.id}`)
        continue
      }
      if (proactive.atLimit(item)) {
        await core.ack(item.id, { ok: false, code: 'provider_quota', quota: quotaReport() })
        log(`拒绝主动外发 ${item.id}：今日主动额度已用尽`)
        continue
      }
      await waitForSendSlot(item.to)
      const result = await sendOutbound(item.to, item.text, { cred })
      proactive.noteSent(item)
      await core.ack(item.id, { ok: true, external_id: result.externalId, quota: quotaReport() })
      log(`已发送 ${item.id} -> ${item.to}`)
    } catch (error) {
      const code = failureCodeFor(error)
      log(`发送失败 ${item.id} -> ${item.to}: ${error.message}（${code}）`)
      reloadCredential(error)
      await core.ack(item.id, { ok: false, code, quota: quotaReport() })
    }
  }
}

function startLoop(name, intervalMs, fn, { coreBackoff = false } = {}) {
  let running = false
  let backoff = 0
  const tick = async () => {
    if (stopping) return
    if (!running) {
      running = true
      try {
        await fn()
        if (backoff > 0) {
          log(`${name}：核心恢复连接`)
          backoff = 0
        }
      } catch (error) {
        if (coreBackoff && isCoreUnreachable(error)) {
          backoff = backoff ? Math.min(backoff * 2, 60_000) : 5_000
          log(`${name} 失败（核心不可达，${Math.round(backoff / 1000)}s 后重试）: ${error.message}`)
        } else {
          log(`${name} 失败: ${error.message}`)
          reloadCredential(error)
        }
      } finally {
        running = false
      }
    }
    if (!stopping) setTimeout(tick, backoff || intervalMs)
  }
  setTimeout(tick, 0)
}

log(`启动：core=${baseUrl} gem=${gem} botUid=${cred.dedeuserid} ownerUid=${config.ownerUid || '(未配置，所有 B站 内容按外部数据)'}`)
startLoop('私信轮询', config.dmPollSeconds * 1000, pollDm)
startLoop('通知轮询', config.noticePollSeconds * 1000, pollNotices)
startLoop('外发轮询', config.outboxPollSeconds * 1000, pollOutbox, { coreBackoff: true })
