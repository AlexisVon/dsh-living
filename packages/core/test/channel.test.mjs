import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { createChannel, tokenFromHeaders } from '../lib/channel.mjs'
import { ProtocolError } from 'dsh-living-protocol'

const T0 = 1_700_000_000_000
const MIN = 60000

async function setup(t, { perMinute = 10, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'living-channel-'))
  const store = createStore({ path: join(dir, 'life.db') })
  t.after(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const channel = createChannel({
    store,
    tokens: { bili: 't-bili', wechat: 't-wechat' },
    limits: { bili: { perMinute }, wechat: { perMinute: 100 } },
    ...options,
  })
  return { store, channel }
}

function payload(overrides = {}) {
  return {
    gem: 'bili',
    kind: 'message',
    external_id: 'dm_1',
    from: { id: 'uid_9', name: '小明' },
    text: '在吗',
    ts: T0,
    ...overrides,
  }
}

test('ingest：合法入站落库，重复 external_id 只处理一次', async (t) => {
  const { store, channel } = await setup(t)
  const first = await channel.ingest({ token: 't-bili', payload: payload(), nowMs: T0 })
  assert.equal(first.accepted, true)
  assert.equal(first.wake, 'immediate')
  assert.equal(store.listEvents({ limit: 10 }).length, 1)

  const second = await channel.ingest({ token: 't-bili', payload: payload(), nowMs: T0 + 1 })
  assert.equal(second.accepted, false)
  assert.equal(second.wake, 'none')
  assert.equal(store.listEvents({ limit: 10 }).length, 1)
})

test('ingest：silent 只落库不唤醒，ring 立即唤醒', async (t) => {
  let woke = 0
  const { store, channel } = await setup(t, {
    shouldWake: (event) => event.gem !== 'wechat',
    onWake: () => {
      woke += 1
    },
  })

  const silent = await channel.ingest({
    token: 't-wechat',
    payload: payload({ gem: 'wechat', external_id: 'wx_1' }),
    nowMs: T0,
  })
  assert.equal(silent.accepted, true)
  assert.equal(silent.wake, 'none')
  assert.equal(woke, 0)
  assert.equal(store.listEvents({ limit: 10 }).length, 1, 'silent 仍然落库')

  const ring = await channel.ingest({ token: 't-bili', payload: payload({ external_id: 'dm_2' }), nowMs: T0 })
  assert.equal(ring.wake, 'immediate')
  assert.equal(woke, 1)
})

test('ingest：重复事件不重复唤醒', async (t) => {
  let woke = 0
  const { channel } = await setup(t, { onWake: () => { woke += 1 } })
  await channel.ingest({ token: 't-bili', payload: payload(), nowMs: T0 })
  const duplicate = await channel.ingest({ token: 't-bili', payload: payload(), nowMs: T0 + 1 })
  assert.equal(duplicate.accepted, false)
  assert.equal(duplicate.wake, 'none')
  assert.equal(woke, 1)
})

test('ingest：token 错误 / 未知宝石 / 非法载荷都大声失败', async (t) => {
  const { channel } = await setup(t)
  await assert.rejects(
    () => channel.ingest({ token: 'bad', payload: payload(), nowMs: T0 }),
    (error) => error instanceof ProtocolError && error.code === 'unauthorized',
  )
  await assert.rejects(
    () => channel.ingest({ token: 't-bili', payload: payload({ gem: 'nope' }), nowMs: T0 }),
    (error) => error.code === 'unknown_gem',
  )
  await assert.rejects(
    () => channel.ingest({ token: 't-bili', payload: { gem: 'bili' }, nowMs: T0 }),
    (error) => error.code === 'ingest_invalid',
  )
})

test('每宝石每分钟限流，跨窗口恢复', async (t) => {
  const { channel } = await setup(t, { perMinute: 2 })
  await channel.ingest({ token: 't-bili', payload: payload({ external_id: 'a' }), nowMs: T0 })
  await channel.ingest({ token: 't-bili', payload: payload({ external_id: 'b' }), nowMs: T0 })
  await assert.rejects(
    () => channel.ingest({ token: 't-bili', payload: payload({ external_id: 'c' }), nowMs: T0 + 1 }),
    (error) => error.code === 'rate_limited',
  )
  const later = await channel.ingest({ token: 't-bili', payload: payload({ external_id: 'd' }), nowMs: T0 + MIN })
  assert.equal(later.accepted, true)
})

test('outbox：pull → ack 全链；失败回执决定是否重投', async (t) => {
  const { store, channel } = await setup(t)
  const id = await store.enqueueOutbox({ gem: 'bili', to: 'uid_9', text: '在', createdAt: T0 })
  const items = await channel.pullOutbox({ gem: 'bili', token: 't-bili', limit: 10, nowMs: T0 })
  assert.equal(items.length, 1)
  assert.equal(items[0].id, id)

  const ack = await channel.ack({ gem: 'bili', token: 't-bili', id, body: { ok: true, external_id: 'dm_999' }, nowMs: T0 })
  assert.equal(ack.ok, true)
  assert.equal((await channel.pullOutbox({ gem: 'bili', token: 't-bili', nowMs: T0 + 6 * MIN })).length, 0)

  await store.enqueueOutbox({ id: 'out_2', gem: 'bili', to: 'u', text: 'x', createdAt: T0 })
  const [item] = await channel.pullOutbox({ gem: 'bili', token: 't-bili', nowMs: T0 + 6 * MIN })
  const retry = await channel.ack({
    gem: 'bili',
    token: 't-bili',
    id: item.id,
    body: { ok: false, code: 'provider_timeout' },
    nowMs: T0 + 6 * MIN,
  })
  assert.equal(retry.retryable, true)
  const [failure] = store.listEvents({ kind: 'change', limit: 5 })
  assert.match(failure.payload.text, /外发失败 bili/)
  assert.equal(failure.payload.meta.retryable, true)
})

test('ack：非法回执按协议拒绝', async (t) => {
  const { store, channel } = await setup(t)
  await store.enqueueOutbox({ id: 'out_1', gem: 'bili', to: 'u', text: 'x', createdAt: T0 })
  await assert.rejects(
    () => channel.ack({ gem: 'bili', token: 't-bili', id: 'out_1', body: {}, nowMs: T0 }),
    (error) => error.code === 'ack_invalid',
  )
})

test('token 从请求头读取', () => {
  assert.equal(tokenFromHeaders({ 'x-living-token': 'abc' }), 'abc')
  assert.equal(tokenFromHeaders({ 'x-living-token': ['a', 'b'] }), 'a')
  assert.equal(tokenFromHeaders({}), '')
})
