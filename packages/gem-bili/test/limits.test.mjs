import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProactiveLimit } from '../lib/limits.mjs'

test('主动额度按本地日重置，事件回复不占额度', () => {
  let saved = 0
  const state = {}
  const config = { proactiveDaily: 2 }
  let now = new Date(2026, 10, 18, 23, 0).getTime()
  const limiter = createProactiveLimit({ state, config, save: () => { saved += 1 }, now: () => now })
  const proactive = { origin: 'proactive' }
  const event = { origin: 'event' }

  assert.equal(limiter.atLimit(proactive), false)
  limiter.noteSent(proactive)
  limiter.noteSent(event)
  assert.equal(limiter.snapshot().proactiveSent, 1)
  limiter.noteSent(proactive)
  assert.equal(limiter.atLimit(proactive), true)
  assert.equal(limiter.atLimit(event), false)

  now = new Date(2026, 10, 19, 0, 1).getTime()
  assert.equal(limiter.atLimit(proactive), false)
  assert.equal(limiter.snapshot().proactiveSent, 0)
  assert.ok(saved > 0)
})

test('proactiveDaily=0 表示不限', () => {
  const state = {}
  const limiter = createProactiveLimit({ state, config: { proactiveDaily: 0 } })
  for (let i = 0; i < 100; i += 1) limiter.noteSent({ origin: 'proactive' })
  assert.equal(limiter.atLimit({ origin: 'proactive' }), false)
})
