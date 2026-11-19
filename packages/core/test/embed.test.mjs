import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMBED_DEFAULTS,
  cosine,
  decodeVector,
  encodeVector,
  normalizeEmbedConfig,
  normalizeEmbedUrl,
  queryText,
} from '../lib/embed.mjs'
import { buildEmbedSegments, buildLexicalSegments, meanSd } from '../lib/segments.mjs'

const HOUR = 3600000
const DAY = 86400000
const NOW = Date.UTC(2026, 10, 19, 8)

test('embed 配置：默认 loopback、兜底 3 天、区段 7 天，非法值大声失败', () => {
  const config = normalizeEmbedConfig({})
  assert.equal(config.url, EMBED_DEFAULTS.url)
  assert.equal(config.url, 'http://127.0.0.1:11434')
  assert.equal(config.model, '')
  assert.equal(config.fallbackDays, 3)
  assert.equal(config.minConfidence, 0.35)
  assert.equal(config.maxSegmentDays, 7)
  assert.throws(() => normalizeEmbedConfig({ fallbackDays: 0 }), /fallbackDays/)
  assert.throws(() => normalizeEmbedConfig({ minConfidence: 2 }), /minConfidence/)
  assert.throws(() => normalizeEmbedConfig({ maxSegmentDays: 31 }), /maxSegmentDays/)
  assert.throws(() => normalizeEmbedUrl('ftp://host'), /http/)
  assert.throws(() => normalizeEmbedUrl('http://user:pass@host'), /账号密码/)
})

test('向量：编码往返与余弦', () => {
  const vector = encodeVector([1, 0, 0])
  assert.deepEqual([...decodeVector(vector)], [1, 0, 0])
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [2, 0]), 1)
  assert.ok(queryText('显卡').includes('显卡'))
  assert.ok(queryText('显卡').startsWith('Instruct:'))
})

test('区段：低置信度丢弃，高置信度成段且宽度受限', () => {
  const low = buildEmbedSegments({
    hits: [{ source: 'events', id: 'e1', ts: NOW - HOUR, text: '无关内容', score: 0.2 }],
    mean: 0.5,
    sd: 0.2,
    key: '不存在的东西',
    minConfidence: 0.35,
    maxSegmentDays: 7,
    tzOffsetMinutes: 480,
    now: NOW,
  })
  assert.equal(low.segments.length, 0)

  const high = buildEmbedSegments({
    hits: [
      { source: 'events', id: 'e1', ts: NOW - 10 * HOUR, text: '早上修显卡散热', score: 0.8 },
      { source: 'events', id: 'e2', ts: NOW - 9 * HOUR, text: '显卡温度降了', score: 0.7 },
    ],
    mean: 0.5,
    sd: 0.2,
    key: '显卡',
    minConfidence: 0.35,
    maxSegmentDays: 7,
    tzOffsetMinutes: 480,
    now: NOW,
  })
  assert.equal(high.segments.length, 1)
  const [segment] = high.segments
  assert.ok(segment.confidence >= 0.35)
  assert.ok(segment.from <= NOW - 10 * HOUR && segment.to >= NOW - 9 * HOUR)
  assert.ok(segment.to - segment.from <= 7 * DAY)
  assert.match(segment.label, /·/)
})

test('区段：超出最宽幅时裁到密度最高的窗口', () => {
  const hits = []
  for (let index = 0; index < 60; index += 1) {
    hits.push({
      source: 'events',
      id: `e${index}`,
      ts: NOW - 20 * DAY + index * 5 * HOUR,
      text: `显卡记录 ${index}`,
      score: index === 30 ? 0.9 : 0.6,
    })
  }
  const { segments } = buildEmbedSegments({
    hits,
    mean: 0.5,
    sd: 0.1,
    key: '显卡',
    minConfidence: 0,
    maxSegmentDays: 1,
    tzOffsetMinutes: 480,
    now: NOW,
  })
  assert.equal(segments.length, 1)
  assert.ok(segments[0].to - segments[0].from <= DAY)
})

test('词法兜底：按线索命中时间区段，无命中则空', () => {
  const rows = [
    { source: 'events', id: 'e1', ts: NOW - 2 * HOUR, text: '早上修显卡散热' },
    { source: 'events', id: 'e2', ts: NOW - HOUR, text: '中午吃面条' },
  ]
  const hit = buildLexicalSegments({
    rows,
    key: '显卡',
    minConfidence: 0.35,
    maxSegmentDays: 7,
    tzOffsetMinutes: 480,
    now: NOW,
  })
  assert.equal(hit.segments.length, 1)
  assert.ok(hit.segments[0].confidence >= 0.35)
  const miss = buildLexicalSegments({
    rows,
    key: '完全不存在',
    minConfidence: 0.35,
    maxSegmentDays: 7,
    tzOffsetMinutes: 480,
    now: NOW,
  })
  assert.equal(miss.segments.length, 0)
})

test('meanSd：空集与常数序列', () => {
  assert.deepEqual(meanSd([]), { mean: 0, sd: 0 })
  assert.deepEqual(meanSd([2, 2, 2]), { mean: 2, sd: 0 })
  const { mean, sd } = meanSd([0, 1])
  assert.equal(mean, 0.5)
  assert.ok(sd > 0)
})
