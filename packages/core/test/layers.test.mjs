import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LAYERS,
  DEMOTE_STRENGTH,
  classifyLayer,
  halfLifeDays,
  decayedStrength,
  recencyScore,
  isDemotionCandidate,
  isProcedural,
  rehearsalScore,
} from '../lib/layers.mjs'

const DAY = 86400000
const NOW = Date.UTC(2026, 10, 17, 12)

test('分层判定：事件/话题/事实/程序/自传', () => {
  assert.equal(classifyLayer({ kind: 'event' }), 'L2')
  assert.equal(classifyLayer({ kind: 'topic' }), 'L2')
  assert.equal(classifyLayer({ kind: 'fact', text: '今天天气很好' }), 'L3')
  assert.equal(classifyLayer({ kind: 'fact', text: '必须带 token，报错时重试' }), 'L4')
  assert.equal(classifyLayer({ kind: 'self' }), 'L5')
  assert.equal(classifyLayer({ kind: 'person' }), 'L3')
})

test('程序记忆识别只看信号，不看语气', () => {
  assert.equal(isProcedural('经验：先登录再翻页'), true)
  assert.equal(isProcedural('这个函数返回布尔值'), false)
  assert.equal(isProcedural('注意 参数 端口 路径'), true)
})

test('半衰期：话题比事件短，程序最长，自传永久', () => {
  assert.equal(halfLifeDays({ kind: 'topic' }), 7)
  assert.equal(halfLifeDays({ kind: 'event' }), 21)
  assert.equal(halfLifeDays({ kind: 'fact', text: '普通事实' }), 180)
  assert.equal(halfLifeDays({ kind: 'fact', text: '必须带 token' }), 3650)
  assert.equal(LAYERS.L5.permanent, true)
})

test('惰性衰减：180 天剩 e^-1，复述越多衰减越慢', () => {
  const base = { kind: 'fact', text: '普通事实', strength0: 0.85, lastTs: NOW - 180 * DAY, rehearsal: 0 }
  const plain = decayedStrength(base, NOW)
  assert.ok(Math.abs(plain / 0.85 - Math.exp(-1)) < 1e-9)

  const rehearsed = decayedStrength({ ...base, rehearsal: 10 }, NOW)
  assert.ok(rehearsed > plain)

  const fresh = decayedStrength({ ...base, lastTs: NOW }, NOW)
  assert.ok(fresh > plain)
})

test('强度封顶 0.95', () => {
  const s = decayedStrength({ kind: 'event', strength0: 5, lastTs: NOW }, NOW)
  assert.equal(s, 0.95)
})

test('降维阈值：低于 0.15 才是候选，L5 永不降维', () => {
  const oldEvent = { kind: 'event', strength0: 0.85, lastTs: NOW - 1000 * DAY }
  assert.equal(isDemotionCandidate(oldEvent, NOW), true)
  assert.ok(decayedStrength(oldEvent, NOW) < DEMOTE_STRENGTH)
  assert.equal(isDemotionCandidate({ ...oldEvent, layer: 'L5' }, NOW), false)
})

test('近因分数随时间下降，复述分数封顶 1', () => {
  const item = { kind: 'event', ts: NOW - 7 * DAY }
  assert.ok(recencyScore(item, NOW) > 0 && recencyScore(item, NOW) < 1)
  assert.equal(rehearsalScore(0), 0)
  assert.equal(rehearsalScore(10), 1)
  assert.ok(rehearsalScore(3) > rehearsalScore(1))
})
