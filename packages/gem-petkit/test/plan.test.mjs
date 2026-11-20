import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findMeal, formatClock, mealActionIssue, parseClock, summarizeMeal, waitForMealStatus } from '../lib/plan.mjs'

function records(items) {
  return { feed: [{ items }] }
}

test('plan：HH:MM 解析与格式化', () => {
  assert.equal(parseClock('12:00'), 43200)
  assert.equal(parseClock('7:05'), 25500)
  assert.equal(parseClock('23:59'), 86340)
  assert.equal(formatClock(43200), '12:00')
  assert.equal(formatClock(0), '00:00')
  assert.throws(() => parseClock('24:00'), /HH:MM/)
  assert.throws(() => parseClock('12:60'), /HH:MM/)
  assert.throws(() => parseClock('1200'), /HH:MM/)
  assert.throws(() => parseClock(''), /HH:MM/)
})

test('plan：只匹配计划餐，不碰手动记录', () => {
  const data = records([
    { id: 's43200', time: 43200, name: '午餐', amount: 40, src: 1, status: 0 },
    { id: 'r35255-1', time: 35255, amount: 20, src: 3, status: 0, state: { realAmount: 20 } },
  ])
  assert.equal(findMeal(data, 43200).id, 's43200')
  assert.equal(findMeal(data, 35255), null)
  const fallback = records([{ time: 61200, name: '晚餐', amount: 30, src: 1, status: 0 }])
  assert.equal(findMeal(fallback, 61200).name, '晚餐')
  assert.match(summarizeMeal(findMeal(data, 43200)), /12:00 午餐 40g.*s43200/)
})

test('plan：停/恢复的边界只由计划状态和时间决定', () => {
  assert.equal(mealActionIssue({ item: { status: 1 }, feedTime: 43200, nowSeconds: 100, action: 'skip' }), 'already_skipped')
  assert.equal(mealActionIssue({ item: { status: 0, state: { realAmount: 40 } }, feedTime: 43200, nowSeconds: 100, action: 'skip' }), 'already_executed')
  assert.equal(mealActionIssue({ item: { status: 0 }, feedTime: 100, nowSeconds: 100, action: 'skip' }), 'time_passed')
  assert.equal(mealActionIssue({ item: { status: 0 }, feedTime: 43200, nowSeconds: 100, action: 'skip' }), null)
  assert.equal(mealActionIssue({ item: { status: 0 }, feedTime: 43200, nowSeconds: 100, action: 'restore' }), 'not_skipped')
  assert.equal(mealActionIssue({ item: { status: 1 }, feedTime: 43200, nowSeconds: 100, action: 'restore' }), null)
  assert.equal(mealActionIssue({ item: { status: 1 }, feedTime: 100, nowSeconds: 100, action: 'restore' }), 'time_passed')
})

test('plan：等待记录反射状态，超时返回未确认', async () => {
  let clock = 0
  let polls = 0
  const sleep = async (ms) => { clock += ms }
  const flaky = async () => {
    polls += 1
    return records([{ id: 's43200', time: 43200, amount: 40, src: 1, status: polls === 1 ? 0 : 1 }])
  }
  const verified = await waitForMealStatus({
    fetchRecords: flaky,
    feedTime: 43200,
    expectStatus: 1,
    timeoutMs: 4000,
    intervalMs: 1000,
    sleep,
    now: () => clock,
  })
  assert.equal(verified.verified, true)
  assert.equal(verified.item.status, 1)

  clock = 0
  const stuck = await waitForMealStatus({
    fetchRecords: async () => records([{ id: 's43200', time: 43200, amount: 40, src: 1, status: 0 }]),
    feedTime: 43200,
    expectStatus: 1,
    timeoutMs: 2000,
    intervalMs: 1000,
    sleep,
    now: () => clock,
  })
  assert.equal(stuck.verified, false)
  assert.equal(stuck.item.status, 0)
})
