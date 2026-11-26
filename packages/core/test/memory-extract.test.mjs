import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildMemoryPrompt, parseMemoryExtraction } from '../lib/memory-extract.mjs'

const segments = [{
  id: 'raw_s1',
  kind: 'rest',
  tsStart: 100,
  tsEnd: 200,
  payload: { messages: [{ role: 'user', ts: 100, text: '在吗' }, { role: 'assistant', ts: 200, text: '在' }] },
}]

test('memory-extract：prompt 带 raw id 与固定关系词表', () => {
  const prompt = buildMemoryPrompt({ segments })
  assert.match(prompt, /raw_s1/)
  assert.match(prompt, /causes/)
  assert.match(prompt, /只输出 JSON/)
  assert.match(prompt, /journal 条目/)
  assert.match(prompt, /元记忆/)
  assert.match(prompt, /\[@100\]/)
  assert.match(prompt, /@毫秒/)
})

test('memory-extract：越界时间戳夹到自己的 raw 段，fact 用段范围', () => {
  const result = parseMemoryExtraction(JSON.stringify({
    items: [
      { kind: 'episode', title: '越界', description: '越界', raw: 'raw_s1', ts_start: 900, ts_end: 1000 },
      { kind: 'fact', subject: 'a', predicate: 'b', object: 'c', raw: 'raw_s1' },
    ],
  }), { segments })
  assert.equal(result.items[0].tsStart, 200)
  assert.equal(result.items[0].tsEnd, 200)
  assert.equal(result.items[1].tsStart, 100)
  assert.equal(result.items[1].tsEnd, 200)
  assert.equal(result.tsFixed, 1)
})

test('memory-extract：多段批次里 fact 用自己的 raw 段，不用批首范围', () => {
  const batch = [
    { id: 'raw_a', kind: 'journal', tsStart: 100, tsEnd: 100, payload: { messages: [] } },
    { id: 'raw_b', kind: 'journal', tsStart: 900, tsEnd: 900, payload: { messages: [] } },
  ]
  const result = parseMemoryExtraction(JSON.stringify({
    items: [{ kind: 'fact', subject: 'x', predicate: 'y', object: 'z', raw: 'raw_b' }],
  }), { segments: batch })
  assert.equal(result.items[0].tsStart, 900)
  assert.equal(result.items[0].tsEnd, 900)
  assert.equal(result.tsFixed, 0)
})

test('memory-extract：解析 episode/fact/边，clamp 置信度', () => {
  const result = parseMemoryExtraction(`\`\`\`json
  {
    "items": [
      { "kind": "episode", "title": "修显卡", "description": "换了风扇", "importance": 2, "confidence": -1, "ts_start": 100, "ts_end": 200, "raw": "raw_s1", "facets": { "who": ["小明"], "bad": ["x"] } },
      { "kind": "fact", "subject": "小明", "predicate": "喜欢", "object": "看展", "confidence": 0.9, "raw": "raw_s1" },
      { "kind": "episode", "title": "", "description": "", "raw": "raw_s1" }
    ],
    "edges": [
      { "from": 0, "to": 1, "relation": "supports", "note": "一致", "confidence": 0.8 },
      { "from": 0, "to": 2, "relation": "made_up", "confidence": 0.2 },
      { "from": 0, "to": 0, "relation": "causes" }
    ]
  }
  \`\`\``, { segments })
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].importance, 1)
  assert.equal(result.items[0].confidence, 0)
  assert.deepEqual(result.items[0].facets, { who: ['小明'] })
  assert.equal(result.items[1].kind, 'fact')
  assert.equal(result.edges.length, 1, '被跳过的条目会让边索引重映射并丢弃无效边')
  assert.equal(result.edges[0].from, 0)
  assert.equal(result.edges[0].to, 1)
  assert.equal(result.edges[0].relation, 'supports')
})

test('memory-extract：未知关系回退 related_to', () => {
  const result = parseMemoryExtraction(JSON.stringify({
    items: [
      { kind: 'episode', title: 'a', description: 'a', raw: 'raw_s1', ts_start: 100 },
      { kind: 'episode', title: 'b', description: 'b', raw: 'raw_s1', ts_start: 200 },
    ],
    edges: [{ from: 0, to: 1, relation: 'invented', note: '相关' }],
  }), { segments })
  assert.equal(result.edges[0].relation, 'related_to')
})

test('memory-extract：非 JSON 大声失败', () => {
  assert.throws(() => parseMemoryExtraction('不是 JSON', { segments }), /不是 JSON/)
})

test('memory-extract：maxItems/maxEdges 可覆盖', () => {
  const prompt = buildMemoryPrompt({ segments, maxItems: 5, maxEdges: 6 })
  assert.match(prompt, /items 最多 5 条/)
  const payload = {
    items: [
      { kind: 'episode', title: 'a', description: 'a', raw: 'raw_s1', ts_start: 100 },
      { kind: 'episode', title: 'b', description: 'b', raw: 'raw_s1', ts_start: 200 },
      { kind: 'episode', title: 'c', description: 'c', raw: 'raw_s1', ts_start: 300 },
    ],
    edges: [
      { from: 0, to: 1, relation: 'causes', confidence: 0.8 },
      { from: 0, to: 2, relation: 'causes', confidence: 0.8 },
    ],
  }
  const result = parseMemoryExtraction(JSON.stringify(payload), { segments, maxItems: 2, maxEdges: 1 })
  assert.equal(result.items.length, 2)
  assert.equal(result.edges.length, 1)
})
