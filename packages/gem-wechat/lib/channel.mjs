import { ENDPOINTS, FAILURE_CODES } from 'dsh-living-protocol'
import { IlinkError, isMessageLimit, isSessionTimeout, isWindowClosed } from './ilink.mjs'
import { MediaError } from './media.mjs'

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
  if (isSessionTimeout(error)) return FAILURE_CODES.GEM_COOKIE_EXPIRED
  if (isMessageLimit(error)) return FAILURE_CODES.PROVIDER_RATE
  if (isWindowClosed(error)) return FAILURE_CODES.WINDOW_CLOSED
  if (error instanceof MediaError) {
    if (error.kind === 'config') return FAILURE_CODES.CONFIG_INVALID
    if (error.kind === 'rate') return FAILURE_CODES.PROVIDER_RATE
    if (error.kind === 'network') return FAILURE_CODES.PROVIDER_TIMEOUT
    return FAILURE_CODES.UNKNOWN
  }
  if (error instanceof IlinkError) return error.ret === -1 || error.errcode === -1 ? FAILURE_CODES.CONFIG_INVALID : FAILURE_CODES.UNKNOWN
  if (error instanceof CoreError) return FAILURE_CODES.UNKNOWN
  if (error?.name === 'TimeoutError' || /fetch failed|network|terminated/i.test(String(error?.message ?? ''))) {
    return FAILURE_CODES.PROVIDER_TIMEOUT
  }
  return FAILURE_CODES.UNKNOWN
}
