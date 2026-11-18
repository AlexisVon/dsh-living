import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUDGET_DEFAULTS,
  createBudgetState,
  rollDay,
  check,
  startRound,
  consume,
} from '../lib/budget.mjs'

const TZ = 480
const MIN = 60000
const base = { tzOffsetMinutes: TZ }

function local(y, mo, d, h, mi = 0) {
  return Date.UTC(y, mo - 1, d, h, mi) - TZ * MIN
}

function cfg(overrides = {}) {
  return { ...base, ...overrides }
}

test('创建状态按本地日归档', () => {
  const now = local(2026, 11, 17, 10, 0)
  assert.deepEqual(createBudgetState(now, cfg()), { day: '2026-11-17', tokensUsed: 0, rounds: 0 })
})

test('跨本地日自动重置', () => {
  const before = local(2026, 11, 17, 23, 59)
  const after = local(2026, 11, 18, 0, 1)
  const consumed = consume(createBudgetState(before, cfg()), before, 1234, cfg())
  assert.equal(consumed.tokensUsed, 1234)
  const rolled = rollDay(consumed, after, cfg())
  assert.deepEqual(rolled, { day: '2026-11-18', tokensUsed: 0, rounds: 0 })
})

test('同日 rollDay 不改内容', () => {
  const now = local(2026, 11, 17, 10, 0)
  const state = { day: '2026-11-17', tokensUsed: 10, rounds: 2 }
  assert.deepEqual(rollDay(state, now + MIN, cfg()), state)
})

test('日 token 额度耗尽 → budget_exhausted', () => {
  const now = local(2026, 11, 17, 10, 0)
  const c = cfg({ dailyTokens: 100, dailyRounds: 10 })
  const state = consume(createBudgetState(now, c), now, 100, c)
  const r = check(state, now, c)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'budget_exhausted')
  assert.equal(r.which, 'tokens')
  assert.equal(r.tokensLeft, 0)
  assert.equal(r.state.tokensUsed, 100)
})

test('日轮数耗尽 → budget_exhausted', () => {
  const now = local(2026, 11, 17, 10, 0)
  const c = cfg({ dailyTokens: 1_000, dailyRounds: 2 })
  let state = createBudgetState(now, c)
  state = startRound(state, now, c)
  state = startRound(state, now, c)
  const r = check(state, now, c)
  assert.equal(r.ok, false)
  assert.equal(r.which, 'rounds')
  assert.equal(r.roundsLeft, 0)
})

test('额度余量随消耗递减；次日恢复', () => {
  const now = local(2026, 11, 17, 10, 0)
  const c = cfg({ dailyTokens: 1000, dailyRounds: 5 })
  const first = check(createBudgetState(now, c), now, c)
  assert.deepEqual([first.ok, first.tokensLeft, first.roundsLeft], [true, 1000, 5])

  const used = consume(createBudgetState(now, c), now, 250, c)
  const second = check(used, now, c)
  assert.deepEqual([second.tokensLeft, second.roundsLeft], [750, 5])

  const nextDay = local(2026, 11, 18, 9, 0)
  const reset = check(used, nextDay, c)
  assert.deepEqual([reset.tokensLeft, reset.roundsLeft], [1000, 5])
})

test('消耗非法值大声失败', () => {
  const now = local(2026, 11, 17, 10, 0)
  const state = createBudgetState(now, cfg())
  assert.throws(() => consume(state, now, -1, cfg()), RangeError)
  assert.throws(() => consume(state, now, Number.NaN, cfg()), RangeError)
})

test('输入状态不被修改', () => {
  const now = local(2026, 11, 17, 10, 0)
  const state = { day: '2026-11-17', tokensUsed: 10, rounds: 1 }
  consume(state, now, 5, cfg())
  startRound(state, now, cfg())
  rollDay(state, local(2026, 11, 18, 0, 1), cfg())
  assert.deepEqual(state, { day: '2026-11-17', tokensUsed: 10, rounds: 1 })
})

test('默认值与 WORKPLAN §5.1 一致', () => {
  assert.equal(BUDGET_DEFAULTS.dailyTokens, 2_000_000)
  assert.equal(BUDGET_DEFAULTS.roundTokens, 700_000)
  assert.equal(BUDGET_DEFAULTS.dailyRounds, 96)
})
