/** Machine-facing routes only: ingest, outbox pull, ack. Admin data goes over Connection RPC. */

import { ProtocolError } from 'dsh-living-protocol'
import { tokenFromHeaders } from './channel.mjs'

const MAX_BODY = 1_000_000

export function createHttpHandler({ runtime, store }) {
  if (!runtime) throw new RangeError('http handler 需要 runtime')
  if (!store) throw new RangeError('http handler 需要 store')

  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'POST' && path === '/living/ingest') {
        const body = await readJson(req)
        const result = await runtime.channel.ingest({ token: tokenFromHeaders(req.headers), payload: body, nowMs: Date.now() })
        return json(res, 200, result)
      }

      if (req.method === 'GET' && path === '/living/outbox') {
        const gem = url.searchParams.get('gem') ?? ''
        const limit = Number(url.searchParams.get('limit') ?? 20)
        const items = await runtime.channel.pullOutbox({
          gem,
          token: tokenFromHeaders(req.headers),
          limit,
          nowMs: Date.now(),
        })
        return json(res, 200, items)
      }

      const ack = path.match(/^\/living\/outbox\/([^/]+)\/ack$/)
      if (req.method === 'POST' && ack) {
        const id = decodeURIComponent(ack[1])
        const item = store.getOutbox(id)
        if (!item) return json(res, 404, { error: 'not_found', message: `未知 outbox id: ${id}` })
        const body = await readJson(req)
        const result = await runtime.channel.ack({
          gem: item.gem,
          token: tokenFromHeaders(req.headers),
          id,
          body,
          nowMs: Date.now(),
        })
        return json(res, 200, result)
      }

      return json(res, 404, { error: 'not_found', message: `未知路由: ${req.method} ${path}` })
    } catch (error) {
      if (error instanceof ProtocolError) {
        const status = error.code === 'unauthorized' ? 401 : error.code === 'rate_limited' ? 429 : 400
        return json(res, status, { error: error.code, message: error.message, details: error.details })
      }
      return json(res, 500, { error: 'internal', message: error.message })
    }
  }
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new ProtocolError('payload_too_large', '请求体超过 1MB')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ProtocolError('invalid_json', '请求体不是合法 JSON')
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}
