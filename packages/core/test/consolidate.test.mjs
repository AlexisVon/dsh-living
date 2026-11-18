import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clusterEpisodes, selectDemotions, pickKeywords, mergeFacts, buildColdClues } from '../lib/consolidate.mjs'

const DAY = 86400000
const NOW = Date.UTC(2026, 10, 17, 12)

test('rest：按时间间隙聚类成情节', () => {
  const events = [
    { id: 'e1', ts: 0, payload: { text: '早上看了显卡' } },
    { id: 'e2', ts: 60 * 60000, payload: { text: '中午换了风扇' } },
    { id: 'e3', ts: 4 * 3600000, payload: { text: '下午出门' } },
  ]
  const episodes = clusterEpisodes(events, { maxGapMinutes: 120 })
  assert.equal(episodes.length, 2)
  assert.deepEqual(episodes[0].eventIds, ['e1', 'e2'])
  assert.equal(episodes[0].title, '早上看了显卡')
  assert.ok(episodes[0].summary.includes('换了风扇'))
  assert.deepEqual(episodes[1].eventIds, ['e3'])
})

test('夜睡：只把低于阈值的记忆降维', () => {
  const old = {
    id: 'old',
    kind: 'event',
    text: '显卡散热坏了',
    lastTs: NOW - 1000 * DAY,
    eventRefs: ['e1', 'e2', 'e3', 'e4'],
    importance: 0.4,
  }
  const fresh = { ...old, id: 'fresh', lastTs: NOW }
  const rows = selectDemotions([old, fresh], { now: NOW })
  assert.ok(rows.length >= 1 && rows.length <= 3)
  for (const row of rows) {
    assert.equal(row.fidelity, 'low')
    assert.ok(row.eventIds.length <= 3)
    assert.ok(row.keyword.length >= 2)
  }
})

test('降维关键词来自原文，过滤停用词', () => {
  const words = pickKeywords('这个 那个 显卡散热坏了 必须换风扇', 5)
  assert.ok(words.includes('显卡'))
  assert.ok(!words.includes('这个'))
  assert.ok(words.length <= 5)
})

test('事实合并：同三元组只更新 last_seen 与事件，不重复', () => {
  const existing = [
    { id: 'f1', subject: '小明', predicate: '喜欢', object: '看展', confidence: 0.5, lastSeen: 1, eventIds: ['e1'] },
  ]
  const incoming = [
    { subject: '小明', predicate: '喜欢', object: '看展', confidence: 0.9, lastSeen: 5, eventIds: ['e2'] },
    { subject: '小明', predicate: '喜欢', object: '爬山', confidence: 0.7, lastSeen: 6, eventIds: ['e3'] },
  ]
  const { facts, added, updated } = mergeFacts(existing, incoming)
  assert.equal(added, 1)
  assert.equal(updated, 1)
  const liked = facts.find((f) => f.object === '看展')
  assert.equal(liked.id, 'f1')
  assert.equal(liked.lastSeen, 5)
  assert.equal(liked.confidence, 0.9)
  assert.deepEqual(liked.eventIds, ['e1', 'e2'])
  assert.ok(facts.find((f) => f.object === '爬山').id.startsWith('fact_'))
})

test('冷线索最多注入 8 条', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ keyword: `k${i}`, lastTs: NOW, label20: `线索${i}` }))
  const text = buildColdClues(rows, 8)
  assert.equal(text.split('\n').length, 8)
})
