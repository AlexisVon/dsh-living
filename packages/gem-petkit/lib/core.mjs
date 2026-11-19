import { ENDPOINTS } from 'dsh-living-protocol'

export function createCoreClient({ baseUrl, gem, token, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!baseUrl) throw new RangeError('core baseUrl 必填')
  if (!gem) throw new RangeError('core gem 必填')
  if (!token) throw new RangeError('core token 必填')
  const base = baseUrl.replace(/\/$/, '')

  return {
    async ingest(payload) {
      const response = await fetchImpl(`${base}${ENDPOINTS.ingest}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-living-token': token },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`core ${response.status}: ${text.slice(0, 200)}`)
      return text ? JSON.parse(text) : null
    },
  }
}
