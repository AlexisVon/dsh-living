import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findMeal, formatClock, formatPlan, mealActionIssue, parseClock, summarizeMeal, waitForMealStatus } from '../lib/plan.mjs'

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

test('plan：OEM 周日=1 转 ISO 标签并按周一到周日排序', () => {
  const items = (amount) => [
    { time: 79200, amount, name: '夜宵' },
    { time: 25200, amount, name: '早餐' },
  ]
  const days = [1, 2, 3, 4, 5, 6, 7].map((repeats) => ({
    repeats,
    suspended: 0,
    items: items(repeats === 1 || repeats === 7 ? 20 : 30),
  }))
  const text = formatPlan({ feedDailyList: days })
  assert.match(text, /周六、日：07:00 20g 早餐 \/ 22:00 20g 夜宵/)
  assert.match(text, /周一、二、三、四、五：07:00 30g 早餐 \/ 22:00 30g 夜宵/)
})

test('plan：七天同组显示每天，暂停保留', () => {
  const text = formatPlan({
    feedDailyList: [1, 2, 3, 4, 5, 6, 7].map((repeats) => ({ repeats, suspended: 1, items: [{ time: 3600, amount: 30 }] })),
  })
  assert.match(text, /每天（已暂停）：01:00 30g/)
})
