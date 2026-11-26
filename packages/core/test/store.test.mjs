import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SCHEMA_VERSION } from '../lib/db.mjs'
import { createStore, OUTBOX_LEASE_MS } from '../lib/store.mjs'
import { tokenizeForIndex } from '../lib/text.mjs'
import { decodeVector, encodeVector } from '../lib/embed.mjs'

const T0 = 1_700_000_000_000

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'living-store-'))
  return { dir, path: join(dir, 'life.db') }
}

function open(t, clock = { now: T0 }) {
  const { dir, path } = tempPath()
  const store = createStore({ path, now: () => clock.now })
  t.after(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, path, clock }
}

// ── schema / persistence ────────────────────────────────────────────────

test('迁移幂等：重开后 schema 版本与数据都在', async (t) => {
  const { dir, path } = tempPath()
  const first = createStore({ path })
  assert.equal(first.schemaVersion(), SCHEMA_VERSION)
  await first.appendEvent({ id: 'ev_1', kind: 'note', payload: { text: '你好' } })
  await first.setState('clock', { nextWakeAt: 123 })
  await first.close()

  const second = createStore({ path })
  t.after(async () => {
    await second.close()
    rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(second.schemaVersion(), SCHEMA_VERSION)
  assert.deepEqual(second.getEvent('ev_1').payload, { text: '你好' })
  assert.deepEqual(second.getState('clock'), { nextWakeAt: 123 })
})

test('events/episodes：order=desc 取最近 N 条，返回仍按时间升序', async (t) => {
  const { store } = open(t)
  for (let index = 1; index <= 3; index += 1) {
    await store.appendEvent({ id: `ev${index}`, ts: index, kind: 'note', payload: { text: `e${index}` } })
    await store.appendEpisode({ id: `ep${index}`, tsStart: index, title: `e${index}`, summary: `e${index}` })
  }
  assert.deepEqual(store.listEvents({ limit: 2, order: 'desc' }).map((event) => event.id), ['ev2', 'ev3'])
  assert.deepEqual(store.listEpisodes({ limit: 2, order: 'desc' }).map((episode) => episode.id), ['ep2', 'ep3'])
  assert.throws(() => store.listEvents({ order: 'latest' }), RangeError)
  assert.throws(() => store.listEpisodes({ order: 'latest' }), RangeError)
})

test('events 只追加：读取按时间排序、可按区间过滤', async (t) => {
  const { store } = open(t)
  await store.appendEvent({ id: 'e2', ts: 200, kind: 'note', payload: { text: '第二' }, source: 'test' })
  await store.appendEvent({ id: 'e1', ts: 100, kind: 'note', payload: { text: '第一' }, source: 'test' })
  const all = store.listEvents({ limit: 10 })
  assert.deepEqual(all.map((e) => e.id), ['e1', 'e2'])
  assert.deepEqual(store.listEvents({ since: 150, limit: 10 }).map((e) => e.id), ['e2'])
  assert.equal(store.listEvents({ kind: 'note', limit: 10 }).length, 2)
})

test('events：kinds 白名单过滤，kind/kinds 互斥', async (t) => {
  const { store } = open(t)
  await store.appendEvent({ id: 'm1', ts: 1, kind: 'message', payload: { text: 'a' } })
  await store.appendEvent({ id: 'r1', ts: 2, kind: 'round', payload: { text: 'b' } })
  await store.appendEvent({ id: 'a1', ts: 3, kind: 'agent_mark', payload: { text: 'c' } })
  assert.deepEqual(store.listEvents({ kinds: ['message', 'agent_mark'], limit: 10 }).map((e) => e.id), ['m1', 'a1'])
  assert.deepEqual(store.listEvents({ kinds: [], limit: 10 }), [])
  assert.throws(() => store.listEvents({ kind: 'message', kinds: ['round'], limit: 10 }), RangeError)
  assert.throws(() => store.listEvents({ kinds: 'message', limit: 10 }), RangeError)
})

test('journal raw ids：按状态列出已整理的 journal 段', async (t) => {
  const { store } = open(t)
  await store.appendRawSegment({ id: 'raw_journal_jr_1', kind: 'journal', tsStart: 1, tsEnd: 1 })
  await store.appendRawSegment({ id: 'raw_journal_jr_2', kind: 'journal', tsStart: 2, tsEnd: 2 })
  await store.markRawSegment('raw_journal_jr_2')
  assert.deepEqual(store.listJournalRawIds().sort(), ['jr_2'])
  assert.deepEqual(store.listJournalRawIds({ status: 'pending' }), ['jr_1'])
})

test('事件非法输入大声失败', async (t) => {
  const { store } = open(t)
  await assert.rejects(() => store.appendEvent({ payload: {} }), RangeError)
  await assert.rejects(() => store.appendEvent({ kind: 'x', ts: Number.NaN }), RangeError)
  assert.throws(() => store.listEvents({ limit: 0 }), RangeError)
})

test('中文检索走 FTS5 双字切分', async (t) => {
  const { store } = open(t)
  await store.appendEvent({ id: 'e1', ts: 1, kind: 'note', payload: { text: '显卡散热坏了，换了风扇' } })
  await store.appendEvent({ id: 'e2', ts: 2, kind: 'note', payload: { text: '今天天气很好' } })
  const fan = store.searchMemory(['散热'], { kinds: ['event'] })
  assert.equal(fan[0]?.id, 'e1')
  const weather = store.searchMemory('天气', { kinds: ['event'] })
  assert.equal(weather[0]?.id, 'e2')
  assert.deepEqual(store.searchMemory([], {}), [])
})

// ── state ───────────────────────────────────────────────────────────────

test('state 读写往返，覆盖更新', async (t) => {
  const { store } = open(t)
  await store.setState('budget', { day: '2026-11-17', tokensUsed: 10 })
  assert.deepEqual(store.getState('budget'), { day: '2026-11-17', tokensUsed: 10 })
  await store.setState('budget', { day: '2026-11-18', tokensUsed: 0 })
  assert.deepEqual(store.getState('budget'), { day: '2026-11-18', tokensUsed: 0 })
  assert.equal(store.getState('missing'), null)
  assert.deepEqual(store.listState().budget, { day: '2026-11-18', tokensUsed: 0 })
})

// ── ingest dedupe ───────────────────────────────────────────────────────

test('ingest 按 gem + external_id 去重，第二次不落事件', async (t) => {
  const { store } = open(t)
  const event = { kind: 'message', actor: 'uid_9', source: 'bili', payload: { text: '在吗' } }
  const first = await store.recordIngest({ gem: 'bili', externalId: 'dm_1', event })
  const second = await store.recordIngest({ gem: 'bili', externalId: 'dm_1', event })
  assert.equal(first.accepted, true)
  assert.equal(second.accepted, false)
  assert.equal(store.listEvents({ limit: 10 }).length, 1)
})

test('同一 external_id 在不同宝石下互不影响', async (t) => {
  const { store } = open(t)
  const event = { kind: 'message', payload: { text: 'x' } }
  const a = await store.recordIngest({ gem: 'bili', externalId: 'same', event })
  const b = await store.recordIngest({ gem: 'wechat', externalId: 'same', event })
  assert.deepEqual([a.accepted, b.accepted], [true, true])
})

// ── outbox ──────────────────────────────────────────────────────────────

test('outbox：claim → ack 后不再投递', async (t) => {
  const { store, clock } = open(t)
  const id = await store.enqueueOutbox({ gem: 'bili', to: 'uid_9', text: '在', createdAt: clock.now })
  const first = await store.claimOutbox({ gem: 'bili', nowMs: clock.now })
  assert.equal(first.length, 1)
  assert.equal(first[0].id, id)
  assert.equal(first[0].to, 'uid_9')
  assert.equal(first[0].attempts, 1)

  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: clock.now + 1 })).length, 0, '租约期内不重复投递')
  const ack = await store.ackOutbox({ id, ok: true, externalId: 'dm_999', nowMs: clock.now })
  assert.equal(ack.ok, true)
  clock.now += OUTBOX_LEASE_MS + 1
  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: clock.now })).length, 0, 'ack 后不再投递')
})

test('outbox：未 ack 超过 5 分钟重投，attempts 累加', async (t) => {
  const { store, clock } = open(t)
  await store.enqueueOutbox({ gem: 'bili', to: 'u', text: 'x', createdAt: clock.now })
  await store.claimOutbox({ gem: 'bili', nowMs: clock.now })
  clock.now += OUTBOX_LEASE_MS + 1
  const again = await store.claimOutbox({ gem: 'bili', nowMs: clock.now })
  assert.equal(again.length, 1)
  assert.equal(again[0].attempts, 2)
})

test('outbox：可重试失败 5 分钟后重投；不可重试失败终止', async (t) => {
  const { store, clock } = open(t)
  await store.enqueueOutbox({ gem: 'bili', to: 'u', text: 'x', createdAt: clock.now })

  const [first] = await store.claimOutbox({ gem: 'bili', nowMs: clock.now })
  clock.now += OUTBOX_LEASE_MS + 1
  const [second] = await store.claimOutbox({ gem: 'bili', nowMs: clock.now })
  assert.equal(second.id, first.id)
  assert.equal(second.attempts, 2)

  const retry = await store.ackOutbox({ id: second.id, ok: false, code: 'provider_timeout', nowMs: clock.now })
  assert.equal(retry.retryable, true)
  clock.now += OUTBOX_LEASE_MS + 1
  const [third] = await store.claimOutbox({ gem: 'bili', nowMs: clock.now })
  assert.equal(third.id, first.id)
  assert.equal(third.attempts, 3)

  const dead = await store.ackOutbox({ id: third.id, ok: false, code: 'provider_auth', nowMs: clock.now })
  assert.equal(dead.retryable, false)
  clock.now += OUTBOX_LEASE_MS * 10
  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: clock.now })).length, 0)
})

test('outbox：待确认可放行或拒绝', async (t) => {
  const { store, clock } = open(t)
  await store.enqueueOutbox({ id: 'o1', gem: 'bili', to: 'u', text: 'x', createdAt: clock.now })
  await store.deferOutbox('o1', Number.MAX_SAFE_INTEGER, '待确认')
  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: clock.now })).length, 0, '待确认不可投递')

  await store.approveOutbox('o1', clock.now)
  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: clock.now })).length, 1, '放行后可投递')

  await store.enqueueOutbox({ id: 'o2', gem: 'bili', to: 'u', text: 'y', createdAt: clock.now })
  await store.deferOutbox('o2', Number.MAX_SAFE_INTEGER, '待确认')
  await store.rejectOutbox('o2', 'rejected by user', clock.now)
  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: clock.now })).length, 0, '拒绝后不可投递')
  assert.equal(store.listOutbox({ gem: 'bili', limit: 10 }).find((item) => item.id === 'o2').failedAt, clock.now)
})

test('outbox：待确认的重试不会把行放出来，放行才放', async (t) => {
  const { store, clock } = open(t)
  await store.enqueueOutbox({ id: 'o1', gem: 'bili', to: 'u', text: 'x', createdAt: clock.now, decision: 'review' })
  await store.deferOutbox('o1', Number.MAX_SAFE_INTEGER, '待确认')
  await store.ackOutbox({ id: 'o1', ok: false, code: 'provider_timeout', nowMs: clock.now })
  clock.now += OUTBOX_LEASE_MS * 10
  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: clock.now })).length, 0, '重试把 next_attempt 提前也不可投递')

  await store.approveOutbox('o1', clock.now)
  assert.equal(store.getOutbox('o1').decision, 'send')
  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: clock.now })).length, 1, '放行后立即可投递')
})

test('outbox：判决字段落库，放行/拒绝写审计事件', async (t) => {
  const { store, clock } = open(t)
  await store.enqueueOutbox({
    id: 'o1',
    gem: 'bili',
    to: 'u',
    text: 'x',
    createdAt: clock.now,
    decision: 'review',
    ruleId: 'R-01',
    reason: '非白名单外发需确认',
    verdictSource: 'whitelist',
  })
  const row = store.getOutbox('o1')
  assert.equal(row.decision, 'review')
  assert.equal(row.ruleId, 'R-01')
  assert.equal(row.reason, '非白名单外发需确认')
  assert.equal(row.verdictSource, 'whitelist')

  await store.deferOutbox('o1', Number.MAX_SAFE_INTEGER, '非白名单外发需确认')
  await store.approveOutbox('o1', clock.now)
  const approved = store.listEvents({ limit: 50 }).filter((event) => event.kind === 'outbound_approved')
  assert.equal(approved.length, 1)
  assert.equal(approved[0].payload.ruleId, 'R-01')
  assert.equal(approved[0].payload.verdictSource, 'whitelist')

  await store.enqueueOutbox({ id: 'o2', gem: 'bili', to: 'u', text: 'y', createdAt: clock.now, decision: 'review' })
  await store.deferOutbox('o2', Number.MAX_SAFE_INTEGER, '待确认')
  await store.rejectOutbox('o2', 'not now', clock.now)
  const rejected = store.listEvents({ limit: 50 }).filter((event) => event.kind === 'outbound_rejected')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].payload.reason, 'not now')
})

test('outbox 参数非法大声失败', async (t) => {
  const { store } = open(t)
  await assert.rejects(() => store.enqueueOutbox({ gem: 'bili', to: '', text: 'x' }), RangeError)
  await assert.rejects(() => store.enqueueOutbox({ gem: '', to: 'u', text: 'x' }), RangeError)
  await assert.rejects(() => store.claimOutbox({ gem: '', nowMs: 0 }), RangeError)
  await assert.rejects(() => store.ackOutbox({ id: 'nope', ok: true, nowMs: 0 }), RangeError)
})

// ── anchors ─────────────────────────────────────────────────────────────

test('anchors：写入、更新、按时间列轮次', async (t) => {
  const { store } = open(t)
  await store.appendAnchor({
    roundId: 'r1',
    startedAt: 100,
    trigger: 'heartbeat',
    triggerDetail: { idleMinutes: 5 },
    sessionId: 's1',
  })
  await store.appendAnchor({ roundId: 'r2', startedAt: 200, trigger: 'schedule' })
  await store.updateAnchor('r1', { endedAt: 150, outcome: 'ok' })

  const rounds = store.listRounds({ since: 0, limit: 10 })
  assert.deepEqual(rounds.map((r) => r.roundId), ['r2', 'r1'])
  const r1 = rounds.find((r) => r.roundId === 'r1')
  assert.equal(r1.endedAt, 150)
  assert.equal(r1.outcome, 'ok')
  assert.deepEqual(r1.triggerDetail, { idleMinutes: 5 })
})

test('anchor 非法字段或未知轮次大声失败', async (t) => {
  const { store } = open(t)
  await assert.rejects(() => store.appendAnchor({ roundId: 'r1' }), RangeError)
  await store.appendAnchor({ roundId: 'r1', startedAt: 100 })
  await assert.rejects(() => store.updateAnchor('r1', { nope: 1 }), RangeError)
  await assert.rejects(() => store.updateAnchor('missing', { outcome: 'ok' }), RangeError)
})

// ── memory tables ───────────────────────────────────────────────────────

test('记忆条目：episode/fact/facets/access/cold/import 往返', async (t) => {
  const { store } = open(t)
  await store.appendEpisode({ id: 'ep1', tsStart: 100, tsEnd: 200, title: '修电脑', summary: '换风扇', importance: 0.6, eventIds: ['e1'] })
  assert.deepEqual(store.listEpisodes({ limit: 10 })[0].eventIds, ['e1'])

  await store.upsertFact({ id: 'f1', subject: '小明', predicate: '喜欢', object: '看展', confidence: 0.8, firstSeen: 100, lastSeen: 200, source: 'chat', eventIds: ['e1'] })
  await store.upsertFact({ id: 'f1', subject: '小明', predicate: '喜欢', object: '看展', confidence: 0.9, firstSeen: 100, lastSeen: 300, source: 'chat', eventIds: ['e2'] })
  const fact = store.listFacts({ limit: 10 })[0]
  assert.equal(fact.confidence, 0.9)
  assert.equal(fact.lastSeen, 300)
  assert.deepEqual(fact.eventIds, ['e2'])

  await store.setFacets('fact', 'f1', { who: ['小明'], when: ['2026-11-17'] })
  assert.deepEqual(store.getFacets('fact', 'f1'), { who: ['小明'], when: ['2026-11-17'] })

  await store.appendAccess('fact', 'f1', { ts: 1, kind: 'inject', weight: 1 })
  assert.deepEqual(store.listAccess('fact', 'f1'), [{ ts: 1, kind: 'inject', weight: 1 }])

  await store.appendCold({ keyword: '显卡', eventIds: ['e1'], label20: '显卡散热坏了', lastTs: 1, importance: 0.5 })
  assert.equal(store.listCold({ limit: 10 })[0].fidelity, 'low')

  const first = await store.recordImport({ key: 'abc', source: 'note.md', ts: 5, text: '导入的一条' })
  const second = await store.recordImport({ key: 'abc', source: 'note.md', ts: 5, text: '导入的一条' })
  assert.deepEqual([first.accepted, second.accepted], [true, false])
  const imported = store.listEvents({ kind: 'import', limit: 10 })
  assert.equal(imported.length, 1)
  assert.equal(imported[0].payload.origin, 'note.md')
  assert.equal(store.searchMemory(['导入'], { kinds: ['event'] }).length, 1)
})

test('memory_vectors：写入、按模型读取、统计与清空', async (t) => {
  const { store } = open(t)
  await store.upsertMemoryVectors([
    { source: 'events', id: 'e1', ts: 100, kind: 'message', text: '显卡', model: 'm1', dim: 2, hash: 'h1', vector: encodeVector([1, 0]), createdAt: 1 },
    { source: 'journal', id: 'j1', ts: 200, kind: 'journal', text: '面条', model: 'm1', dim: 2, hash: 'h2', vector: encodeVector([0, 1]), createdAt: 1 },
    { source: 'items', id: 'p1', ts: 300, kind: 'episode', text: '旧模型', model: 'm0', dim: 2, hash: 'h3', vector: encodeVector([0.5, 0.5]), createdAt: 1 },
  ])
  const rows = store.listMemoryVectors({ model: 'm1' })
  assert.deepEqual(rows.map((row) => row.id), ['j1', 'e1'])
  assert.deepEqual([...decodeVector(rows[1].vector)], [1, 0])
  assert.deepEqual(store.memoryVectorStats(), { count: 3, models: { m0: 1, m1: 2 }, oldest: 100, newest: 300 })
  assert.equal(store.countMemoryVectors({ model: 'm1' }), 2)
  assert.equal(store.listMemoryVectorMeta({ model: 'm1' }).length, 2)
  assert.equal(await store.clearMemoryVectors(), 3)
  assert.equal(store.countMemoryVectors(), 0)
})

test('persona_docs / journal_entries：DB 往返与按日查询', async (t) => {
  const { store } = open(t)
  await store.setPersonaDoc({ kind: 'charter', text: 'CHARTER', updatedAt: 1 })
  await store.setPersonaDoc({ kind: 'self', text: 'SELF', updatedAt: 2 })
  assert.equal(store.getPersonaDoc('charter').text, 'CHARTER')
  await store.appendJournalEntry({ id: 'j1', date: '2026-11-18', ts: 1, text: '第一条' })
  await store.appendJournalEntry({ id: 'j2', date: '2026-11-18', ts: 2, text: '第二条' })
  await store.appendJournalEntry({ id: 'j3', date: '2026-11-19', ts: 3, text: '明天' })
  assert.deepEqual(store.listJournalEntries({ date: '2026-11-18' }).map((row) => row.text), ['第一条', '第二条'])
  assert.equal(store.listJournalEntries({ date: '2026-11-19' })[0].text, '明天')
})

test('raw/edges：原始段、处理状态、关系边与 memory_items 视图', async (t) => {
  const { store } = open(t)
  const segment = {
    id: 'raw_1',
    sessionId: 's1',
    kind: 'rest',
    tsStart: 10,
    tsEnd: 20,
    payload: { messages: [{ role: 'user', text: 'hi' }] },
    createdAt: 10,
  }
  assert.equal(await store.appendRawSegment(segment), true)
  assert.equal(await store.appendRawSegment(segment), false, '同一 session 不重复采集')
  const [raw] = store.listRawSegments({ status: 'pending' })
  assert.equal(raw.payload.messages[0].text, 'hi')
  await store.markRawSegment('raw_1', { processedAt: 30 })
  assert.equal(store.listRawSegments({ status: 'processed' })[0].attempts, 1)

  await store.appendEpisode({ id: 'ep1', tsStart: 10, title: 't', summary: 's', rawRefs: ['raw_1'] })
  await store.upsertFact({ id: 'f1', subject: 'a', predicate: 'b', object: 'c', firstSeen: 10, rawRefs: ['raw_1'] })
  const items = store.listMemoryItems({ limit: 10 })
  assert.deepEqual(new Set(items.map((item) => item.kind)), new Set(['episode', 'fact']))
  assert.deepEqual(items.find((item) => item.kind === 'episode').rawRefs, ['raw_1'])

  await store.appendMemoryEdge({ id: 'edge1', fromKind: 'episode', fromId: 'ep1', relation: 'supports', toKind: 'fact', toId: 'f1', note: '一致', confidence: 0.8 })
  const out = store.listMemoryEdges({ kind: 'episode', id: 'ep1' })
  assert.equal(out.length, 1)
  assert.equal(out[0].otherKind, 'fact')
  assert.equal(out[0].otherId, 'f1')
  assert.equal(store.listMemoryEdges({ kind: 'fact', id: 'f1', direction: 'in' })[0].relation, 'supports')
})

test('persona_versions：快照、diff、版本链、去重与读取', async (t) => {
  const { store } = open(t)
  const first = await store.appendPersonaVersion({
    kind: 'self',
    actor: 'agent',
    action: 'evolve',
    message: 'first',
    text: '第一行\n第二行',
    ts: T0,
  })
  assert.ok(first.id.startsWith('pv_'))
  assert.equal(first.previousId, null)
  assert.ok(first.diff.includes('+第一行'))

  const second = await store.appendPersonaVersion({
    kind: 'self',
    actor: 'human',
    action: 'edit',
    text: '第一行\n第二行改了',
    ts: T0 + 1000,
  })
  assert.equal(second.previousId, first.id)
  assert.ok(second.diff.includes('-第二行'))
  assert.ok(second.diff.includes('+第二行改了'))

  const duplicate = await store.appendPersonaVersion({
    kind: 'self',
    actor: 'human',
    action: 'edit',
    text: '第一行\n第二行改了',
    ts: T0 + 2000,
  })
  assert.equal(duplicate.unchanged, true)
  assert.equal(store.listPersonaVersions({ kind: 'self' }).length, 2)

  const charter = await store.appendPersonaVersion({
    kind: 'charter',
    actor: 'human',
    action: 'edit',
    text: 'charter 文本',
    ts: T0 + 3000,
  })
  assert.equal(store.listPersonaVersions({ kind: 'self' }).length, 2)
  assert.equal(store.listPersonaVersions({ kind: 'charter' }).length, 1)
  assert.equal(store.getPersonaVersion(charter.id).text, 'charter 文本')
  assert.equal(store.getPersonaVersion(first.id).text, '第一行\n第二行')
  assert.equal(store.getPersonaVersion('missing'), null)
})

// ── write queue ─────────────────────────────────────────────────────────

test('两个写者并发 100 条事件：单写队列不锁死', async (t) => {
  const { store } = open(t)
  const worker = (tag) =>
    Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.appendEvent({ kind: 'tick', payload: { tag, i } }),
      ),
    )
  const started = Date.now()
  await Promise.all([worker('a'), worker('b')])
  const events = store.listEvents({ limit: 200 })
  assert.equal(events.length, 100)
  assert.ok(Date.now() - started < 5000, `耗时过长: ${Date.now() - started}ms`)
})

test('分词器：中文双字 + 英文词', () => {
  const tokens = tokenizeForIndex('B站 bili_search 显卡散热')
  assert.ok(tokens.includes('显卡'))
  assert.ok(tokens.includes('散热'))
  assert.ok(tokens.includes('bili_search'))
  assert.ok(tokens.includes('b站'))
})
