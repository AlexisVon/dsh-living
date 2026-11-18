import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCoreClient, isCoreUnreachable } from '../lib/channel.mjs'

test('core 客户端：ingest / outbox / ack 的路径与 token', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify({ accepted: true }), { status: 200 })
  }
  const core = createCoreClient({ baseUrl: 'http://127.0.0.1:3000/', gem: 'wechat', token: 't', fetchImpl })

  await core.ingest({ gem: 'wechat', kind: 'message', external_id: 'e1', from: { id: '1' }, text: 'hi', ts: 1 })
  await core.pullOutbox(5)
  await core.ack('out_1', { ok: true, external_id: 'x' })

  assert.equal(calls[0].url, 'http://127.0.0.1:3000/living/ingest')
  assert.equal(calls[0].options.headers['x-living-token'], 't')
  assert.equal(calls[1].url, 'http://127.0.0.1:3000/living/outbox?gem=wechat&limit=5')
  assert.equal(calls[2].url, 'http://127.0.0.1:3000/living/outbox/out_1/ack')
})

test('只有连接层错误才算核心不可达', () => {
  assert.equal(isCoreUnreachable(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })), true)
  assert.equal(isCoreUnreachable(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), true)
  assert.equal(isCoreUnreachable(new Error('core 401')), false)
  assert.equal(isCoreUnreachable(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })), false)
})
