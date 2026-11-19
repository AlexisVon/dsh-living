import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTO_GRID_MINUTES,
  AUTO_NORMAL_SHARE,
  AUTO_SAMPLE_SECONDS,
  AUTO_SIGMA_RATIOS,
  CLOCK_DEFAULTS,
  addSchedule,
  autoWakeEstimate,
  completeSchedule,
  createClockState,
  dayKey,
  endSleep,
  nextDeadline,
  parseTimeOfDay,
  recoveryDue,
  scaledNow,
  tick,
} from '../lib/clock.mjs'

const TZ = 480
const MIN = 60000
const HOUR = 3600000
const DAY = 86400000

function local(y, mo, d, h, mi = 0) {
  return Date.UTC(y, mo - 1, d, h, mi) - TZ * MIN
}

function seq(...values) {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

function cfg(overrides = {}) {
  return { tzOffsetMinutes: TZ, ...overrides }
}

function auto(overrides = {}) {
  return cfg({
    autoWake: {
      gridMinutes: 10,
      sampleSeconds: 30,
      normalExpected: 0.1,
      lowExpected: 0.05,
      highExpected: 0.2,
      hotRanges: [[6, 8], [12, 14], [18, 24]],
      coldRanges: [[0, 6]],
      ...overrides,
    },
  })
}

function approx(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`)
}

test('自动唤醒：网格点数、期望和与 p∈[0,1]', () => {
  const now = local(2026, 11, 17, 10, 0)
  const { state, decision } = tick(createClockState(now), now, {}, auto(), () => 0)
  assert.equal(decision.action, 'wake')
  assert.equal(decision.trigger, 'auto')
  assert.equal(state.auto.className, 'normal')
  assert.equal(state.auto.gridIndex, 60)
  assert.equal(state.auto.points.length, 20)
  approx(state.auto.points.reduce((sum, p) => sum + p, 0), 0.1)
  assert.ok(state.auto.points.every((p) => p >= 0 && p <= 1))
  assert.equal(state.auto.mode, 'normal')
  assert.equal(state.auto.pointIndex, 0)
})

test('自动唤醒：未命中写 auto_miss，同一点不重复抽，下一点继续', () => {
  const now = local(2026, 11, 17, 10, 0)
  const first = tick(createClockState(now), now, {}, auto(), () => 0.999999)
  assert.equal(first.decision.reason, 'auto_miss')
  assert.equal(first.state.auto.pointIndex, 0)

  const same = tick(first.state, now + 10_000, {}, auto(), () => 0)
  assert.equal(same.decision.reason, 'auto_wait')

  const next = tick(same.state, now + 30_000, {}, auto(), () => 0)
  assert.equal(next.decision.trigger, 'auto')
  assert.equal(next.state.auto.pointIndex, 1)
})

test('自动唤醒：running 跨过的点作废，恢复时只抽当前点', () => {
  const now = local(2026, 11, 17, 10, 0)
  tick(createClockState(now), now, {}, auto(), () => 0.999999)
  // 模拟 2 分钟 running：期间没有 tick
  const resumed = tick(createClockState(now), now + 2 * MIN, {}, auto(), () => 0)
  assert.equal(resumed.decision.trigger, 'auto')
  assert.equal(resumed.decision.detail.pointIndex, 4)
  assert.equal(resumed.state.auto.pointIndex, 4)
})

test('网格分类：沾到热区即 hot，否则冷区 cold，hot 优先', () => {
  const cases = [
    [local(2026, 11, 17, 7, 0), 'high'],
    [local(2026, 11, 17, 3, 0), 'low'],
    [local(2026, 11, 17, 10, 0), 'normal'],
    [local(2026, 11, 17, 19, 0), 'high'],
    [local(2026, 11, 17, 6, 5), 'high'],
  ]
  for (const [now, expected] of cases) {
    const { state } = tick(createClockState(now), now, {}, auto(), () => 0.999999)
    assert.equal(state.auto.className, expected, new Date(now).toISOString())
  }
})

test('σ 过滤：期望超过所有 σ 上限时大声失败', () => {
  const now = local(2026, 11, 17, 10, 0)
  assert.throws(() => tick(createClockState(now), now, {}, auto({ normalExpected: 100 }), () => 0), /上限/)
  assert.throws(() => autoWakeEstimate(now, auto({ normalExpected: 100 })), /上限/)
})

test('σ 过滤：高期望只从可用的宽 σ 中抽', () => {
  const now = local(2026, 11, 17, 10, 0)
  const { state } = tick(createClockState(now), now, {}, auto({ normalExpected: 10 }), () => 0)
  assert.ok([1 / 4, 1 / 2].includes(state.auto.sigmaRatio))
})

test('40% 打乱顺序：mode=shuffled 时概率多重集不变', () => {
  const now = local(2026, 11, 17, 10, 0)
  const { state } = tick(createClockState(now), now, {}, auto(), seq(0, 0.9, 0.999999))
  assert.equal(state.auto.mode, 'shuffled')
  approx(state.auto.points.reduce((sum, p) => sum + p, 0), 0.1)
})

test('事件醒：不消耗自动网格，但当前自动点作废', () => {
  const now = local(2026, 11, 17, 10, 0)
  const first = tick(createClockState(now), now, { pendingEvents: 1 }, auto(), () => 0)
  assert.equal(first.decision.trigger, 'event')
  assert.equal(first.state.auto.pointIndex, 0)

  const next = tick(first.state, now + 30_000, {}, auto(), () => 0)
  assert.equal(next.decision.trigger, 'auto')
  assert.equal(next.decision.detail.pointIndex, 1)
})

test('日程到期：事件优先级高于自动，日程过后自动点作废', () => {
  const now = local(2026, 11, 17, 10, 0)
  const state = addSchedule(createClockState(now), { id: 's1', at: now - 10 * MIN, intent: '写日报' })
  const { decision, state: s } = tick(state, now, {}, auto(), () => 0.999999)
  assert.equal(decision.action, 'wake')
  assert.equal(decision.trigger, 'schedule')
  assert.equal(decision.detail.scheduleId, 's1')
  assert.equal(decision.detail.lateMinutes, 10)
  assert.equal(s.schedule[0].done, false)
  assert.equal(s.auto.pointIndex, 0)
})

test('日程过期超过 30 分钟 → 标 missed，不补做', () => {
  const now = local(2026, 11, 17, 10, 0)
  const state = addSchedule(createClockState(now), { id: 's1', at: now - 60 * MIN, intent: '写日报' })
  const { decision, state: s, missed } = tick(state, now, {}, auto(), () => 0.999999)
  assert.deepEqual(missed, ['s1'])
  assert.equal(s.schedule[0].missed, true)
  assert.equal(decision.action, 'sleep')
  assert.equal(state.schedule[0].missed, false, '输入状态不得被修改')
})

test('日程完成后不再触发', () => {
  const now = local(2026, 11, 17, 10, 0)
  const state = completeSchedule(
    addSchedule(createClockState(now), { id: 's1', at: now - MIN, intent: 'x' }),
    's1',
  )
  const { decision } = tick(state, now, {}, auto(), () => 0.999999)
  assert.notEqual(decision.trigger, 'schedule')
})

test('日程 id 重复或未知时大声失败', () => {
  const state = addSchedule(createClockState(0), { id: 's1', at: 1, intent: 'x' })
  assert.throws(() => addSchedule(state, { id: 's1', at: 2, intent: 'y' }), RangeError)
  assert.throws(() => addSchedule(state, { id: 's2', at: Number.NaN }), RangeError)
  assert.throws(() => completeSchedule(state, 'nope'), RangeError)
})

test('事件醒可打断睡眠', () => {
  const now = local(2026, 11, 17, 10, 0)
  const state = {
    ...createClockState(now),
    sleepingUntil: now + 10 * MIN,
    sleepKind: 'night',
  }
  const { decision, state: s } = tick(state, now, { pendingEvents: 1 }, auto(), () => 0.999999)
  assert.equal(decision.action, 'wake')
  assert.equal(decision.trigger, 'event')
  assert.equal(decision.detail.interruptedSleep, true)
  assert.equal(s.sleepingUntil, 0)
  assert.equal(s.sleepKind, null)
})

test('夜睡不可跳过，每天一次', () => {
  const now = local(2026, 11, 17, 3, 35)
  const { state, decision } = tick(createClockState(now), now, {}, auto(), () => 0.999999)
  assert.equal(decision.action, 'night')
  assert.equal(state.sleepKind, 'night')
  assert.equal(state.sleepingUntil, 0)

  const after = endSleep(state, now + 60 * MIN)
  const again = tick(after, now + 61 * MIN, {}, auto(), () => 0.999999)
  assert.notEqual(again.decision.action, 'night')
})

test('启动晚于夜睡窗口则不补跑', () => {
  const now = local(2026, 11, 17, 10, 0)
  const { state, decision } = tick(createClockState(now), now, {}, auto(), () => 0.999999)
  assert.notEqual(decision.action, 'night')
  assert.equal(state.nightDay, '2026-11-17')
})

test('13:00 不再是睡眠边界', () => {
  const now = local(2026, 11, 17, 12, 59)
  const { state, decision } = tick(createClockState(now), now, {}, auto(), () => 0.999999)
  assert.notEqual(decision.action, 'night')
  assert.notEqual(state.nextWakeAt, local(2026, 11, 17, 13, 0))
})

test('dayKey 按注入时区计算', () => {
  assert.equal(dayKey(Date.UTC(2026, 10, 17, 15, 59), TZ), '2026-11-17')
  assert.equal(dayKey(Date.UTC(2026, 10, 17, 16, 1), TZ), '2026-11-18')
})

test('nextWakeAt 经 JSON 往返后恢复；恢复最多补跑一次', () => {
  const now = local(2026, 11, 17, 10, 0)
  const at = now + 10 * MIN
  const state = addSchedule(createClockState(now), { id: 's1', at, intent: 'x' })
  const { state: s } = tick(state, now, {}, auto(), () => 0.999999)
  assert.equal(s.nextWakeAt, at)

  const restored = JSON.parse(JSON.stringify(s))
  assert.equal(restored.nextWakeAt, at)
  const d = recoveryDue(restored, at + 5 * MIN)
  assert.equal(d.trigger, 'recovery')
  assert.equal(d.detail.lateMinutes, 5)
  assert.equal(recoveryDue(restored, at - MIN), null)
})

test('nextDeadline 取所有硬截止的最小值', () => {
  const now = local(2026, 11, 17, 10, 0)
  const state = addSchedule(createClockState(now), { id: 's1', at: now + 5 * MIN, intent: 'x' })
  assert.equal(nextDeadline(state, now, auto()), now + 5 * MIN)
})

test('跨日重置自动网格', () => {
  const now = local(2026, 11, 17, 10, 0)
  const first = tick(createClockState(now), now, {}, auto(), () => 0.999999)
  const nextDay = local(2026, 11, 18, 10, 0)
  const second = tick(first.state, nextDay, {}, auto(), () => 0.999999)
  assert.equal(second.state.auto.day, '2026-11-18')
  assert.equal(second.state.auto.gridIndex, 60)
})

test('timeScale：仿射映射真实时间到仿真时间', () => {
  assert.equal(scaledNow(1_000_500, 1_000_000, 5_000_000, 1), 5_000_500)
  assert.equal(scaledNow(1_001_000, 1_000_000, 5_000_000, 60), 5_060_000)
  assert.equal(scaledNow(1_000_000, 1_000_000, 5_000_000, 60), 5_000_000)
  assert.throws(() => scaledNow(1, 0, 0, 0), RangeError)
})

test('自动唤醒估算：默认时段的格数与全天期望', () => {
  const now = local(2026, 11, 17, 10, 0)
  const estimate = autoWakeEstimate(now, auto())
  assert.equal(estimate.grids, 144)
  assert.deepEqual(estimate.counts, { normal: 48, low: 36, high: 60 })
  approx(estimate.eDay, 48 * 0.1 + 36 * 0.05 + 60 * 0.2)
  assert.ok(estimate.eMax > estimate.eDay)
})

test('非法自动唤醒配置大声失败', () => {
  const now = local(2026, 11, 17, 10, 0)
  assert.throws(() => tick(createClockState(now), now, {}, auto({ gridMinutes: 50 }), () => 0), /gridMinutes/)
  assert.throws(() => tick(createClockState(now), now, {}, auto({ sampleSeconds: 15 }), () => 0), /sampleSeconds/)
  assert.throws(() => tick(createClockState(now), now, {}, auto({ hotRanges: [[8, 6]] }), () => 0), /区间/)
  assert.throws(() => tick(createClockState(now), now, {}, auto({ normalExpected: -1 }), () => 0), /normalExpected/)
})

test('默认参数与自动唤醒预设一致', () => {
  assert.deepEqual(AUTO_GRID_MINUTES, [10, 20, 30, 40, 60])
  assert.deepEqual(AUTO_SAMPLE_SECONDS, [30, 60])
  assert.equal(AUTO_SIGMA_RATIOS.length, 5)
  assert.equal(AUTO_NORMAL_SHARE, 0.6)
  assert.equal(CLOCK_DEFAULTS.autoWake.gridMinutes, 10)
  assert.equal(CLOCK_DEFAULTS.autoWake.sampleSeconds, 30)
  assert.equal(CLOCK_DEFAULTS.autoWake.normalExpected, 0.1)
  assert.equal(CLOCK_DEFAULTS.nightAtMinutes, 3 * 60 + 30)
})

test('parseTimeOfDay：HH:MM 解析与大声失败', () => {
  assert.equal(parseTimeOfDay('03:30'), 210)
  assert.equal(parseTimeOfDay('00:00'), 0)
  assert.equal(parseTimeOfDay('23:59'), 1439)
  assert.throws(() => parseTimeOfDay('24:00'), RangeError)
  assert.throws(() => parseTimeOfDay('3:30'), RangeError)
  assert.throws(() => parseTimeOfDay('abc'), RangeError)
})
