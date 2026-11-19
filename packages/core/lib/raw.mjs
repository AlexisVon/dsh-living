/** Raw session segments: semi-normalized transcript snapshots taken at rest/sleep. */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionFile } from './observe.mjs'

export const RAW_MAX_MESSAGES = 200
export const RAW_MESSAGE_CHARS = 4000
export const RAW_TOTAL_CHARS = 60000

export function findSessionFile(sessionRoot, sessionId) {
  if (!sessionRoot || !sessionId || !existsSync(sessionRoot)) return null
  let entries = []
  try {
    entries = readdirSync(sessionRoot, { recursive: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const name = String(entry)
    if (!name.endsWith('.jsonl.zstd') || !name.includes(sessionId)) continue
    return join(sessionRoot, name)
  }
  return null
}

function textBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

function reasoningBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'reasoning')
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

/** Strip L0/situation scaffolding; keep only the round's actual new events. */
function promptEvents(text) {
  const marker = '## 新事件'
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const rest = text.slice(start + marker.length)
  const next = rest.indexOf('\n## ')
  return (next >= 0 ? rest.slice(0, next) : rest).trim()
}

/** Session events → compact message records. Unknown event types are ignored. */
export function sessionMessages(events) {
  const messages = []
  const skippedCalls = new Set()
  for (const event of events ?? []) {
    const ts = Number(event?.time ?? event?.createdAt ?? 0)
    const data = event?.data ?? {}
    if (event?.type === 'user/message') {
      if (data?.source?.kind === 'time-context') continue
      const text = textBlocks(data.content)
      if (!text) continue
      if (text.includes('## 新事件')) {
        const eventsText = promptEvents(text)
        if (eventsText) messages.push({ role: 'event', ts, text: eventsText })
        continue
      }
      if (/^## (你记得的事|上一段会话交接|现在|本轮)/.test(text)) continue
      messages.push({ role: 'user', ts, text })
    } else if (event?.type === 'assistant/message') {
      const text = textBlocks(data?.message?.content)
      const reasoning = reasoningBlocks(data?.message?.content)
      if (text || reasoning) messages.push({ role: 'assistant', ts, text, ...(reasoning ? { reasoning } : {}) })
    } else if (event?.type === 'tool/call') {
      const name = String(data?.name ?? 'tool')
      const callId = String(data?.callId ?? '')
      if (name === 'living_journal' || name === 'living_mark') {
        if (callId) skippedCalls.add(callId)
        continue
      }
      messages.push({ role: 'tool_call', ts, name, text: String(data?.arguments ?? '') })
    } else if (event?.type === 'tool/result') {
      const callId = String(data?.callId ?? data?.toolCallId ?? data?.message?.source?.callId ?? '')
      if (skippedCalls.has(callId)) continue
      messages.push({
        role: 'tool_result',
        ts,
        text: textBlocks(data?.message?.content),
        isError: data?.message?.isError === true,
      })
    }
  }
  return messages.filter((message) => message.text || message.reasoning || message.name)
}

function clipMessages(messages) {
  const out = []
  let total = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const clip = (value) => String(value ?? '').slice(0, RAW_MESSAGE_CHARS)
    const next = {
      ...message,
      text: clip(message.text),
      ...(message.reasoning ? { reasoning: clip(message.reasoning) } : {}),
    }
    const cost = `${next.text ?? ''}${next.reasoning ?? ''}${next.name ?? ''}`.length + 80
    if (out.length >= RAW_MAX_MESSAGES || total + cost > RAW_TOTAL_CHARS) break
    out.push(next)
    total += cost
  }
  return out.reverse()
}

/**
 * Build one raw segment. Prefer the session transcript; fall back to the event
 * ledger when the session file is absent (tests, dev, or a rotated-away file).
 */
export function buildRawSegment({ sessionId = null, sessionRoot = null, kind, nowMs = Date.now(), events = [] } = {}) {
  const file = findSessionFile(sessionRoot, sessionId)
  let messages = []
  let source = 'events'
  if (file) {
    try {
      messages = sessionMessages(readSessionFile(file))
      source = 'session'
    } catch {
      messages = []
    }
  }
  if (messages.length === 0) {
    messages = (events ?? []).map((event) => ({
      role: 'event',
      ts: Number(event.ts) || nowMs,
      kind: event.kind,
      source: event.source ?? null,
      actor: event.actor ?? null,
      text: String(event.payload?.text ?? JSON.stringify(event.payload ?? {})).slice(0, 1200),
    }))
  }
  messages = clipMessages(messages)
  if (messages.length === 0) return null
  const tsStart = messages[0].ts || nowMs
  const tsEnd = messages[messages.length - 1].ts || nowMs
  return {
    id: `raw_${sessionId || `${kind}_${nowMs}`}`,
    sessionId,
    kind,
    tsStart,
    tsEnd,
    payload: { source, messages },
  }
}
