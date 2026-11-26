/**
 * Observability: adapters map source logs to one record shape; the daily report
 * is frozen to disk because sessions and gem logs rotate.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dayKey } from './clock.mjs'
import { shiftDay } from './notes.mjs'
import { buildTimeline } from './timeline.mjs'

const DAY_MS = 86400000

/** Unified record: adapters map, never judge. */
export function sessionRecords(events) {
  const out = []
  for (const event of events) {
    const ts = Number(event.time ?? event.createdAt ?? 0)
    if (event.type === 'session') {
      out.push({ ts, source: 'session', kind: 'session', summary: `preset=${event.agentPreset ?? '—'} cwd=${event.cwd ?? ''}`, ref: event.id ?? null })
    } else if (event.type === 'turn/start') {
      out.push({ ts, source: 'session', kind: 'turn_start', summary: `turn ${event.data?.turn ?? '?'}`, ref: null })
    } else if (event.type === 'turn/end') {
      out.push({ ts, source: 'session', kind: 'turn_end', summary: `turn ${event.data?.turn ?? '?'} ${event.data?.reason?.kind ?? ''}`.trim(), ref: null })
    } else if (event.type === 'tool/call') {
      out.push({ ts, source: 'session', kind: 'tool_call', summary: String(event.data?.name ?? 'tool'), ref: event.data?.callId ?? null })
    } else if (event.type === 'assistant/message' && (event.data?.usage || event.data?.message?.usage)) {
      const u = event.data.usage ?? event.data.message.usage
      out.push({
        ts,
        source: 'session',
        kind: 'usage',
        summary: `in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0} cacheRead=${u.cacheReadTokens ?? 0}`,
        ref: null,
        tokens: {
          input: u.inputTokens ?? 0,
          output: u.outputTokens ?? 0,
          cacheRead: u.cacheReadTokens ?? 0,
          total: u.totalTokens ?? 0,
        },
      })
    }
  }
  return out
}

export function readSessionFile(file) {
  const buf = file.endsWith('.zstd') ? zstdDecompressSync(readFileSync(file)) : readFileSync(file)
  const events = []
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A truncated tail is not a reason to lose the whole file.
    }
  }
  return events
}

export function readJsonlFile(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // Ignore malformed lines; the source stays the authority.
    }
  }
  return out
}

export function dayRange(date, tzOffsetMinutes) {
  const start = Date.parse(`${date}T00:00:00Z`) - tzOffsetMinutes * 60000
  return [start, start + DAY_MS]
}

export function buildDailyReport({ store, date, tzOffsetMinutes = 0, records = [], now = Date.now() }) {
  const [start, end] = dayRange(date, tzOffsetMinutes)
  const rounds = store.listRounds({ since: start, until: end - 1, limit: 10000 })
  const events = store.listEvents({ since: start, until: end - 1, limit: 100000 })
  const visibleRecords = records.filter((record) => record.ts >= start && record.ts < end)

  const rhythm = Array.from({ length: 24 }, (_, hour) => ({ hour, rounds: 0 }))
  const triggers = {}
  const outcomes = {}
  const toolCalls = {}
  const cost = Array.from({ length: 24 }, (_, hour) => ({ hour, input: 0, output: 0, cacheRead: 0, total: 0 }))
  const anomalies = []

  for (const round of rounds) {
    const hour = localHour(round.startedAt, tzOffsetMinutes)
    rhythm[hour].rounds += 1
    triggers[round.trigger ?? 'unknown'] = (triggers[round.trigger ?? 'unknown'] ?? 0) + 1
    outcomes[round.outcome ?? 'open'] = (outcomes[round.outcome ?? 'open'] ?? 0) + 1
    if (round.outcome === 'error' || round.errorCode) {
      anomalies.push({ kind: 'round_error', at: round.startedAt, roundId: round.roundId, errorCode: round.errorCode ?? 'unknown' })
    }
  }

  const outbound = { decisions: 0, send: 0, review: 0, block: 0, limiterPass: 0, limiterBlock: 0, limiterMissing: 0, limiterPassRate: null }
  let passStreak = 0
  for (const event of events) {
    if (event.kind === 'schedule_missed') {
      anomalies.push({ kind: 'schedule_missed', at: event.ts, roundId: null, errorCode: null, detail: event.payload })
      continue
    }
    if (event.kind !== 'outbound_decision') continue
    const payload = event.payload ?? {}
    outbound.decisions += 1
    if (payload.decision === 'send') outbound.send += 1
    else if (payload.decision === 'review') outbound.review += 1
    else if (payload.decision === 'block') {
      outbound.block += 1
      anomalies.push({
        kind: 'outbound_blocked',
        at: event.ts,
        roundId: null,
        errorCode: payload.ruleId ?? payload.verdictSource ?? 'rule',
        detail: { outboxId: payload.outboxId ?? null, gem: payload.gem ?? null, reason: payload.reason ?? null },
      })
    }
    if (payload.limiter === 'pass') {
      outbound.limiterPass += 1
      passStreak += 1
      if (passStreak === 5) {
        anomalies.push({
          kind: 'limiter_pass_streak',
          at: event.ts,
          roundId: null,
          errorCode: null,
          detail: { count: passStreak },
        })
      }
    } else if (payload.limiter === 'block') {
      outbound.limiterBlock += 1
      passStreak = 0
    } else if (payload.limiter === 'missing') {
      outbound.limiterMissing += 1
      passStreak = 0
    }
  }
  const limiterAttempts = outbound.limiterPass + outbound.limiterBlock + outbound.limiterMissing
  outbound.limiterPassRate = limiterAttempts > 0 ? outbound.limiterPass / limiterAttempts : null

  let tokensIn = 0
  let tokensOut = 0
  let cacheRead = 0
  for (const record of visibleRecords) {
    if (record.kind === 'tool_call') {
      toolCalls[record.summary] = (toolCalls[record.summary] ?? 0) + 1
      continue
    }
    if (record.kind !== 'usage' || !record.tokens) continue
    const hour = localHour(record.ts, tzOffsetMinutes)
    cost[hour].input += record.tokens.input
    cost[hour].output += record.tokens.output
    cost[hour].cacheRead += record.tokens.cacheRead
    cost[hour].total += record.tokens.total
    tokensIn += record.tokens.input
    tokensOut += record.tokens.output
    cacheRead += record.tokens.cacheRead
  }

  const notes = typeof store.noteStats === 'function'
    ? store.noteStats({ day: date, yesterday: shiftDay(date, -1) })
    : null
  const report = {
    date,
    generatedAt: now,
    summary: {
      rounds: rounds.length,
      successful: rounds.filter((round) => round.outcome === 'ok').length,
      failed: rounds.filter((round) => round.outcome === 'error').length,
      missedSchedules: anomalies.filter((item) => item.kind === 'schedule_missed').length,
      events: events.length,
      tokensIn,
      tokensOut,
      cacheRead,
      sessions: visibleRecords.filter((record) => record.kind === 'session').length,
      outbound,
      notes,
    },
    rhythm,
    actions: { triggers, outcomes, toolCalls },
    cost,
    anomalies,
    timeline: buildTimeline({ store, since: start, until: end - 1, limit: 500 })
      .map(({ detail, ...item }) => item),
  }
  report.markdown = renderReportMarkdown(report)
  return report
}

export function renderReportMarkdown(report) {
  const s = report.summary ?? {}
  const outbound = s.outbound ?? {}
  const lines = [
    `# Living 日报 · ${report.date}`,
    '',
    `生成于 ${new Date(report.generatedAt).toLocaleString()}。`,
    '',
    '## 概览',
    '',
    `- 轮次：${s.rounds ?? 0}（成功 ${s.successful ?? 0} / 失败 ${s.failed ?? 0}）`,
    `- 事件：${s.events ?? 0} · 错过日程：${s.missedSchedules ?? 0}`,
    `- Token：输入 ${s.tokensIn ?? 0} / 输出 ${s.tokensOut ?? 0} / 缓存读 ${s.cacheRead ?? 0}`,
    `- 外发决策：${outbound.decisions ?? 0}（拦 ${outbound.block ?? 0}）· 判决 pass 率 ${outbound.limiterPassRate == null ? '—' : `${Math.round(outbound.limiterPassRate * 100)}%`}`,
    `- 笔记：S ${s.notes?.persistent ?? 0}/50（core ${s.notes?.core ?? 0}/8）· A ${s.notes?.tempToday ?? 0}/10 · B ${s.notes?.tempYesterday ?? 0}`,
    '',
  ]
  const timeline = report.timeline ?? []
  if (timeline.length > 0) {
    lines.push('## 轨迹', '')
    for (const item of timeline.slice(-120)) {
      const time = new Date(item.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      const text = item.text ? ` — ${item.text}` : ''
      lines.push(`- **${time}** \`${item.category}\` ${item.title}${text}`)
    }
    if (timeline.length > 120) lines.push(`- …另有 ${timeline.length - 120} 条较早轨迹`)
    lines.push('')
  }
  lines.push('## 作息', '', '| 小时 | 轮次 |', '|---|---|')
  for (const row of report.rhythm ?? []) lines.push(`| ${String(row.hour).padStart(2, '0')}:00 | ${row.rounds} |`)
  lines.push('', '## 行动', '', '| 触发 | 次数 |', '|---|---|')
  for (const [key, value] of Object.entries(report.actions?.triggers ?? {})) lines.push(`| ${key} | ${value} |`)
  lines.push('', '| 工具 | 次数 |', '|---|---|')
  for (const [key, value] of Object.entries(report.actions?.toolCalls ?? {})) lines.push(`| ${key} | ${value} |`)
  const cost = (report.cost ?? []).filter((row) => row.total > 0)
  if (cost.length > 0) {
    lines.push('', '## 成本', '', '| 小时 | 输入 | 输出 | 缓存读 | 合计 |', '|---|---|---|---|---|')
    for (const row of cost) lines.push(`| ${String(row.hour).padStart(2, '0')}:00 | ${row.input} | ${row.output} | ${row.cacheRead} | ${row.total} |`)
  }
  lines.push('', '## 异常', '')
  if ((report.anomalies ?? []).length === 0) lines.push('- 无')
  else for (const item of report.anomalies) lines.push(`- \`${item.kind}\` · ${new Date(item.at).toLocaleString()}${item.errorCode ? ` · ${item.errorCode}` : ''}`)
  return `${lines.join('\n')}\n`
}

export function renderReportHtml(report) {
  const s = report.summary
  const rows = (items, columns, render) =>
    items.map((item) => `<tr>${columns.map((column) => `<td>${escapeHtml(render(item, column))}</td>`).join('')}</tr>`).join('')

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Living 日报 ${report.date}</title>
<style>
body{font:14px/1.6 system-ui,sans-serif;margin:24px;max-width:960px;color:#222}
h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #e3e3e3;padding:4px 8px;text-align:left}
th{background:#f6f6f6}.num{text-align:right;font-variant-numeric:tabular-nums}
.bar{background:#4a7;height:12px;border-radius:2px}
</style></head><body>
<h1>Living 日报 · ${report.date}</h1>
<p>轮次 ${s.rounds}（成功 ${s.successful} / 失败 ${s.failed}）· 事件 ${s.events} · 错过日程 ${s.missedSchedules}<br>
Token：输入 ${s.tokensIn} / 输出 ${s.tokensOut} / 缓存读 ${s.cacheRead} · 会话 ${s.sessions}<br>
外发决策 ${s.outbound?.decisions ?? 0}（拦 ${s.outbound?.block ?? 0}）· 判决 pass 率 ${s.outbound?.limiterPassRate == null ? '—' : `${Math.round(s.outbound.limiterPassRate * 100)}%`}<br>
笔记：S ${s.notes?.persistent ?? 0}/50（core ${s.notes?.core ?? 0}/8）· A ${s.notes?.tempToday ?? 0}/10 · B ${s.notes?.tempYesterday ?? 0}</p>
<h2>作息热图</h2>
<table><tr><th>小时</th><th>轮次</th></tr>
${rows(report.rhythm, ['hour', 'rounds'], (r, c) => c === 'rounds' ? `<div class="bar" style="width:${Math.min(100, r.rounds * 12)}px"></div>${r.rounds}` : String(r.hour))}
</table>
<h2>行动分布</h2>
<table><tr><th>触发</th><th>次数</th></tr>${rows(Object.entries(report.actions.triggers).map(([k, v]) => ({ k, v })), ['k', 'v'], (r, c) => String(r[c]))}</table>
<table><tr><th>结局</th><th>次数</th></tr>${rows(Object.entries(report.actions.outcomes).map(([k, v]) => ({ k, v })), ['k', 'v'], (r, c) => String(r[c]))}</table>
<table><tr><th>工具</th><th>次数</th></tr>${rows(Object.entries(report.actions.toolCalls).map(([k, v]) => ({ k, v })), ['k', 'v'], (r, c) => String(r[c]))}</table>
<h2>成本曲线</h2>
<table><tr><th>小时</th><th>输入</th><th>输出</th><th>缓存读</th><th>合计</th></tr>
${rows(report.cost.filter((item) => item.total > 0), ['hour', 'input', 'output', 'cacheRead', 'total'], (r, c) => String(r[c]))}
</table>
<h2>异常</h2>
<table><tr><th>类型</th><th>时间</th><th>轮次</th><th>错误码</th></tr>
${rows(report.anomalies, ['kind', 'at', 'roundId', 'errorCode'], (r, c) => c === 'at' ? new Date(r.at).toLocaleString() : String(r[c] ?? '—'))}
</table>
</body></html>`
}

export async function writeDailyReport({
  home,
  store,
  date,
  tzOffsetMinutes = 0,
  now = Date.now(),
  sessionRoot = null,
  sessionFiles = null,
}) {
  const [start, end] = dayRange(date, tzOffsetMinutes)
  // The report is living's own; sessionRoot is the host-wide tree, so keep only
  // the sessions the day's anchors actually name.
  const livingSessions = new Set(
    store.listRounds({ since: start, until: end - 1, limit: 10000 })
      .map((round) => round.sessionId)
      .filter((id) => typeof id === 'string' && id !== ''),
  )
  const files = Array.isArray(sessionFiles)
    ? sessionFiles
    : sessionRoot && existsSync(sessionRoot)
      ? findSessionFiles(sessionRoot, start, end)
      : []
  let records = []
  for (const file of files) {
    const events = readSessionFile(file)
    const header = events.find((event) => event.type === 'session')
    if (!header || !livingSessions.has(header.id)) continue
    records.push(...sessionRecords(events))
  }

  const report = buildDailyReport({ store, date, tzOffsetMinutes, records, now })
  await store.upsertReport({
    date,
    generatedAt: report.generatedAt,
    report,
    markdown: report.markdown,
    html: renderReportHtml(report),
  })
  return { report }
}

/** Build a report without writing it; used by the live "today" view. */
export function buildLiveReport({ home, store, date, tzOffsetMinutes = 0, now = Date.now(), sessionRoot = null, sessionFiles = null }) {
  const [start, end] = dayRange(date, tzOffsetMinutes)
  const livingSessions = new Set(
    store.listRounds({ since: start, until: end - 1, limit: 10000 })
      .map((round) => round.sessionId)
      .filter((id) => typeof id === 'string' && id !== ''),
  )
  const files = Array.isArray(sessionFiles)
    ? sessionFiles
    : sessionRoot && existsSync(sessionRoot)
      ? findSessionFiles(sessionRoot, start, end)
      : []
  const records = []
  for (const file of files) {
    const events = readSessionFile(file)
    const header = events.find((event) => event.type === 'session')
    if (!header || !livingSessions.has(header.id)) continue
    records.push(...sessionRecords(events))
  }
  return buildDailyReport({ store, date, tzOffsetMinutes, records, now })
}

export function findSessionFiles(root, since, until) {
  const out = []
  let entries = []
  try {
    entries = readdirSync(root, { recursive: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!String(entry).endsWith('.jsonl.zstd')) continue
    const file = join(root, String(entry))
    try {
      const stat = statSync(file)
      if (stat.mtimeMs < since - DAY_MS || stat.mtimeMs >= until + DAY_MS) continue
      out.push(file)
    } catch {
      // Vanished between listing and stat.
    }
  }
  return out
}

export function listReports(store) {
  return store.listReportDates()
}

export function readReport(store, date) {
  return store.getReport(date)
}

export function readReportHtml(store, date) {
  return store.getReportHtml(date)
}

export function reportDate(timestamp, tzOffsetMinutes = 0) {
  return dayKey(timestamp, tzOffsetMinutes)
}

function localHour(ts, tzOffsetMinutes) {
  const shifted = ts + tzOffsetMinutes * 60000
  return new Date(shifted).getUTCHours()
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
