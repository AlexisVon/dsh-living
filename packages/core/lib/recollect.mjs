/** Slow, explicit recollection: a tool-using subagent turns a natural-language question into a grounded answer. */

import { EMBED_DEFAULTS } from './embed.mjs'
import { localStamp } from './round.mjs'

export const RECOLLECT_DEFAULTS = Object.freeze({
  timeoutMs: 120_000,
  maxScans: 8,
  maxRows: 40,
  horizonDays: 30,
  maxEvidence: 12,
  fallbackDays: EMBED_DEFAULTS.fallbackDays,
})

export const RECOLLECT_MODES = Object.freeze(['lookup', 'timeline'])
export const RECOLLECT_DETAILS = Object.freeze(['brief', 'full'])
export const RECOLLECT_SOURCES = Object.freeze(['events', 'journal', 'items'])
export const RECOLLECT_EVENT_KINDS = Object.freeze(['message', 'notice', 'change', 'agent_mark', 'import'])

export const MEMORY_TOOL_NAMES = Object.freeze([
  'living_memory_segments',
  'living_memory_overview',
  'living_memory_scan',
  'living_memory_get',
])

export const RECOLLECT_PRESET_PLUGINS = Object.freeze([
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix: '你是回想检索器。只使用给定的记忆工具；不写、不发、不做决定，只把查到的证据整理成答案。' },
  },
])

const SOURCE_SET = new Set(RECOLLECT_SOURCES)
const MODE_SET = new Set(RECOLLECT_MODES)
const DETAIL_SET = new Set(RECOLLECT_DETAILS)
const CONFIDENCE_SET = new Set(['high', 'medium', 'low'])

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

export function normalizeRecollectArgs(input = {}) {
  const question = clip(input.question, 2000)
  if (question === '') throw new RangeError('recollect.question 必填')
  const mode = input.mode == null ? 'lookup' : String(input.mode)
  if (!MODE_SET.has(mode)) throw new RangeError(`recollect.mode 只能是 ${RECOLLECT_MODES.join('/')}`)
  const detail = input.detail == null ? 'brief' : String(input.detail)
  if (!DETAIL_SET.has(detail)) throw new RangeError(`recollect.detail 只能是 ${RECOLLECT_DETAILS.join('/')}`)
  return {
    question,
    cue: clip(input.cue, 500),
    mode,
    detail,
  }
}

export function buildRecollectPrompt({
  question,
  cue = '',
  mode = 'lookup',
  detail = 'brief',
  now = Date.now(),
  tzOffsetMinutes = -new Date().getTimezoneOffset(),
  maxScans = RECOLLECT_DEFAULTS.maxScans,
  maxRows = RECOLLECT_DEFAULTS.maxRows,
  fallbackDays = RECOLLECT_DEFAULTS.fallbackDays,
  minConfidence = EMBED_DEFAULTS.minConfidence,
  maxSegmentDays = EMBED_DEFAULTS.maxSegmentDays,
} = {}) {
  const evidenceText = detail === 'full'
    ? '证据可带 text（原文片段，最多 1200 字）'
    : '证据只带 source/id/ts，不带 text'
  return [
    '你负责“回想”：用只读记忆工具回答下面的问题。',
    `当前时间：${localStamp(now, tzOffsetMinutes)}（UTC${tzOffsetMinutes >= 0 ? '+' : ''}${tzOffsetMinutes / 60}）`,
    `模式：${mode}（lookup = 围绕问题找；timeline = 从现在往前重建时间线）`,
    `细节：${detail}（${evidenceText}）`,
    `兜底范围：最近 ${fallbackDays} 天；区段预测不可用或为空时只扫这里。`,
    `区段预测：最多 3 段，每段不超过 ${maxSegmentDays} 天；置信度低于 ${minConfidence} 的段不会返回。`,
    '',
    '## 问题',
    question,
    ...(cue ? ['', '## 线索', cue] : []),
    '',
    '## 步骤',
    '1. 先调 living_memory_segments，key 用“问题 + 线索”；它可能返回 0–3 段。',
    '2. 有段：对每段用 living_memory_scan 的 from/to 扫描，在段内找证据。',
    '3. 段为空、工具失败，或段内找不到：改扫最近 fallbackDays 天。',
    '4. 不要扫区段以外，除非走兜底。',
    '',
    '## 工具',
    '- living_memory_segments：按语义预测时间区段；返回 from/to/label/confidence；可能为空。',
    '- living_memory_overview：库的计数与时间范围。',
    '- living_memory_scan：按 ts 倒序扫描；用 from/to 限定区段，before 作游标；每次最多 ' + String(maxRows) + ' 条。',
    '- living_memory_get：展开单条，返回相邻条目；detail=full 时可用 raw=true 展开证据原文。',
    `- 最多 ${maxScans} 次 scan；超过会被工具拒绝。`,
    '',
    '## 规则',
    '- 只依据工具返回的内容回答；工具没给的内容不许补。',
    '- 一个答案可以综合多条证据；证据必须带 source/id/ts。',
    '- 找不到就失败：ok=false，primary/backup=null，summary 写清扫到哪。',
    '- backup 是第二个可信候选，不是硬凑的备胎；没有就 null。',
    '- 不写记忆、不发消息、不做决定；不读取凭据或会话文件。',
    '',
    '## 输出',
    '只输出一个 JSON 对象，不要代码围栏、不要解释：',
    '{',
    '  "ok": true,',
    '  "summary": "总的回想总结",',
    '  "primary": { "answer": "主答案", "confidence": "high|medium|low", "evidence": [{ "source": "events|journal|items", "id": "...", "ts": 0 }] },',
    '  "backup": null',
    '}',
  ].join('\n')
}

export function parseRecollectResult(text, { detail = 'brief' } = {}) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('回想输出不是 JSON')
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    throw new Error(`回想输出 JSON 解析失败: ${error.message}`)
  }
  const summary = clip(parsed?.summary, 4000)
  if (summary === '') throw new Error('回想缺少 summary')
  if (parsed?.ok === false) return { ok: false, summary, primary: null, backup: null }
  const primary = normalizeAnswer(parsed?.primary, detail)
  if (!primary) throw new Error('回想标记成功但没有主答案')
  return { ok: true, summary, primary, backup: normalizeAnswer(parsed?.backup, detail) }
}

export function recollectFailure({ error, scanned, gaps = [], tokens = 0 }) {
  return {
    ok: false,
    error: String(error ?? 'recollect_failed'),
    summary: `回想失败：${String(error ?? 'recollect_failed')}`,
    primary: null,
    backup: null,
    scanned,
    gaps,
    usage: { tokens },
  }
}

function normalizeAnswer(value, detail) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('回想答案必须是对象')
  const answer = clip(value.answer, 6000)
  if (answer === '') throw new Error('回想答案缺少 answer')
  const confidence = CONFIDENCE_SET.has(value.confidence) ? value.confidence : null
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.slice(0, RECOLLECT_DEFAULTS.maxEvidence).map((row) => normalizeEvidence(row, detail)).filter(Boolean)
    : []
  if (evidence.length === 0) throw new Error('回想答案没有证据')
  return { answer, confidence, evidence }
}

function normalizeEvidence(row, detail) {
  if (!row || typeof row !== 'object') return null
  const source = String(row.source ?? '')
  if (!SOURCE_SET.has(source)) return null
  const id = clip(row.id, 200)
  if (id === '') return null
  const ts = Number(row.ts)
  if (!Number.isFinite(ts)) return null
  const text = detail === 'full' ? clip(row.text, 1200) : ''
  return { source, id, ts, ...(text ? { text } : {}) }
}
