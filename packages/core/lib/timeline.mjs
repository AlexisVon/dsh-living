/** Unified day/24h timeline: rounds, events, raw captures and outbound sends. */

export const TIMELINE_CATEGORIES = Object.freeze(['grid', 'message', 'round', 'memory', 'persona', 'sleep', 'system', 'outbound', 'agent'])

const EVENT_CATEGORIES = {
  message: 'message',
  notice: 'message',
  change: 'message',
  auto_grid: 'grid',
  auto_hit: 'grid',
  agent_mark: 'agent',
  consolidation: 'sleep',
  context_guard: 'system',
  memory_extracted: 'memory',
  memory_extract_failed: 'memory',
  memory_extract_skipped: 'memory',
  session_handoff: 'memory',
  session_handoff_failed: 'memory',
  persona_evolved: 'persona',
  persona_evolve_failed: 'persona',
  persona_evolve_skipped: 'persona',
  outbound_decision: 'outbound',
  outbound_approved: 'outbound',
  outbound_rejected: 'outbound',
  budget_exhausted: 'system',
  budget_resumed: 'system',
  budget_reset: 'system',
  round_suppressed: 'system',
  round_resumed: 'system',
  schedule_missed: 'system',
}

function clip(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function eventTitle(event) {
  const payload = event.payload ?? {}
  if (event.kind === 'auto_grid') {
    return `网格 ${payload.window ?? '?'} · ${payload.className ?? ''} · λ${payload.lambda ?? '?'}`
  }
  if (event.kind === 'auto_hit') {
    return `自动命中 ${payload.window ?? '?'} · p=${Number(payload.p ?? 0).toFixed(3)}`
  }
  if (event.kind === 'agent_mark') return `自写节点${payload.tag ? ` · ${payload.tag}` : ''}`
  if (event.kind === 'consolidation') return `整理 · ${payload.kind ?? '?'}`
  if (event.kind === 'memory_extracted') return `记忆整理 · ${payload.items ?? 0} 条 / ${payload.edges ?? 0} 边${payload.fallback ? ' · fallback' : ''}`
  if (event.kind === 'session_handoff') return '会话交接'
  if (event.kind === 'context_guard') return '上下文保险'
  if (event.kind === 'persona_evolved') return '人格演化'
  if (event.kind === 'outbound_decision') return `外发 · ${payload.decision ?? '?'}`
  if (event.kind === 'message' || event.kind === 'notice' || event.kind === 'change') {
    return clip(payload.text || payload.meta?.text || event.kind, 120)
  }
  return clip(payload.text || event.kind, 120)
}

function eventText(event) {
  const payload = event.payload ?? {}
  if (event.kind === 'agent_mark') return clip(payload.text, 500)
  if (event.kind === 'auto_grid') return `${payload.mode ?? ''} · ${payload.sigmaRatio ?? ''}`
  if (event.kind === 'auto_hit') return `点 ${payload.pointIndex ?? '?'} · ${payload.mode ?? ''}`
  return clip(payload.reason || payload.error || payload.text || '', 300)
}

export function buildTimeline({ store, since = null, until = null, limit = 500 } = {}) {
  if (!store) throw new RangeError('timeline 需要 store')
  const cap = Math.max(1, Math.min(5000, Number(limit) || 500))
  const items = []

  for (const round of store.listRounds({ since, until, limit: cap })) {
    items.push({
      id: `round:${round.roundId}`,
      ts: round.startedAt,
      category: round.trigger === 'night' ? 'sleep' : 'round',
      kind: 'round',
      title: round.trigger ?? 'round',
      text: round.outcome ?? 'open',
      detail: round,
    })
  }

  for (const event of store.listEvents({ since, until, limit: cap, order: 'desc' })) {
    if (event.kind === 'round') continue
    const category = EVENT_CATEGORIES[event.kind] ?? 'system'
    items.push({
      id: `event:${event.id}`,
      ts: event.ts,
      category,
      kind: event.kind,
      title: eventTitle(event),
      text: eventText(event),
      detail: event,
    })
  }

  for (const raw of store.listRawSegments({ limit: cap })) {
    if (Number.isFinite(since) && raw.createdAt < since) continue
    if (Number.isFinite(until) && raw.createdAt > until) continue
    items.push({
      id: `raw:${raw.id}`,
      ts: raw.createdAt,
      category: 'memory',
      kind: 'raw',
      title: `raw ${raw.kind} · ${raw.status}`,
      text: `${raw.payload?.messages?.length ?? 0} 条消息${raw.lastError ? ` · ${raw.lastError}` : ''}`,
      detail: raw,
    })
  }

  for (const outbox of store.listOutbox({ limit: cap })) {
    const ts = outbox.ackedAt ?? outbox.failedAt ?? outbox.claimedAt ?? outbox.createdAt
    if (!Number.isFinite(ts)) continue
    if (Number.isFinite(since) && ts < since) continue
    if (Number.isFinite(until) && ts > until) continue
    const status = outbox.ackedAt ? 'sent' : outbox.failedAt ? 'failed' : outbox.decision === 'review' ? 'review' : 'pending'
    items.push({
      id: `outbox:${outbox.id}`,
      ts,
      category: 'outbound',
      kind: 'outbox',
      title: `外发 · ${outbox.gem} · ${status}`,
      text: clip(outbox.text, 160),
      detail: outbox,
    })
  }

  items.sort((left, right) => left.ts - right.ts)
  return items.slice(-cap)
}
