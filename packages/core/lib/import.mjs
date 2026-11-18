/** One-way text import: parse, fingerprint, and mark as low-provenance. */

import { createHash } from 'node:crypto'

export function fingerprint(source, text) {
  return createHash('sha1').update(`${source}|${String(text).trim()}`).digest('hex').slice(0, 16)
}

export function parseImport({ format, text }) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  if (body.trim() === '') return []
  if (format === 'markdown') return splitMarkdown(body)
  if (format === 'jsonl') return splitJsonl(body)
  if (format === 'plain') return splitPlain(body)
  throw new RangeError(`未知导入格式: ${format}`)
}

export function prepareImport({ format, source, text, ts = null, tags = [] }) {
  if (typeof source !== 'string' || source === '') throw new RangeError('import.source 必填')
  return parseImport({ format, text }).map((segment) => ({
    key: fingerprint(source, segment.text),
    kind: 'fact',
    layer: 'L3',
    source: 'import',
    origin: source,
    text: segment.text,
    ts: segment.ts ?? ts,
    tags: [...tags, ...(segment.tags ?? [])],
    eventRefs: [],
    drivesAction: false,
  }))
}

function splitMarkdown(body) {
  const byHeading = body.split(/^##\s+/m).map((part) => part.trim())
  if (byHeading.length > 1) {
    const preamble = byHeading.shift().replace(/^#\s+.*$/m, '').trim()
    if (preamble) byHeading.unshift(preamble)
    return byHeading.filter(Boolean).map((text) => ({ text }))
  }
  const bySection = body.split('§').map((part) => part.trim()).filter(Boolean)
  if (bySection.length > 1) return bySection.map((text) => ({ text }))
  return splitPlain(body)
}

function splitJsonl(body) {
  const out = []
  const lines = body.split('\n')
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new RangeError(`jsonl 第 ${index + 1} 行不是合法 JSON: ${error.message}`)
    }
    const text = typeof parsed === 'string' ? parsed : parsed?.text
    if (typeof text !== 'string' || text.trim() === '') {
      throw new RangeError(`jsonl 第 ${index + 1} 行缺少 text`)
    }
    out.push({
      text: text.trim(),
      ts: Number.isFinite(parsed?.ts) ? parsed.ts : null,
      tags: Array.isArray(parsed?.tags) ? parsed.tags : [],
    })
  })
  return out
}

function splitPlain(body) {
  return body.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).map((text) => ({ text }))
}
