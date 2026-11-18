/** Mechanical consolidation: episodes, demotion candidates, fact merging. */

import { createHash } from 'node:crypto'
import { tokenizeCue } from './text.mjs'
import { isDemotionCandidate } from './layers.mjs'
import { formatCold } from './memory.mjs'

const STOP = new Set([
  '这个', '那个', '什么', '怎么', '可以', '就是', '不是', '没有', '一个', '自己',
  '我们', '你们', '他们', '现在', '时候', '因为', '所以', '但是', '如果', '还是',
  '已经', '应该', '可能', '觉得', '知道', '记得', '上次', '这样', '那样', '今天',
  '明天', '昨天', '后来', '然后', '开始', '一下', '一直', '有点',
])

export function clusterEpisodes(events, { maxGapMinutes = 120 } = {}) {
  const sorted = events.filter((event) => Number.isFinite(event?.ts)).sort((a, b) => a.ts - b.ts)
  const groups = []
  let current = []
  for (const event of sorted) {
    const last = current[current.length - 1]
    if (last && event.ts - last.ts > maxGapMinutes * 60000) {
      groups.push(current)
      current = []
    }
    current.push(event)
  }
  if (current.length) groups.push(current)

  return groups.map((group) => {
    const texts = group.map(eventText).filter(Boolean)
    return {
      id: `ep_${group[0].id}`,
      tsStart: group[0].ts,
      tsEnd: group[group.length - 1].ts,
      title: (texts[0] ?? '').slice(0, 20),
      summary: texts.join('；').slice(0, 1200),
      importance: Math.max(0.2, ...group.map((event) => Number(event.payload?.importance) || 0.2)),
      eventIds: group.map((event) => event.id),
    }
  })
}

export function selectDemotions(entries, { now = Date.now(), threshold = 0.15, maxKeywords = 3 } = {}) {
  const rows = []
  for (const entry of entries) {
    if (!isDemotionCandidate(entry, now, threshold)) continue
    const text = String(entry.text ?? '')
    const keywords = pickKeywords(text, maxKeywords)
    const refs = (entry.eventRefs ?? []).slice(0, 3)
    const label20 = text.replace(/\s+/g, ' ').slice(0, 20)
    if (!keywords.length) {
      rows.push({ keyword: label20 || entry.id, eventIds: refs, label20, lastTs: entry.lastTs ?? entry.ts, importance: entry.importance ?? 0, fidelity: 'low' })
      continue
    }
    for (const keyword of keywords) {
      rows.push({ keyword, eventIds: refs, label20, lastTs: entry.lastTs ?? entry.ts, importance: entry.importance ?? 0, fidelity: 'low' })
    }
  }
  return rows
}

export function pickKeywords(text, max = 3) {
  const out = []
  for (const token of tokenizeCue(text, 80)) {
    if (STOP.has(token)) continue
    if (!/^[㐀-鿿]{2,4}$/.test(token) && !/^[a-z0-9_]{2,}$/.test(token)) continue
    if (!out.includes(token)) out.push(token)
    if (out.length >= max) break
  }
  return out
}

export function mergeFacts(existing = [], incoming = []) {
  const map = new Map()
  for (const fact of existing) map.set(factKey(fact), { ...fact, eventIds: [...(fact.eventIds ?? [])] })
  let added = 0
  let updated = 0
  for (const fact of incoming) {
    const key = factKey(fact)
    const prev = map.get(key)
    if (!prev) {
      map.set(key, {
        id: fact.id ?? `fact_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`,
        ...fact,
        eventIds: [...(fact.eventIds ?? [])],
      })
      added += 1
      continue
    }
    prev.lastSeen = Math.max(prev.lastSeen ?? 0, fact.lastSeen ?? 0)
    prev.confidence = Math.max(Number(prev.confidence) || 0, Number(fact.confidence) || 0)
    prev.eventIds = [...new Set([...(prev.eventIds ?? []), ...(fact.eventIds ?? [])])].slice(0, 20)
    updated += 1
  }
  return { facts: [...map.values()], added, updated }
}

export function buildColdClues(rows, limit = 8) {
  return rows.slice(0, limit).map(formatCold).join('\n')
}

function factKey(fact) {
  return `${fact.subject ?? ''}|${fact.predicate ?? ''}|${fact.object ?? ''}`
}

function eventText(event) {
  if (typeof event?.payload?.text === 'string') return event.payload.text
  if (typeof event?.payload === 'string') return event.payload
  return ''
}
