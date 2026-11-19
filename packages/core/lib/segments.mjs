/** Turn scored memory rows into a few narrow time segments; no segment may cover the whole store. */

import { localStamp } from './round.mjs'
import { overlapScore, tokenizeCue } from './text.mjs'

export const SEGMENT_PARAMS = Object.freeze({
  topK: 12,
  gapMs: 6 * 3600 * 1000,
  padMs: 3 * 3600 * 1000,
  maxSegments: 3,
})

export function meanSd(values) {
  const list = values.filter(Number.isFinite)
  if (list.length === 0) return { mean: 0, sd: 0 }
  const mean = list.reduce((sum, value) => sum + value, 0) / list.length
  const variance = list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / list.length
  return { mean, sd: Math.sqrt(variance) }
}

export function buildEmbedSegments({
  hits,
  mean = 0,
  sd = 0,
  key,
  minConfidence,
  maxSegmentDays,
  tzOffsetMinutes,
  now,
}) {
  return buildSegments({
    hits,
    key,
    minConfidence,
    maxSegmentDays,
    tzOffsetMinutes,
    now,
    confidence: (score, lexical) => embedConfidence(score, mean, sd, lexical),
  })
}

export function buildLexicalSegments({
  rows,
  key,
  minConfidence,
  maxSegmentDays,
  tzOffsetMinutes,
  now,
}) {
  const tokens = tokenizeCue(key)
  const hits = rows
    .map((row) => ({ ...row, score: overlapScore(tokens, row.text) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || right.ts - left.ts)
    .slice(0, SEGMENT_PARAMS.topK)
  return buildSegments({
    hits,
    key,
    minConfidence,
    maxSegmentDays,
    tzOffsetMinutes,
    now,
    confidence: (score) => Math.min(0.7, 0.15 + 0.65 * score),
  })
}

function buildSegments({ hits, key, minConfidence, maxSegmentDays, tzOffsetMinutes, now, confidence }) {
  const maxMs = Math.max(1, Number(maxSegmentDays) || 1) * 86400000
  const tokens = tokenizeCue(key)
  const segments = []
  for (const cluster of clusterHits(hits)) {
    const windowed = clipHits(cluster, Math.max(1, maxMs - 2 * SEGMENT_PARAMS.padMs))
    if (windowed.length === 0) continue
    const top = [...windowed].sort((left, right) => right.score - left.score)[0]
    const first = Math.min(...windowed.map((row) => row.ts))
    const last = Math.max(...windowed.map((row) => row.ts))
    const from = Math.max(0, first - SEGMENT_PARAMS.padMs)
    const to = Math.min(now, last + SEGMENT_PARAMS.padMs)
    if (to < from) continue
    const lexical = Math.max(...windowed.map((row) => overlapScore(tokens, row.text)))
    const score = confidence(top.score, lexical)
    if (!Number.isFinite(score) || score < minConfidence) continue
    segments.push({
      from,
      to,
      label: `${localStamp(from, tzOffsetMinutes)} · ${String(top.text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60)}`,
      confidence: Number(score.toFixed(3)),
    })
  }
  segments.sort((left, right) => right.confidence - left.confidence)
  return { segments: segments.slice(0, SEGMENT_PARAMS.maxSegments) }
}

function clusterHits(hits) {
  const sorted = [...hits].filter((row) => Number.isFinite(row.ts)).sort((left, right) => left.ts - right.ts)
  const clusters = []
  let current = []
  let last = null
  for (const hit of sorted) {
    if (last != null && hit.ts - last > SEGMENT_PARAMS.gapMs) {
      clusters.push(current)
      current = []
    }
    current.push(hit)
    last = hit.ts
  }
  if (current.length > 0) clusters.push(current)
  return clusters
}

function clipHits(hits, maxMs) {
  if (hits.length <= 1) return hits
  const sorted = [...hits].sort((left, right) => left.ts - right.ts)
  const span = sorted[sorted.length - 1].ts - sorted[0].ts
  if (span <= maxMs) return sorted
  let best = null
  for (let start = 0; start < sorted.length; start += 1) {
    const window = []
    let score = 0
    for (let end = start; end < sorted.length && sorted[end].ts - sorted[start].ts <= maxMs; end += 1) {
      window.push(sorted[end])
      score += sorted[end].score
    }
    if (best == null || window.length > best.window.length || (window.length === best.window.length && score > best.score)) {
      best = { window, score }
    }
  }
  return best?.window ?? sorted
}

function embedConfidence(score, mean, sd, lexical) {
  const absolute = clamp01((score - 0.22) / 0.33)
  const z = sd > 0.015 ? (score - mean) / sd : 0
  const margin = clamp01(z / 3)
  return clamp01(0.45 * absolute + 0.35 * margin + 0.2 * clamp01(lexical))
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
