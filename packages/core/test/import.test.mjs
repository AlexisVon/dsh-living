import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseImport, prepareImport, fingerprint } from '../lib/import.mjs'

test('markdown：按 ## 切段，标题行不单独成段', () => {
  const parts = parseImport({
    format: 'markdown',
    text: '# 我的笔记\n\n## 显卡\n散热坏了\n\n## 风扇\n换了新的',
  })
  assert.deepEqual(parts.map((p) => p.text), ['显卡\n散热坏了', '风扇\n换了新的'])
})

test('markdown：没有 ## 时按 § 切段', () => {
  const parts = parseImport({ format: 'markdown', text: '第一段§第二段§第三段' })
  assert.deepEqual(parts.map((p) => p.text), ['第一段', '第二段', '第三段'])
})

test('plain：按空行切段', () => {
  const parts = parseImport({ format: 'plain', text: '第一段\n\n第二段\n\n\n第三段' })
  assert.deepEqual(parts.map((p) => p.text), ['第一段', '第二段', '第三段'])
})

test('jsonl：逐行解析 ts / tags，坏行大声失败', () => {
  const parts = parseImport({
    format: 'jsonl',
    text: '{"text":"一","ts":1,"tags":["a"]}\n{"text":"二"}\n',
  })
  assert.deepEqual(parts, [
    { text: '一', ts: 1, tags: ['a'] },
    { text: '二', ts: null, tags: [] },
  ])
  assert.throws(() => parseImport({ format: 'jsonl', text: '{bad}\n' }), RangeError)
  assert.throws(() => parseImport({ format: 'jsonl', text: '{"ts":1}\n' }), RangeError)
})

test('未知格式与空输入', () => {
  assert.throws(() => parseImport({ format: 'xml', text: 'x' }), RangeError)
  assert.deepEqual(parseImport({ format: 'plain', text: '   ' }), [])
})

test('指纹稳定，来源不同则不同', () => {
  assert.equal(fingerprint('a.md', ' 同一条 '), fingerprint('a.md', '同一条'))
  assert.notEqual(fingerprint('a.md', '同一条'), fingerprint('b.md', '同一条'))
  assert.equal(fingerprint('a.md', '同一条').length, 16)
})

test('prepareImport：默认进 L3、不可驱动行动、幂等键一致', () => {
  const first = prepareImport({ format: 'plain', source: 'notes.md', text: '第一条\n\n第二条' })
  const second = prepareImport({ format: 'plain', source: 'notes.md', text: '第一条\n\n第二条' })
  assert.deepEqual(first.map((i) => i.key), second.map((i) => i.key))
  for (const item of first) {
    assert.equal(item.kind, 'fact')
    assert.equal(item.layer, 'L3')
    assert.equal(item.source, 'import')
    assert.equal(item.drivesAction, false)
    assert.deepEqual(item.eventRefs, [])
  }
})
