/**
 * R1–R8 recall channels. A memory may surface only if at least one channel
 * actually fired; every result carries why_recalled (WORKPLAN §5.2).
 */

import { overlapScore, tokenizeCue } from './text.mjs'
import { decayedStrength, recencyScore, rehearsalScore } from './layers.mjs'

export const RECALL_WEIGHTS = Object.freeze({
  sem: 0.25,
  emo: 0.15,
  sal: 0.2,
  rec: 0.1,
  reh: 0.1,
  src: 0.1,
  ctx: 0.1,
})

export const RECALL_CHANNELS = Object.freeze({
  R1: { id: 'R1', name: '线索扩散' },
  R2: { id: 'R2', name: '情绪同频' },
  R3: { id: 'R3', name: '近因与首因' },
  R4: { id: 'R4', name: '显著度插队' },
  R5: { id: 'R5', name: '人物·场景关联' },
  R6: { id: 'R6', name: '时间链回溯' },
  R7: { id: 'R7', name: '不自主闪回' },
  R8: { id: 'R8', name: '舌尖现象' },
  G1: { id: 'G1', name: '关系图扩散' },
})

const R1_MIN = 0.08
const R2_MIN = 0.25
const SALIENCE_GATE = 0.6
const AROUSAL_GATE = 0.5
const PARTIAL_MIN = 0.04
const PARTIAL_MAX = 0.34
const CHAIN_WINDOW_MIN = 30
const CHAIN_BONUS = 0.12
const SPONTANEOUS_PROB = 0.5

export function recall({
  items = [],
  cue = {},
  mood = {},
  channels = [],
  topK = 5,
  allowPartial = true,
  now = Date.now(),
  rng = Math.random,
  weights = RECALL_WEIGHTS,
} = {}) {
  const use = (id) => channels.length === 0 || channels.includes(id)
  const cueTokens = tokenizeCue([cue.text ?? '', ...(cue.entities ?? [])].join(' '))
  const participants = (cue.participants ?? []).map(String)
  const scene = String(cue.scene ?? '')
  const target = String(cue.target ?? '')
  const hasCue = cueTokens.length > 0 || participants.length > 0 || scene !== '' || target !== ''
  const moodKeys = Object.keys(mood ?? {}).filter((k) => Number(mood[k]) > 0)

  const earliest = new Map()
  for (const item of items) {
    const key = `${item.source ?? ''}|${item.kind ?? ''}`
    if (!earliest.has(key) || (item.ts ?? 0) < (earliest.get(key).ts ?? 0)) earliest.set(key, item)
  }

  const scored = []
  const partials = []

  for (const item of items) {
    if (!item || item.suppressed) continue
    const allowed = Array.isArray(item.recallChannels) && item.recallChannels.length ? item.recallChannels : null
    const can = (id) => use(id) && (!allowed || allowed.includes(id))
    const strength = item.strength ?? decayedStrength(item, now)
    if (strength <= 0) continue

    const haystack = [item.text, item.target, item.source, ...facetValues(item.facets)].filter(Boolean).join(' ')
    const why = []
    let sem = 0
    let emo = 0
    let sal = 0
    let rec = 0
    let ctx = 0

    if (can('R1') && cueTokens.length) {
      sem = overlapScore(cueTokens, haystack)
      if (sem > R1_MIN) why.push(`R1:cued_by=${cueTokens.find((t) => haystack.toLowerCase().includes(t)) ?? cueTokens[0]}`)
    }
    if (target && String(item.target ?? '') === target) sem = Math.min(1, sem + 0.5)

    if (can('R2') && moodKeys.length && item.affect && Object.keys(item.affect).length) {
      emo = cosine(mood, item.affect)
      if (emo > R2_MIN) {
        const top = Object.keys(item.affect).sort((a, b) => item.affect[b] - item.affect[a])[0]
        why.push(`R2:mood_congruent=${top}`)
      }
    }

    if (can('R3')) {
      rec = recencyScore(item, now)
      if (earliest.get(`${item.source ?? ''}|${item.kind ?? ''}`) === item) {
        rec = Math.min(1, rec + 0.15)
        if (rec > 0.5) why.push('R3:first_time')
      } else if (rec > 0.6) {
        why.push('R3:recent')
      }
    }

    if (can('R4')) {
      const importance = Number(item.importance) || 0
      const arousal = Number(item.arousal) || 0
      if (importance >= SALIENCE_GATE || arousal >= AROUSAL_GATE) {
        sal = Math.max(importance, arousal)
        why.push(`R4:salient=${sal.toFixed(2)}`)
      } else {
        sal = importance * 0.5
      }
    }

    if (can('R5')) {
      const who = Array.isArray(item.facets?.who) ? item.facets.who : []
      if (scene && (item.source === scene || item.facets?.scene === scene)) {
        ctx = Math.max(ctx, 0.7)
        why.push(`R5:scene=${scene}`)
      }
      const hit = participants.find((p) => p === item.target || who.includes(p))
      if (hit) {
        ctx = 1
        why.push(`R5:participant=${hit}`)
      }
    }

    let score =
      weights.sem * sem +
      weights.emo * emo +
      weights.sal * sal +
      weights.rec * rec +
      weights.reh * rehearsalScore(item.rehearsal) +
      weights.src * (Number(item.confidence) || 0.75) +
      weights.ctx * ctx

    // With a clear cue, semantics must dominate; otherwise recency+scene beat relevance.
    if (cueTokens.length) score *= 0.35 + 0.65 * sem
    score *= 0.5 + 0.5 * strength

    if (can('R8') && allowPartial && cueTokens.length) {
      const overlap = overlapScore(cueTokens, haystack)
      if (overlap >= PARTIAL_MIN && overlap < PARTIAL_MAX && score < 0.35) {
        partials.push({
          id: item.id,
          kind: item.kind,
          layer: item.layer,
          hint: makeHint(item, cueTokens),
          overlap: round2(overlap),
          note: '我好像记得有这么件事，但细节想不全了',
        })
      }
    }

    if (score <= 0.02 || why.length === 0) continue
    scored.push(toResult(item, score, why, strength))
  }

  scored.sort((a, b) => b.score - a.score)

  // R6: after the head is chosen, adjacent events get one chain bonus each.
  const chained = []
  if (use('R6')) {
    const head = scored.slice(0, Math.max(1, topK))
    const applied = new Set()
    for (const anchorResult of head) {
      const anchor = items.find((item) => item.id === anchorResult.id)
      if (!anchor || !Number.isFinite(anchor.ts)) continue
      for (const item of items) {
        if (!item || item.suppressed || item.id === anchor.id) continue
        if (item.kind !== 'event' || (item.source ?? '') !== (anchor.source ?? '')) continue
        if (!Number.isFinite(item.ts)) continue
        const gap = Math.abs(item.ts - anchor.ts) / 60000
        if (gap <= 0 || gap > CHAIN_WINDOW_MIN) continue
        const allowed = Array.isArray(item.recallChannels) && item.recallChannels.length ? item.recallChannels : null
        if (allowed && !allowed.includes('R6')) continue
        const bonus = CHAIN_BONUS * (1 - gap / CHAIN_WINDOW_MIN)
        const existing = scored.find((r) => r.id === item.id)
        if (existing) {
          if (!applied.has(existing.id)) {
            existing.score = round3(Math.min(1, existing.score + bonus))
            applied.add(existing.id)
          }
          if (!existing.why.includes('R6:chain')) existing.why.push('R6:chain')
        } else if (!chained.some((c) => c.id === item.id)) {
          chained.push(toResult(item, bonus, ['R6:chain'], decayedStrength(item, now)))
        }
      }
    }
    scored.sort((a, b) => b.score - a.score)
  }

  // R7: no cue at all — sometimes something salient just surfaces.
  if (use('R7') && !hasCue && rng() < SPONTANEOUS_PROB) {
    const pool = items.filter((item) => {
      if (!item || item.suppressed) return false
      const allowed = Array.isArray(item.recallChannels) && item.recallChannels.length ? item.recallChannels : null
      if (allowed && !allowed.includes('R7')) return false
      return (Number(item.importance) || 0) >= SALIENCE_GATE || (Number(item.arousal) || 0) >= AROUSAL_GATE
    })
    if (pool.length) {
      const picked = pool[Math.floor(rng() * pool.length) % pool.length]
      if (!scored.some((r) => r.id === picked.id)) {
        scored.push(toResult(picked, 0.3, ['R7:spontaneous'], decayedStrength(picked, now)))
        scored.sort((a, b) => b.score - a.score)
      }
    }
  }

  const recalled = scored.slice(0, Math.max(1, topK))
  for (const item of chained.slice(0, 2)) {
    if (!recalled.some((r) => r.id === item.id)) recalled.push(item)
  }
  recalled.sort((a, b) => b.score - a.score)
  partials.sort((a, b) => b.overlap - a.overlap)

  return {
    recalled,
    partialHits: allowPartial ? partials.slice(0, 3) : [],
    notFound: recalled.length === 0,
    debug: { cueTokens, participants, scene, considered: items.length, channels: Object.keys(RECALL_CHANNELS).filter(use) },
  }
}

function toResult(item, score, why, strength) {
  return {
    id: item.id,
    kind: item.kind,
    layer: item.layer,
    text: item.text,
    score: round3(score),
    why: [...why],
    strength: round2(strength),
    fidelity: Number(item.fidelity ?? 1),
    uncertain: Number(item.fidelity ?? 1) < 0.7,
    rehearsal: Number(item.rehearsal) || 0,
    eventRefs: item.eventRefs ?? [],
  }
}

function facetValues(facets) {
  if (!facets || typeof facets !== 'object') return []
  const out = []
  for (const value of Object.values(facets)) {
    if (Array.isArray(value)) out.push(...value.map(String))
    else if (value != null) out.push(String(value))
  }
  return out
}

function cosine(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  let dot = 0
  let na = 0
  let nb = 0
  for (const key of keys) {
    const x = Number(a?.[key]) || 0
    const y = Number(b?.[key]) || 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function makeHint(item, cueTokens) {
  const hit = cueTokens.filter((t) => String(item.text ?? '').toLowerCase().includes(t))
  const label = item.target ? `${item.target}·` : ''
  if (!hit.length) return `${label}${String(item.text ?? '').slice(0, 12)}…`
  return `${label}关于「${hit.slice(0, 2).join('、')}」的那件事`
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}
