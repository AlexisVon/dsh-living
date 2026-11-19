import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { buildTimeline } from '../lib/timeline.mjs'

const NOW = Date.UTC(2026, 10, 18, 8)

function open(t) {
  const home = mkdtempSync(join(tmpdir(), 'living-timeline-'))
  const store = createStore({ path: join(home, 'life.db'), now: () => NOW })
  t.after(async () => {
    await store.close()
    rmSync(home, { recursive: true, force: true })
  })
  return store
}

test('timeline：轮次、网格、消息、自写节点、raw 合并并按时间排序', async (t) => {
  const store = open(t)
  await store.appendAnchor({ roundId: 'r1', startedAt: NOW - 3000, trigger: 'auto', outcome: 'ok' })
  await store.appendEvent({ id: 'ev1', ts: NOW - 2000, kind: 'message', source: 'wechat', payload: { text: '在吗' } })
  await store.appendEvent({ id: 'ev2', ts: NOW - 1000, kind: 'auto_grid', payload: { window: '16:00-16:10', className: 'normal', lambda: 0.1 } })
  await store.appendEvent({ id: 'ev3', ts: NOW, kind: 'agent_mark', payload: { text: '决定去查 B站', tag: 'decision' } })
  await store.appendRawSegment({ id: 'raw1', sessionId: 's1', kind: 'rest', tsStart: NOW - 5000, tsEnd: NOW - 4000, payload: { messages: [] }, createdAt: NOW - 4000 })

  const items = buildTimeline({ store, limit: 20 })
  assert.deepEqual(items.map((item) => item.kind), ['raw', 'round', 'message', 'auto_grid', 'agent_mark'])
  assert.equal(items.find((item) => item.kind === 'agent_mark').category, 'agent')
  assert.equal(items.find((item) => item.kind === 'auto_grid').category, 'grid')
  assert.equal(items.find((item) => item.kind === 'message').category, 'message')
})

test('timeline：外发 pending/review 也进时间轴', async (t) => {
  const store = open(t)
  const id = await store.enqueueOutbox({ gem: 'bili', to: 'uid:1', text: '回复', createdAt: NOW })
  await store.deferOutbox(id, Number.MAX_SAFE_INTEGER, 'needs approval')
  const items = buildTimeline({ store, limit: 20 })
  const outbound = items.find((item) => item.kind === 'outbox')
  assert.equal(outbound.category, 'outbound')
  assert.equal(outbound.detail.id, id)
})

test('timeline：睡眠事件进入 sleep 类别并带时长', async (t) => {
  const store = open(t)
  await store.appendEvent({ id: 'sl1', ts: NOW, kind: 'sleep', source: 'living', payload: { trigger: 'night', durationMs: 17 * 60000, ok: true } })
  const items = buildTimeline({ store, limit: 10 })
  const row = items.find((item) => item.id === 'event:sl1')
  assert.equal(row.category, 'sleep')
  assert.match(row.title, /17 分钟/)
})
