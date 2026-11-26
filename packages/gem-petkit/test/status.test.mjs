import { test } from 'node:test'
import assert from 'node:assert/strict'

import { foodStatus } from '../lib/status.mjs'

test('foodStatus：D4H 粮仓有/无 + 碗里百分比', () => {
  assert.equal(foodStatus({ food: 2, bowl: 0 }), '粮仓 有粮（food=2）；碗里 0%')
  assert.equal(foodStatus({ food: 0, bowl: 48 }), '粮仓 空（food=0）；碗里 48%')
  assert.equal(foodStatus({ food: 1 }), '粮仓 低（food=1）')
  assert.equal(foodStatus({}), '粮仓 未知（food=?）')
})

test('foodStatus：percent/weight 只在机型上报时出现并夹紧', () => {
  const text = foodStatus({ food: 2, percent: 35, bowl: 67.4, weight: 12.6 })
  assert.equal(text, '粮仓 有粮（food=2）；粮仓余量 35%；碗里 67%；碗重 13g')
  assert.match(foodStatus({ food: 2, bowl: 150 }), /碗里 100%/)
})
