import { ENDPOINTS, FAILURE_CODES } from 'dsh-living-protocol'
import { BiliError } from './api.mjs'

export class CoreError extends Error {
  constructor(status, message, body) {
    super(message)
    this.name = 'CoreError'
    this.status = status
    this.body = body
  }
}

export function createCoreClient({ baseUrl, gem, token, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!baseUrl) throw new RangeError('core baseUrl 必填')
  if (!gem) throw new RangeError('core gem 必填')
  if (!token) throw new RangeError('core token 必填')
  const base = baseUrl.replace(/\/$/, '')
  const headers = { 'x-living-token': token }

  async function request(url, options = {}) {
    const response = await fetchImpl(url, { ...options, headers: { ...headers, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!response.ok) throw new CoreError(response.status, `core ${response.status}: ${text.slice(0, 200)}`, body)
    return body
  }

  return {
    async ingest(payload) {
      return request(`${base}${ENDPOINTS.ingest}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
    async pullOutbox(limit = 20) {
      const query = new URLSearchParams({ gem, limit: String(limit) })
      return request(`${base}${ENDPOINTS.outbox}?${query}`)
    },
    async ack(id, body) {
      return request(`${base}${ENDPOINTS.ack(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
  }
}

export function dmEvent({ uid, message, gem = 'bili', ownerUid = null }) {
  // System notices are noise: keep them as silent notices so they never wake a paid round.
  if (message.system === true) {
    return {
      gem,
      kind: 'notice',
      external_id: `bili_dm_${message.key}`,
      from: { id: String(uid), name: '' },
      text: message.text,
      ts: message.ts > 0 && message.ts < 1e12 ? message.ts * 1000 : message.ts,
      meta: { msg_key: message.key, notice_kind: 'system', silent: true, trusted: false },
    }
  }
  return {
    gem,
    kind: 'message',
    external_id: `bili_dm_${message.key}`,
    from: { id: String(uid), name: '' },
    text: message.text,
    ts: message.ts > 0 && message.ts < 1e12 ? message.ts * 1000 : message.ts,
    meta: {
      reply_to: `uid:${uid}`,
      msg_key: message.key,
      trusted: String(ownerUid ?? '').trim() !== '' && String(uid) === String(ownerUid),
    },
  }
}

export function noticeEvent(item, { gem = 'bili', ownerUid = null } = {}) {
  const who = item.name || `uid:${item.uid}`
  const title = item.title ? `「${item.title}」` : '评论'
  const text =
    item.kind === 'at'
      ? `${who} 在${title}里 @ 了你：${item.text}${item.uri ? `（${item.uri}）` : ''}`
      : `${who} 回复了你的评论：${item.text}${item.title ? `（${item.title}）` : ''}${item.uri ? `（${item.uri}）` : ''}`
  return {
    gem,
    kind: 'notice',
    external_id: `bili_${item.kind}_${item.id}`,
    from: { id: String(item.uid || '0'), name: item.name || '' },
    text,
    ts: item.ts || Date.now(),
    meta: {
      reply_to: item.replyTo ?? undefined,
      uri: item.uri || undefined,
      title: item.title || undefined,
      notice_kind: item.kind,
      trusted: String(ownerUid ?? '').trim() !== '' && String(item.uid) === String(ownerUid),
    },
  }
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** Whether the core host itself is unreachable (down or restarting), not a channel-level failure. */
export function isCoreUnreachable(error) {
  for (let current = error; current; current = current.cause) {
    if (UNREACHABLE_CODES.has(current.code)) return true
  }
  return false
}

export function failureCodeFor(error) {
  if (error instanceof CoreError) return FAILURE_CODES.UNKNOWN
  if (error instanceof BiliError) {
    if (error.kind === 'auth') return FAILURE_CODES.GEM_COOKIE_EXPIRED
    if (error.kind === 'rate') return FAILURE_CODES.PROVIDER_RATE
    if (error.kind === 'network') return FAILURE_CODES.PROVIDER_TIMEOUT
    if (error.kind === 'config') return FAILURE_CODES.CONFIG_INVALID
    if (error.code === -400) return FAILURE_CODES.CONFIG_INVALID
  }
  return FAILURE_CODES.UNKNOWN
}
