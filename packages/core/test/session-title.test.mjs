import { test } from 'node:test'
import assert from 'node:assert/strict'

import { livingSessionTitle } from '../lib/session-title.mjs'

const TZ = 480

test('标题：本地日期 + 中午前上午 / 午后下午', () => {
  assert.equal(livingSessionTitle(Date.UTC(2026, 10, 18, 2), { tzOffsetMinutes: TZ }), 'living-2026-11-18-上午')
  assert.equal(livingSessionTitle(Date.UTC(2026, 10, 18, 4, 59), { tzOffsetMinutes: TZ }), 'living-2026-11-18-上午')
  assert.equal(livingSessionTitle(Date.UTC(2026, 10, 18, 5), { tzOffsetMinutes: TZ }), 'living-2026-11-18-下午')
  assert.equal(livingSessionTitle(Date.UTC(2026, 10, 18, 6), { tzOffsetMinutes: TZ }), 'living-2026-11-18-下午')
})

test('标题：跨本地午夜使用新日期', () => {
  assert.equal(livingSessionTitle(Date.UTC(2026, 10, 18, 17), { tzOffsetMinutes: TZ }), 'living-2026-11-19-上午')
})
