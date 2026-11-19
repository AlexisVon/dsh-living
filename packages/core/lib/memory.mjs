/** L0 assembly: hot summaries plus cold low-fidelity clues, under a token budget. */

import { estimateTokens, overlapScore, tokenizeCue } from './text.mjs'
import { classifyLayer, decayedStrength } from './layers.mjs'
import { recall } from './recall.mjs'

export const L0_DEFAULT_TOKENS = 3000
export const COLD_CLUE_MAX = 8

/** Authored-finite event sources that may become memory; operational logs stay in the ledger. */
export const MEMORY_EVENT_KINDS = Object.freeze(['message', 'notice', 'agent_mark', 'import'])

const JOURNAL_ITEM_LIMIT = 2000

/** Authored-finite markers for self-referential memory-system logs; such items stay recallable but never outrank real memories. */
const META_HINTS = Object.freeze([
  '元记忆',
  '自检',
  '校准',
  '记忆整合',
  '记忆系统',
  '记忆检索',
  '记忆注入',
  '注入精简',
  '记忆区',
  '抽样查询',
  'recall 排序',
  'recall 检索',
  'recall 捞',
  'memory.items',
  'lastConsolidationAt',
  'raw_pending',
  'persona_evolve',
])

export function isMetaMemory(text) {
  const value = String(text ?? '').toLowerCase()
  return META_HINTS.some((hint) => value.includes(hint.toLowerCase()))
}

/** Only the strong field decides: an episode title / fact subject (or a self-written mark) is a system log. */
function metaFor(kind, title, text) {
  if (kind === 'episode' || kind === 'fact') return isMetaMemory(title)
  if (kind === 'agent_mark') return isMetaMemory(text)
  return false
}

export function collectMemoryItems(store, { now = Date.now(), since = null, limit = 500 } = {}) {
  const items = []
  for (const event of store.listEvents({ since, kinds: MEMORY_EVENT_KINDS, limit, order: 'desc' })) {
    const imported = event.kind === 'import' || event.source === 'import'
    const body = event.payload?.text ?? JSON.stringify(event.payload ?? {})
    const replyTo = event.payload?.meta?.reply_to
    const text = replyTo ? `${body}（回复目标: ${replyTo}）` : body
    items.push({
      id: event.id,
      kind: imported ? 'fact' : event.kind,
      layer: imported ? 'L3' : classifyLayer({ kind: event.kind, text }),
      text,
      ts: event.ts,
      lastTs: event.ts,
      source: event.source,
      confidence: imported ? 0.6 : 0.75,
      importance: Number(event.payload?.importance) || 0.3,
      arousal: Number(event.payload?.arousal) || 0,
      affect: event.payload?.affect,
      facets: store.getFacets(event.kind === 'import' ? 'fact' : event.kind, event.id),
      eventRefs: imported ? [] : [event.id],
      drivesAction: !imported,
      origin: imported ? 'import' : 'observed',
      meta: metaFor(imported ? 'fact' : event.kind, undefined, text),
    })
  }
  const normalizedJournalRefs = new Set(store.listJournalRawIds())
  for (const episode of store.listEpisodes({ limit, order: 'desc' })) {
    const text = [episode.title, episode.summary].filter(Boolean).join('：')
    items.push({
      id: episode.id,
      kind: 'episode',
      layer: 'L2',
      title: episode.title ?? null,
      text,
      ts: episode.tsStart,
      lastTs: episode.tsEnd ?? episode.tsStart,
      source: 'episode',
      confidence: 0.8,
      importance: Number(episode.importance) || 0.3,
      facets: store.getFacets('episode', episode.id),
      eventRefs: episode.eventIds,
      drivesAction: true,
      origin: 'observed',
      meta: metaFor('episode', episode.title, text),
    })
  }
  for (const fact of store.listFacts({ limit })) {
    const text = `${fact.subject} ${fact.predicate} ${fact.object}`.trim()
    items.push({
      id: fact.id,
      kind: 'fact',
      layer: classifyLayer({ kind: 'fact', text }),
      title: fact.subject ?? null,
      text,
      ts: fact.lastSeen ?? fact.firstSeen,
      lastTs: fact.lastSeen ?? fact.firstSeen,
      source: fact.source,
      confidence: fact.confidence,
      importance: 0.5,
      facets: store.getFacets('fact', fact.id),
      eventRefs: fact.eventIds,
      drivesAction: true,
      origin: 'observed',
      meta: metaFor('fact', fact.subject, text),
    })
  }
  for (const entry of store.listJournalEntries({ limit: JOURNAL_ITEM_LIMIT })) {
    if (since != null && entry.ts < since) continue
    if (normalizedJournalRefs.has(entry.id)) continue
    items.push({
      id: entry.id,
      kind: 'journal',
      layer: 'L5',
      text: entry.text,
      ts: entry.ts,
      lastTs: entry.ts,
      source: 'journal',
      confidence: 1,
      importance: 0.55,
      facets: { when: [entry.date] },
      eventRefs: [],
      drivesAction: true,
      origin: 'journal',
      recallChannels: ['R1', 'R5', 'R6', 'R8'],
    })
  }
  return items
}

/** Recall, then pack the result into the L0 text. */
export function selectL0({
  items,
  cue = {},
  cold = [],
  budgetTokens = L0_DEFAULT_TOKENS,
  topK = 15,
  channels = [],
  mood = {},
  now = Date.now(),
  rng = Math.random,
  includeImports = false,
  edgesFor = null,
  tzOffsetMinutes = null,
}) {
  const eligible = includeImports ? items : items.filter((item) => item.source !== 'import')
  const result = recall({ items: eligible, cue, mood, channels, topK, now, rng })
  expandGraph(result, eligible, edgesFor, { limit: topK, now, enabled: channels.length === 0 || channels.includes('G1') })
  const coldest = coldestCueHit(eligible, result.recalled, cue, now)
  const l0 = buildL0({ recalled: result.recalled, partialHits: result.partialHits, cold, coldest, budgetTokens, now, tzOffsetMinutes })
  return { ...l0, recall: result }
}

/** G1: one-hop graph expansion from the recall seeds. Edges are derived data. */
export function expandGraph(result, items, edgesFor, { limit = 8, maxSeeds = 5, now = Date.now(), enabled = true } = {}) {
  if (!enabled || !result || typeof edgesFor !== 'function' || !result.recalled?.length) return result
  const byKey = new Map(items.map((item) => [`${item.kind}:${item.id}`, item]))
  const seen = new Set(result.recalled.map((item) => `${item.kind}:${item.id}`))
  const added = []
  for (const seed of result.recalled.slice(0, maxSeeds)) {
    for (const edge of edgesFor(seed.kind, seed.id) ?? []) {
      const key = `${edge.otherKind}:${edge.otherId}`
      if (seen.has(key)) continue
      const item = byKey.get(key)
      if (!item || item.suppressed || item.meta) continue
      const score = Math.min(0.6, (Number(seed.score) || 0.3) * (Number(edge.confidence) || 0.5) * 0.7)
      if (score <= 0.02) continue
      seen.add(key)
      added.push({
        id: item.id,
        kind: item.kind,
        layer: item.layer,
        text: item.text,
        score,
        strength: item.strength ?? decayedStrength(item, now),
        why: [`G1:${edge.relation}`],
        drivesAction: item.drivesAction !== false,
      })
    }
  }
  if (added.length === 0) return result
  result.recalled = [...result.recalled, ...added].sort((left, right) => right.score - left.score).slice(0, Math.max(1, limit))
  result.debug = { ...(result.debug ?? {}), graphExpanded: added.length }
  return result
}

export function buildL0({
  recalled = [],
  partialHits = [],
  cold = [],
  coldest = null,
  budgetTokens = L0_DEFAULT_TOKENS,
  now = Date.now(),
  tzOffsetMinutes = null,
}) {
  const coldLines = cold.slice(0, COLD_CLUE_MAX).map((row) => formatCold(row, tzOffsetMinutes))
  const coldCost = coldLines.reduce((sum, line) => sum + estimateTokens(`${line}\n`), 0)
  const coldestLine = coldest ? formatEntry(coldest, tzOffsetMinutes) : null
  const reserve = coldestLine ? estimateTokens(`${coldestLine}\n`) : 0
  const available = Math.max(0, budgetTokens - coldCost - reserve)

  const entries = []
  const lines = []
  let used = 0
  for (const entry of recalled) {
    const line = formatEntry(entry, tzOffsetMinutes)
    const cost = estimateTokens(`${line}\n`)
    if (used + cost > available) break
    entries.push(entry)
    lines.push(line)
    used += cost
  }
  if (coldestLine && !entries.some((entry) => entry.id === coldest?.id) && used + reserve <= available) {
    entries.push(coldest)
    lines.push(coldestLine)
    used += reserve
  }

  const parts = []
  if (lines.length) parts.push(lines.join('\n'))
  if (coldLines.length) parts.push(`冷区线索（低保真，不得作为行动依据）：\n${coldLines.join('\n')}`)
  const text = parts.join('\n\n')
  return {
    text,
    tokens: estimateTokens(text),
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      text: entry.text,
      why: entry.why ?? [],
      drivesAction: entry.drivesAction !== false && (entry.fidelity ?? 1) >= 0.7,
    })),
    partialHits,
    coldCount: coldLines.length,
    truncated: entries.length < recalled.length,
  }
}

function localDate(ts, tzOffsetMinutes) {
  const tz = tzOffsetMinutes ?? -new Date().getTimezoneOffset()
  return new Date(ts + tz * 60000).toISOString().slice(0, 10)
}

export function formatEntry(entry, tzOffsetMinutes = null) {
  const date = Number.isFinite(entry.ts) ? localDate(entry.ts, tzOffsetMinutes) : '—'
  const text = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
  return `- [${date}] ${text}`
}

export function formatCold(row, tzOffsetMinutes = null) {
  const date = Number.isFinite(row.lastTs) ? localDate(row.lastTs, tzOffsetMinutes).slice(0, 7) : '很久以前'
  const label = row.label20 || row.keyword || '某事'
  return `- 你隐约记得（${date}）：${label} —— 细节已不可考`
}

export function coldestCueHit(items, recalled, cue, now) {
  const recalledIds = new Set(recalled.map((entry) => entry.id))
  const tokens = tokenizeCue([cue.text ?? '', ...(cue.entities ?? [])].join(' '))
  if (!tokens.length) return null
  let coldest = null
  let coldestStrength = Infinity
  for (const item of items) {
    if (recalledIds.has(item.id)) continue
    const haystack = [item.text, item.source, item.target].filter(Boolean).join(' ')
    if (overlapScore(tokens, haystack) <= 0.08) continue
    const strength = item.strength ?? decayedStrength(item, now)
    if (strength < coldestStrength) {
      coldest = item
      coldestStrength = strength
    }
  }
  return coldest
}
