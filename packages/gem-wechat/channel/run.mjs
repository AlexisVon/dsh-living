#!/usr/bin/env node
import {
  gemHome,
  loadConfig,
  loadState,
  loadSyncBuf,
  loadToken,
  saveState,
  saveSyncBuf,
  syncBufPath,
  tokenPath,
} from '../lib/config.mjs'
import { join } from 'node:path'
import { createCoreClient, failureCodeFor, isCoreUnreachable } from '../lib/channel.mjs'
import {
  DEFAULT_BASE_URL,
  getUpdates,
  inboundEvent,
  isSessionTimeout,
  isUserMessage,
  mediaItems,
  notifyStart,
  notifyStop,
  resolveRecipient,
  sendOutbound,
} from '../lib/ilink.mjs'
import {
  downloadMedia,
  parseAesKey,
  readLocalMedia,
  sanitizeFileName,
  saveInboundMedia,
} from '../lib/media.mjs'
import { createProactiveLimit } from '../lib/limits.mjs'

const baseUrl = process.env.LIVING_BASE_URL || 'http://127.0.0.1:3000'
const gem = process.env.LIVING_GEM_ID || 'wechat'
const token = process.env.LIVING_GEM_TOKEN

if (!token) {
  console.error('[wechat] LIVING_GEM_TOKEN 未设置；从 DSH 配置的 gemTokensJson 里取')
  process.exit(2)
}

const home = gemHome()
const login = loadToken(home)
if (!login) {
  console.error(`[wechat] 未登录：先运行 node channel/login.mjs（凭据目录 ${home}）`)
  process.exit(2)
}

const config = loadConfig(home)
const state = loadState(home)
state.contextTokens ??= {}
const proactive = createProactiveLimit({ state, config, save: () => saveState(state, home) })
const core = createCoreClient({ baseUrl, gem, token })

function quotaReport() {
  const snapshot = proactive.snapshot()
  return { day: snapshot.day, cap: config.proactiveDaily, sent: snapshot.proactiveSent }
}
let gateway = login.baseUrl || config.baseUrl || DEFAULT_BASE_URL

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    log(`收到 ${signal}，停止`)
    setTimeout(() => process.exit(0), 100)
  })
}

function log(message) {
  console.log(`${new Date().toISOString()} [wechat] ${message}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function senderAllowed(from) {
  if (config.allowedUsers.length > 0) return config.allowedUsers.includes(from)
  return from === String(login.userId)
}

const sendWindow = []

/** Sliding one-minute window for all outbound bubbles; waits instead of failing. */
async function waitForSendSlot() {
  for (;;) {
    const now = Date.now()
    while (sendWindow.length > 0 && now - sendWindow[0] >= 60_000) sendWindow.shift()
    const wait = sendWindow.length >= config.sendPerMinute ? 60_000 - (now - sendWindow[0]) : 0
    if (wait <= 0) {
      sendWindow.push(now)
      return
    }
    log(`外发节流：等待 ${Math.ceil(wait / 1000)}s`)
    await sleep(Math.min(wait, 60_000))
  }
}

/** Download image/file attachments and return them indexed by item_list position. */
async function prepareAttachments(message) {
  const items = mediaItems(message)
  if (items.length === 0) return []
  const attachments = []
  const dir = join(home, 'media', new Date().toISOString().slice(0, 10))
  for (const item of items) {
    try {
      const aesKey = parseAesKey(item.media)
      if (!aesKey) throw new Error('缺少 aes_key')
      const buffer = await downloadMedia({
        encryptQueryParam: item.media.encrypt_query_param,
        aesKey,
        cdnBaseUrl: config.cdnBaseUrl,
        maxBytes: config.maxMediaBytes,
      })
      const path = saveInboundMedia(buffer, {
        dir,
        messageId: message.message_id ?? message.client_id ?? message.seq,
        index: item.index,
        fileName: item.fileName,
        kind: item.kind,
      })
      const name = item.kind === 'file' ? sanitizeFileName(item.fileName ?? 'file') : undefined
      attachments[item.index] = { kind: item.kind, path, ...(name ? { name } : {}), size: buffer.length }
      log(`媒体${item.kind === 'image' ? '图片' : '文件'} -> ${path}`)
    } catch (error) {
      log(`媒体下载失败（${item.kind}）: ${error.message}`)
    }
  }
  return attachments
}

async function monitor() {
  let buf = loadSyncBuf(home)
  let failures = 0
  let backoff = 5000
  while (!stopping) {
    try {
      const response = await getUpdates({ baseUrl: gateway, token: login.token, buf })
      for (const message of response.msgs ?? []) {
        if (!isUserMessage(message)) continue
        const from = String(message.from_user_id)
        if (!senderAllowed(from)) {
          log(`忽略非绑定用户 ${from}`)
          continue
        }
        if (message.group_id) {
          log(`忽略群消息 ${message.group_id}（首版只做私聊）`)
          continue
        }
        if (message.context_token) {
          state.contextTokens[from] = message.context_token
          saveState(state, home)
        }
        try {
          const attachments = await prepareAttachments(message)
          const event = inboundEvent(message, { gem, ownerId: login.userId, attachments })
          await core.ingest(event)
          log(`入站 ${from}: ${event.text.slice(0, 60)}`)
        } catch (error) {
          log(`入站失败 ${from}: ${error.message}`)
        }
      }
      if (response.get_updates_buf) {
        buf = response.get_updates_buf
        saveSyncBuf(buf, home)
      }
      failures = 0
      backoff = 5000
    } catch (error) {
      failures += 1
      if (isSessionTimeout(error)) {
        log('登录态失效（-14），尝试重建会话…')
        try {
          await notifyStart({ baseUrl: gateway, token: login.token })
        } catch (notifyError) {
          log(`重建会话失败: ${notifyError.message}`)
        }
        const next = loadToken(home)
        if (next && next.token !== login.token) {
          Object.assign(login, next)
          gateway = login.baseUrl || config.baseUrl || DEFAULT_BASE_URL
          buf = ''
          saveSyncBuf(buf, home)
          log('已重新加载扫码后的凭据，同步游标已重置')
        }
      } else {
        log(`长轮询失败（${failures}）: ${error.message}`)
      }
      if (failures >= 6) log(`连续失败 ${failures} 次，可能需要重新扫码：node channel/login.mjs`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 5 * 60_000)
    }
  }
  try {
    await notifyStop({ baseUrl: gateway, token: login.token })
  } catch {}
}

async function pollOutbox() {
  const items = await core.pullOutbox(20)
  for (const item of items) {
    const to = resolveRecipient(item.to, login.userId)
    try {
      if (proactive.atLimit(item)) {
        await core.ack(item.id, { ok: false, code: 'provider_quota', quota: quotaReport() })
        log(`拒绝主动外发 ${item.id}：今日主动额度已用尽`)
        continue
      }
      await waitForSendSlot()
      const media = (item.media ?? []).map((entry) => {
        const local = readLocalMedia(entry.path, { maxBytes: config.maxMediaBytes })
        return { buffer: local.buffer, fileName: entry.name ?? local.name, kind: entry.kind ?? local.kind }
      })
      const result = await sendOutbound(item, {
        token: login.token,
        boundUserId: login.userId,
        baseUrl: gateway,
        cdnBaseUrl: config.cdnBaseUrl,
        contextToken: state.contextTokens[to] ?? null,
        chunkLimit: config.textChunkLimit,
        media,
      })
      proactive.noteSent(item)
      await core.ack(item.id, { ok: true, external_id: result.externalId, quota: quotaReport() })
      log(`已发送 ${item.id} -> ${to}`)
    } catch (error) {
      const code = failureCodeFor(error)
      log(`发送失败 ${item.id} -> ${to}: ${error.message}（${code}）`)
      await core.ack(item.id, { ok: false, code, quota: quotaReport() })
    }
  }
}

function startOutboxLoop() {
  let running = false
  let backoff = 0
  const interval = config.outboxPollSeconds * 1000
  const tick = async () => {
    if (stopping) return
    if (!running) {
      running = true
      try {
        await pollOutbox()
        if (backoff > 0) {
          log('核心恢复连接')
          backoff = 0
        }
      } catch (error) {
        if (isCoreUnreachable(error)) {
          backoff = backoff ? Math.min(backoff * 2, 60_000) : 5_000
          log(`外发轮询失败（核心不可达，${Math.round(backoff / 1000)}s 后重试）: ${error.message}`)
        } else {
          log(`外发轮询失败: ${error.message}`)
        }
      } finally {
        running = false
      }
    }
    if (!stopping) setTimeout(tick, backoff || interval)
  }
  setTimeout(tick, 0)
}

log(`启动：core=${baseUrl} gateway=${gateway} gem=${gem} user=${login.userId}`)
log(`同步游标 ${syncBufPath(home)}，凭据 ${tokenPath(home)}`)
startOutboxLoop()
monitor()
