import { test } from 'node:test'
import assert from 'node:assert/strict'

import { allocateLivingSessionTitle, livingSessionTitle } from '../lib/session-title.mjs'

const TZ = 480

test('标题：本地日期 + 日序号', () => {
  assert.equal(livingSessionTitle(Date.UTC(2026, 10, 18, 2), { tzOffsetMinutes: TZ, seq: 1 }), 'living-2026-11-18-1')
  assert.equal(livingSessionTitle(Date.UTC(2026, 10, 18, 6), { tzOffsetMinutes: TZ, seq: 2 }), 'living-2026-11-18-2')
})

test('标题：跨本地午夜使用新日期', () => {
  assert.equal(livingSessionTitle(Date.UTC(2026, 10, 18, 17), { tzOffsetMinutes: TZ, seq: 1 }), 'living-2026-11-19-1')
})

test('分配：同日递增，跨日重置', () => {
  const first = allocateLivingSessionTitle(Date.UTC(2026, 10, 18, 2), { tzOffsetMinutes: TZ })
  assert.deepEqual(first, { title: 'living-2026-11-18-1', state: { day: '2026-11-18', seq: 1 } })

  const second = allocateLivingSessionTitle(Date.UTC(2026, 10, 18, 3), {
    tzOffsetMinutes: TZ,
    previous: first.state,
  })
  assert.deepEqual(second, { title: 'living-2026-11-18-2', state: { day: '2026-11-18', seq: 2 } })

  const nextDay = allocateLivingSessionTitle(Date.UTC(2026, 10, 18, 17), {
    tzOffsetMinutes: TZ,
    previous: second.state,
  })
  assert.deepEqual(nextDay, { title: 'living-2026-11-19-1', state: { day: '2026-11-19', seq: 1 } })
})

test('分配：损坏的计数状态回到 1', () => {
  const at = Date.UTC(2026, 10, 18, 2)
  assert.equal(allocateLivingSessionTitle(at, { tzOffsetMinutes: TZ, previous: { day: '2026-11-18', seq: 0 } }).title, 'living-2026-11-18-1')
  assert.equal(allocateLivingSessionTitle(at, { tzOffsetMinutes: TZ, previous: { day: '2026-11-18', seq: 'x' } }).title, 'living-2026-11-18-1')
})
