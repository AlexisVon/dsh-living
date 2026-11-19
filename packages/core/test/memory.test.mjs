import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { buildL0, expandGraph, selectL0, collectMemoryItems, formatCold } from '../lib/memory.mjs'
import { recall } from '../lib/recall.mjs'
import { estimateTokens } from '../lib/text.mjs'

const NOW = Date.UTC(2026, 10, 17, 12)
const MIN = 60000

function entry(overrides = {}) {
  return {
    id: 'm1',
    kind: 'event',
    text: '显卡散热坏了',
    ts: NOW,
    lastTs: NOW,
    source: 'bili',
    layer: 'L2',
    strength: 0.8,
    fidelity: 1,
    why: ['R1:cued_by=散热'],
    ...overrides,
  }
}

test('候选池取最近 N 条，不是最早 N 条', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'living-memory-'))
  const store = createStore({ path: join(home, 'life.db'), now: () => NOW })
  t.after(async () => {
    await store.close()
    rmSync(home, { recursive: true, force: true })
  })
  for (let index = 1; index <= 3; index += 1) {
    await store.appendEvent({ id: `ev${index}`, ts: index, kind: 'message', payload: { text: `e${index}`, importance: 0.9 } })
  }
  const items = collectMemoryItems(store, { limit: 2, now: NOW })
  assert.deepEqual(items.filter((item) => item.kind === 'message').map((item) => item.id), ['ev2', 'ev3'])
})

test('G1：图关系把邻居条目带进召回', () => {
  const items = [
    entry({ id: 'ep1', kind: 'episode', text: '修显卡', source: 'episode' }),
    entry({ id: 'ep2', kind: 'episode', text: '换风扇', source: 'episode' }),
  ]
  const result = {
    recalled: [{ id: 'ep1', kind: 'episode', text: '修显卡', score: 0.6, why: ['R1:cued_by=显卡'], layer: 'L2' }],
    partialHits: [],
    debug: {},
  }
  const edgesFor = (kind, id) => (id === 'ep1'
    ? [{ otherKind: 'episode', otherId: 'ep2', relation: 'causes', confidence: 0.9 }]
    : [])
  expandGraph(result, items, edgesFor, { limit: 5 })
  assert.equal(result.recalled.length, 2)
  assert.equal(result.recalled.find((item) => item.id === 'ep2').why[0], 'G1:causes')
  assert.equal(result.debug.graphExpanded, 1)
})

test('L0 不超 token 预算，超出即截断', () => {
  const recalled = Array.from({ length: 30 }, (_, i) =>
    entry({ id: `m${i}`, text: '这是一条很长的记忆内容，用来把预算撑满'.repeat(4) }),
  )
  const l0 = buildL0({ recalled, budgetTokens: 300, now: NOW })
  assert.ok(l0.entries.length < recalled.length)
  assert.ok(l0.tokens <= 300 + 8, `tokens=${l0.tokens}`)
  assert.equal(l0.truncated, true)
})

test('L0 为「cue 命中但历史最冷」保留一个位置', () => {
  const hot = entry({ id: 'hot', text: '最近总在说散热', strength: 0.9 })
  const cold = entry({ id: 'cold', text: '最早提过一次散热', strength: 0.05 })
  const l0 = buildL0({ recalled: [hot], coldest: cold, budgetTokens: 400, now: NOW })
  assert.ok(l0.entries.some((e) => e.id === 'cold'))
})

test('冷区线索最多 8 条，措辞带低保真限定', () => {
  const cold = Array.from({ length: 12 }, (_, i) => ({ keyword: `线索${i}`, lastTs: NOW, label20: `显卡${i}` }))
  const l0 = buildL0({ recalled: [], cold, now: NOW })
  assert.equal(l0.coldCount, 8)
  assert.ok(l0.text.includes('细节已不可考'))
  assert.ok(l0.text.includes('不得作为行动依据'))
})

test('导入内容不直接进 L0', () => {
  const observed = entry({ id: 'obs', text: '散热坏了', source: 'bili' })
  const imported = entry({ id: 'imp', text: '散热笔记', source: 'import', layer: 'L3', drivesAction: false })
  const l0 = selectL0({ items: [observed, imported], cue: { text: '散热' }, budgetTokens: 400, now: NOW })
  assert.ok(l0.recall.recalled.some((e) => e.id === 'obs'))
  assert.ok(!l0.recall.recalled.some((e) => e.id === 'imp'))
})

test('低保真条目可发言，但 drivesAction=false', () => {
  const l0 = buildL0({ recalled: [entry({ fidelity: 0.5 })], now: NOW })
  assert.equal(l0.entries[0].drivesAction, false)
})

test('formatCold 固定措辞', () => {
  const line = formatCold({ keyword: '显卡', lastTs: Date.UTC(2026, 8, 1) })
  assert.equal(line, '- 你隐约记得（2026-09）：显卡 —— 细节已不可考')
})

test('collectMemoryItems：事件/情节/事实/导入的来源与可行动性', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'living-memory-'))
  const store = createStore({ path: join(dir, 'life.db') })
  t.after(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  await store.appendEvent({ id: 'e1', ts: NOW, kind: 'message', source: 'bili', payload: { text: '显卡散热坏了', importance: 0.4 } })
  await store.appendEvent({ id: 'op1', ts: NOW, kind: 'outbound_decision', source: 'living', payload: { text: '{"outboxId":"x"}' } })
  await store.appendEpisode({ id: 'ep1', tsStart: NOW - 10 * MIN, tsEnd: NOW, title: '修电脑', summary: '换了风扇', importance: 0.6, eventIds: ['e1'] })
  await store.upsertFact({ id: 'f1', subject: '小明', predicate: '喜欢', object: '看展', confidence: 0.8, firstSeen: NOW - MIN, lastSeen: NOW, source: 'chat', eventIds: ['e1'] })
  await store.setFacets('fact', 'f1', { who: ['小明'] })
  await store.recordImport({ key: 'k1', source: 'note.md', ts: NOW, text: '导入的一条' })

  const items = collectMemoryItems(store, { now: NOW })
  const event = items.find((i) => i.id === 'e1')
  assert.equal(event.drivesAction, true)
  assert.deepEqual(event.eventRefs, ['e1'])

  const episode = items.find((i) => i.id === 'ep1')
  assert.equal(episode.kind, 'episode')
  assert.deepEqual(episode.eventRefs, ['e1'])

  const fact = items.find((i) => i.id === 'f1')
  assert.deepEqual(fact.facets.who, ['小明'])
  assert.equal(fact.layer, 'L3')

  const imported = items.find((i) => i.source === 'import')
  assert.equal(imported.drivesAction, false)
  assert.deepEqual(imported.eventRefs, [])
  assert.equal(imported.origin, 'import')
  assert.ok(!items.some((i) => i.id === 'op1'), '运行流水不进记忆候选池')
})

test('collectMemoryItems：journal 直接召回，整理后让位给归一化条目', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'living-memory-'))
  const store = createStore({ path: join(dir, 'life.db') })
  t.after(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  await store.appendJournalEntry({ id: 'jr_1', date: '2026-11-17', ts: NOW, text: '今天读了郑渊洁的 AI 动画新闻' })
  const items = collectMemoryItems(store, { now: NOW })
  const journal = items.find((item) => item.id === 'jr_1')
  assert.equal(journal.kind, 'journal')
  assert.equal(journal.layer, 'L5')
  assert.deepEqual(journal.recallChannels, ['R1', 'R5', 'R6', 'R8'])

  const cued = recall({ items, cue: { text: '郑渊洁' }, topK: 5, now: NOW })
  assert.ok(cued.recalled.some((entry) => entry.id === 'jr_1'))
  const uncued = recall({ items, cue: {}, topK: 5, now: NOW, rng: () => 0.99 })
  assert.ok(!uncued.recalled.some((entry) => entry.id === 'jr_1'), 'journal 不靠近因/显著挤进 L0')

  await store.appendRawSegment({
    id: 'raw_journal_jr_1',
    kind: 'journal',
    tsStart: NOW,
    tsEnd: NOW,
    payload: { source: 'journal', messages: [{ role: 'journal', ts: NOW, text: '郑渊洁 AI 动画' }] },
  })
  await store.markRawSegment('raw_journal_jr_1')
  await store.appendEpisode({ id: 'ep_j', tsStart: NOW, title: '郑渊洁', summary: 'AI 动画', rawRefs: ['raw_journal_jr_1'] })
  await store.setFacets('episode', 'ep_j', { who: ['郑渊洁'], what: ['动画'] })
  const after = collectMemoryItems(store, { now: NOW })
  assert.ok(!after.some((item) => item.id === 'jr_1'), '已有归一化条目引用该 journal 时不再重复')
  const kept = after.find((item) => item.id === 'ep_j')
  assert.ok(kept, '归一化条目接管召回')
  assert.deepEqual(kept.facets.who, ['郑渊洁'])
})
