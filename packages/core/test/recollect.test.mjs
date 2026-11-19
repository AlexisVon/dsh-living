import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MEMORY_TOOL_NAMES,
  buildRecollectPrompt,
  normalizeRecollectArgs,
  parseRecollectResult,
  recollectFailure,
} from '../lib/recollect.mjs'
import { registerMemoryTools, restrictToMemoryTools } from '../lib/memory-tools.mjs'

const NOW = Date.UTC(2026, 10, 17, 4)
const TZ = 480

test('回想参数：只收问题与模式，时间范围由子 agent 选', () => {
  const args = normalizeRecollectArgs({ question: '我早上修了什么', from: 1, to: 2 })
  assert.equal(args.mode, 'lookup')
  assert.equal(args.detail, 'brief')
  assert.equal(args.from, undefined)
  assert.equal(args.to, undefined)
  assert.throws(() => normalizeRecollectArgs({ question: '' }), /question/)
  assert.throws(() => normalizeRecollectArgs({ question: 'x', detail: 'deep' }), /detail/)
  assert.throws(() => normalizeRecollectArgs({ question: 'x', mode: 'scan' }), /mode/)
})

test('回想提示词带区段步骤、兜底天数与细节模式', () => {
  const brief = buildRecollectPrompt({
    question: '我早上修了什么',
    cue: '显卡',
    mode: 'lookup',
    detail: 'brief',
    now: NOW,
    tzOffsetMinutes: TZ,
    fallbackDays: 3,
  })
  assert.ok(brief.includes('我早上修了什么'))
  assert.ok(brief.includes('显卡'))
  assert.ok(brief.includes('living_memory_segments'))
  assert.ok(brief.includes('最近 3 天'))
  assert.ok(brief.includes('living_memory_scan'))
  assert.ok(brief.includes('不带 text'))
  const full = buildRecollectPrompt({
    question: 'x',
    detail: 'full',
    now: NOW,
    tzOffsetMinutes: TZ,
  })
  assert.ok(full.includes('原文片段'))
})

test('回想解析：主选备选与证据；brief 丢掉 text，full 保留', () => {
  const body = JSON.stringify({
    ok: true,
    summary: '总结',
    primary: {
      answer: '主答案',
      confidence: 'high',
      evidence: [{ source: 'events', id: 'e1', ts: NOW, text: '原文' }],
    },
    backup: {
      answer: '备选',
      evidence: [{ source: 'journal', id: 'j1', ts: NOW - 1000 }],
    },
  })
  const brief = parseRecollectResult(body, { detail: 'brief' })
  assert.equal(brief.ok, true)
  assert.equal(brief.primary.answer, '主答案')
  assert.equal(brief.backup.answer, '备选')
  assert.equal(brief.primary.evidence[0].text, undefined)

  const full = parseRecollectResult(body, { detail: 'full' })
  assert.equal(full.primary.evidence[0].text, '原文')
})

test('回想解析：允许失败，失败时不给答案', () => {
  const parsed = parseRecollectResult(JSON.stringify({
    ok: false,
    summary: '没找到，扫到 11-16 为止',
    primary: { answer: '不该存在', evidence: [{ source: 'events', id: 'e1', ts: NOW }] },
  }))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.primary, null)
  assert.equal(parsed.backup, null)
})

test('回想解析：无证据或非法 JSON 大声失败', () => {
  assert.throws(() => parseRecollectResult('not json'), /JSON/)
  assert.throws(
    () => parseRecollectResult(JSON.stringify({ ok: true, summary: 's', primary: { answer: 'a', evidence: [] } })),
    /证据/,
  )
  assert.throws(
    () => parseRecollectResult(JSON.stringify({ ok: true, summary: 's', primary: { answer: 'a', evidence: [{ source: 'raw', id: 'r', ts: NOW }] } })),
    /证据/,
  )
})

test('回想失败形态统一', () => {
  const result = recollectFailure({ error: 'recollect_timeout', scanned: { from: 1, to: 2 }, tokens: 9 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'recollect_timeout')
  assert.equal(result.primary, null)
  assert.equal(result.backup, null)
  assert.equal(result.usage.tokens, 9)
})

test('记忆工具：segments 的异步结果被 await，不序列化成空对象', async () => {
  const registered = new Map()
  const ctx = { tools: { register: (definition) => registered.set(definition.name, definition) } }
  registerMemoryTools(ctx, {
    memorySegments: async () => ({ ok: true, segments: [{ from: 1, to: 2, label: 'x', confidence: 0.5 }] }),
    memoryOverview: () => ({}),
    memoryScan: () => ({ rows: [] }),
    memoryGet: () => ({}),
  })
  const result = await registered.get('living_memory_segments').execute({ key: '显卡' })
  assert.equal(JSON.parse(result.text).segments.length, 1)
})

test('回想器工具面只留记忆工具', () => {
  const { ctx, denied } = fakeAgentCtx([...MEMORY_TOOL_NAMES, 'mcp__alxrun__run', 'living_send', 'read'])
  const result = restrictToMemoryTools(ctx, '测试回想')
  assert.deepEqual(result.sort(), [...MEMORY_TOOL_NAMES].sort())
  assert.deepEqual([...denied].sort(), ['living_send', 'mcp__alxrun__run', 'read'])
  assert.throws(
    () => restrictToMemoryTools(fakeAgentCtx([MEMORY_TOOL_NAMES[0]]).ctx, '测试回想'),
    /缺少记忆工具/,
  )
})

function fakeAgentCtx(names) {
  const denied = new Set()
  const definitions = () => names.filter((name) => !denied.has(name)).map((name) => ({ name }))
  const tools = {
    definitions: () => definitions(),
    restrict: ({ deny }) => {
      for (const name of deny) denied.add(name)
    },
  }
  const ctx = {
    tools,
    get: (key) => (key === 'tools' ? tools : undefined),
  }
  Object.defineProperty(ctx, Symbol('dsh.scope'), { value: 'scope' })
  return { ctx, denied }
}
