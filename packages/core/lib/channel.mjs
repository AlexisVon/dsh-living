/** Channel logic behind /living/ingest, /living/outbox and /living/outbox/:id/ack. */

import { timingSafeEqual } from 'node:crypto'
import { ProtocolError, normalizeIngest, validateAck } from 'dsh-living-protocol'

export const CHANNEL_ERRORS = Object.freeze({
  UNAUTHORIZED: 'unauthorized',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN_GEM: 'unknown_gem',
})

export function createChannel({
  store,
  tokens = {},
  limits = {},
  now = Date.now,
  onGemFailure = null,
  onGemSuccess = null,
  shouldWake = null,
  onWake = null,
} = {}) {
  if (!store) throw new RangeError('channel 需要 store')
  const windows = new Map()
  const tokenSource = typeof tokens === 'function' ? tokens : () => tokens

  function authenticate(gem, token) {
    const expected = tokenSource()[gem]
    if (typeof expected !== 'string' || expected === '') return false
    if (typeof token !== 'string' || token === '') return false
    const a = Buffer.from(expected)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  function allowRate(gem, nowMs) {
    const perMinute = Number(limits[gem]?.perMinute)
    if (!Number.isFinite(perMinute) || perMinute <= 0) return true
    const window = Math.floor(nowMs / 60000)
    const record = windows.get(gem)
    if (!record || record.window !== window) {
      windows.set(gem, { window, count: 1 })
      return true
    }
    if (record.count >= perMinute) return false
    record.count += 1
    return true
  }

  function guard(gem, token, nowMs) {
    if (!Object.hasOwn(tokenSource(), gem)) throw new ProtocolError(CHANNEL_ERRORS.UNKNOWN_GEM, `未知宝石: ${gem}`)
    if (!authenticate(gem, token)) throw new ProtocolError(CHANNEL_ERRORS.UNAUTHORIZED, '宝石 token 无效')
    if (!allowRate(gem, nowMs)) throw new ProtocolError(CHANNEL_ERRORS.RATE_LIMITED, '宝石请求超限')
  }

  return {
    async ingest({ token, payload, nowMs = now() }) {
      const gem = payload?.gem
      if (typeof gem !== 'string' || gem === '') throw new ProtocolError(CHANNEL_ERRORS.UNKNOWN_GEM, '缺少 gem')
      guard(gem, token, nowMs)
      const event = normalizeIngest(payload)
      const result = await store.recordIngest({
        gem: event.gem,
        externalId: event.external_id,
        nowMs,
        event: {
          kind: event.kind,
          actor: event.from.id,
          source: event.gem,
          ts: event.ts ?? nowMs,
          payload: { text: event.text, from: event.from, meta: event.meta },
        },
      })
      const ring = result.accepted && (shouldWake === null || shouldWake(event))
      if (ring) onWake?.()
      return { accepted: result.accepted, event_id: result.eventId, wake: ring ? 'immediate' : 'none' }
    },

    async pullOutbox({ gem, token, limit = 20, nowMs = now() }) {
      guard(gem, token, nowMs)
      return store.claimOutbox({ gem, limit, nowMs })
    },

    async ack({ gem, token, id, body, nowMs = now() }) {
      guard(gem, token, nowMs)
      const ack = validateAck(body)
      const result = await store.ackOutbox({ id, ok: ack.ok, code: ack.code, externalId: ack.external_id, nowMs })
      if (ack.quota) await store.setState(`gemQuota.${gem}`, { ...ack.quota, reportedAt: nowMs })
      if (ack.ok) onGemSuccess?.(gem)
      else onGemFailure?.(gem, ack.code ?? 'unknown', nowMs)
      return { ok: true, id, retryable: result.retryable, duplicate: result.duplicate }
    },
  }
}

export function tokenFromHeaders(headers) {
  const raw = headers?.['x-living-token']
  if (Array.isArray(raw)) return raw[0] ?? ''
  return typeof raw === 'string' ? raw : ''
}
