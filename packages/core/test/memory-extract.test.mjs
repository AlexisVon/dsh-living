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
