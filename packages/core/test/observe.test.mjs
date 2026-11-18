import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import {
  buildDailyReport,
  renderReportHtml,
  sessionRecords,
  dayRange,
  writeDailyReport,
  readReport,
  listReports,
} from '../lib/observe.mjs'

const TZ = 480
const DATE = '2026-11-17'
const [START, END] = dayRange(DATE, TZ)
const NOON = START + 12 * 3600000

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('sessionRecords 只做映射：turn / tool / usage', () => {
  const records = sessionRecords([
    { type: 'session', createdAt: START, id: 's1', agentPreset: 'living', cwd: '/x' },
    { type: 'turn/start', time: NOON, data: { turn: 1 } },
    { type: 'tool/call', time: NOON + 1000, data: { name: 'living_recall', callId: 'c1' } },
    {
      type: 'assistant/message',
      time: NOON + 2000,
      data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, totalTokens: 17 } },
    },
    { type: 'turn/end', time: NOON + 3000, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.deepEqual(records.map((r) => r.kind), ['session', 'turn_start', 'tool_call', 'usage', 'turn_end'])
  assert.equal(records[3].tokens.input, 10)
  assert.equal(records[2].summary, 'living_recall')

  const fallback = sessionRecords([
    { type: 'assistant/message', time: NOON, data: { message: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } } },
  ])
  assert.equal(fallback[0].tokens.total, 2)
})

test('日报四视角：作息、行动、成本、异常', async (t) => {
  const dir = temp(t, 'living-observe-')
  const store = createStore({ path: join(dir, 'life.db') })
  t.after(() => store.close())

  await store.appendAnchor({ roundId: 'r1', startedAt: NOON, trigger: 'heartbeat', outcome: 'ok' })
  await store.appendAnchor({ roundId: 'r2', startedAt: NOON + 1000, trigger: 'heartbeat', outcome: 'error', errorCode: 'provider_timeout' })
  await store.appendEvent({ kind: 'schedule_missed', ts: NOON + 2000, source: 'living', payload: { scheduleId: 's1' } })

  const report = buildDailyReport({
    store,
    date: DATE,
    tzOffsetMinutes: TZ,
    now: NOON,
    records: [
      { ts: NOON, source: 'session', kind: 'usage', summary: '', tokens: { input: 10, output: 2, cacheRead: 5, total: 17 } },
      { ts: NOON, source: 'session', kind: 'tool_call', summary: 'living_recall' },
    ],
  })

  assert.equal(report.summary.rounds, 2)
  assert.equal(report.summary.successful, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(report.summary.missedSchedules, 1)
  assert.equal(report.summary.tokensIn, 10)
  assert.equal(report.rhythm[12].rounds, 2)
  assert.equal(report.actions.triggers.heartbeat, 2)
  assert.equal(report.actions.toolCalls.living_recall, 1)
  assert.equal(report.cost[12].total, 17)
  assert.equal(report.anomalies.length, 2)

  const html = renderReportHtml(report)
  assert.ok(html.includes('作息热图'))
  assert.ok(html.includes('成本曲线'))
  assert.ok(html.includes('异常'))
  assert.ok(html.includes(DATE))
})

test('日报外发：被拦数、判决 pass 率、连续 5 次放行提示', async (t) => {
  const dir = temp(t, 'living-observe-')
  const store = createStore({ path: join(dir, 'life.db') })
  t.after(() => store.close())

  const decisions = [
    { decision: 'block', ruleId: 'R-01', limiter: 'block', verdictSource: 'rule' },
    ...Array.from({ length: 5 }, () => ({ decision: 'review', limiter: 'pass', verdictSource: 'limiter' })),
    { decision: 'send', limiter: 'pass', verdictSource: 'whitelist' },
  ]
  for (const [index, payload] of decisions.entries()) {
    await store.appendEvent({
      kind: 'outbound_decision',
      ts: NOON + index,
      source: 'living',
      payload: { gem: 'bili', visibility: 'public', outboxId: `o${index}`, ...payload },
    })
  }

  const report = buildDailyReport({ store, date: DATE, tzOffsetMinutes: TZ, now: NOON })
  assert.equal(report.summary.outbound.decisions, 7)
  assert.equal(report.summary.outbound.block, 1)
  assert.equal(report.summary.outbound.limiterPass, 6)
  assert.equal(report.summary.outbound.limiterBlock, 1)
  assert.equal(report.summary.outbound.limiterPassRate, 6 / 7)
  assert.ok(report.anomalies.some((item) => item.kind === 'outbound_blocked' && item.errorCode === 'R-01'))
  assert.ok(report.anomalies.some((item) => item.kind === 'limiter_pass_streak'))
  assert.ok(renderReportHtml(report).includes('判决 pass 率'))
})

test('writeDailyReport 写数据库，可读回 Markdown/HTML', async (t) => {
  const home = temp(t, 'living-report-home-')
  const store = createStore({ path: join(home, 'life.db') })
  t.after(() => store.close())
  await store.appendAnchor({ roundId: 'r1', startedAt: NOON, trigger: 'schedule', outcome: 'ok', sessionId: 's1' })

  const sessionFile = join(home, 'session.jsonl')
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'session', createdAt: START, id: 's1', agentPreset: 'living', cwd: '/x' }),
      JSON.stringify({ type: 'turn/start', time: NOON, data: { turn: 1 } }),
      JSON.stringify({
        type: 'assistant/message',
        time: NOON + 1000,
        data: { message: { usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, totalTokens: 11 } } },
      }),
    ].join('\n'),
    'utf8',
  )
  const foreignFile = join(home, 'foreign.jsonl')
  writeFileSync(
    foreignFile,
    [
      JSON.stringify({ type: 'session', createdAt: START, id: 's2', agentPreset: 'standard', cwd: '/code' }),
      JSON.stringify({
        type: 'assistant/message',
        time: NOON + 2000,
        data: { message: { usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 } } },
      }),
    ].join('\n'),
    'utf8',
  )

  await writeDailyReport({
    home,
    store,
    date: DATE,
    tzOffsetMinutes: TZ,
    now: NOON,
    sessionFiles: [sessionFile, foreignFile],
  })

  const read = readReport(store, DATE)
  assert.equal(read.summary.rounds, 1)
  assert.equal(read.summary.tokensIn, 7, '别的会话不应污染日报')
  assert.equal(read.summary.sessions, 1)
  assert.match(read.markdown, /Living 日报/)
  assert.match(read.markdown, /## 轨迹/)
  assert.match(read.html, /Living 日报/)
  assert.deepEqual(listReports(store), [DATE])
  assert.ok(NOON >= START && NOON < END)
})
