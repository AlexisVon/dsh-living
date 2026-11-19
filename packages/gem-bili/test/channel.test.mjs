import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCoreClient, dmEvent, isCoreUnreachable, resolveOutboundTarget } from '../lib/channel.mjs'

test('core 客户端：ingest / outbox / ack 的路径与 token', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify({ accepted: true }), { status: 200 })
  }
  const core = createCoreClient({ baseUrl: 'http://127.0.0.1:3000/', gem: 'bili', token: 't', fetchImpl })

  await core.ingest({ gem: 'bili', kind: 'message', external_id: 'e1', from: { id: '1' }, text: 'hi', ts: 1 })
  await core.pullOutbox(5)
  await core.ack('out_1', { ok: true, external_id: 'x' })

  assert.equal(calls[0].url, 'http://127.0.0.1:3000/living/ingest')
  assert.equal(calls[0].options.headers['x-living-token'], 't')
  assert.equal(JSON.parse(calls[0].options.body).external_id, 'e1')
  assert.equal(calls[1].url, 'http://127.0.0.1:3000/living/outbox?gem=bili&limit=5')
  assert.equal(calls[2].url, 'http://127.0.0.1:3000/living/outbox/out_1/ack')
})

test('core 非 2xx 大声失败', async () => {
  const fetchImpl = async () => new Response('{"error":"unauthorized"}', { status: 401 })
  const core = createCoreClient({ baseUrl: 'http://x', gem: 'bili', token: 'bad', fetchImpl })
  await assert.rejects(() => core.pullOutbox(), /401/)
})

test('只有连接层错误才算核心不可达', () => {
  assert.equal(isCoreUnreachable(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })), true)
  assert.equal(isCoreUnreachable(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), true)
  assert.equal(isCoreUnreachable(new Error('core 401')), false)
  assert.equal(isCoreUnreachable(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })), false)
})

test('B站私信：主人回复目标用 me，外部保留 uid', () => {
  const message = { key: 'k1', text: 'hi', ts: 1 }
  const owner = dmEvent({ uid: '345', message, ownerUid: '345' })
  assert.equal(owner.meta.reply_to, 'me')
  assert.equal(owner.meta.trusted, true)

  const stranger = dmEvent({ uid: '999', message, ownerUid: '345' })
  assert.equal(stranger.meta.reply_to, 'uid:999')
  assert.equal(stranger.meta.trusted, false)
})

test('me 外发目标按 ownerUid 解析', () => {
  assert.equal(resolveOutboundTarget('me', '345'), 'uid:345')
  assert.equal(resolveOutboundTarget('me', ''), 'me')
  assert.equal(resolveOutboundTarget('uid:999', '345'), 'uid:999')
})
