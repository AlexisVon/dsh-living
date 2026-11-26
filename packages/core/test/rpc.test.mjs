import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SCHEMA_VERSION } from '../lib/db.mjs'
import { createStore } from '../lib/store.mjs'
import { createRuntime } from '../lib/runtime.mjs'
import { resolveLayout } from '../lib/layout.mjs'
import { ADMIN_CHANNEL, ADMIN_ENDPOINT, createAdminFetch, createAdminRpc } from '../lib/rpc.mjs'

const NOW = Date.UTC(2026, 11, 1, 4)
const TZ = 480

async function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'living-rpc-'))
  const layout = resolveLayout(home)
  const store = createStore({ path: layout.dbPath, now: () => NOW })
  const runtime = createRuntime({
    home,
    store,
    now: () => NOW,
    rng: () => 0,
    config: { tzOffsetMinutes: TZ, gemTokens: { bili: 't' }, gemLimits: { bili: { perMinute: 100 } } },
    runner: async () => ({ tokens: 0, outcome: 'ok' }),
    logger: { error: () => {} },
  })
  t.after(async () => {
    await store.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, layout, store, runtime, handle: createAdminRpc({ runtime, store, home, layout }) }
}

test('admin 通道走共享 /api 的 exact 路由', () => {
  assert.equal(ADMIN_CHANNEL, '/api')
  assert.equal(ADMIN_ENDPOINT, 'living-admin')
})

test('Connection 信封：rpcId 回显、endpoint 解包', async (t) => {
  const { runtime, store, home } = await setup(t)
  const fetch = createAdminFetch({ runtime, store, home })
  const request = new Request('http://localhost/api/living-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'living-admin', payload: { endpoint: 'state', payload: {} } }),
  })
  const response = await fetch(request)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'rpc-1')
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.status, 'RUNNING')
})

test('state / rounds / memory / stats 走同一通道', async (t) => {
  const { store, handle } = await setup(t)
  await store.appendAnchor({ roundId: 'r1', startedAt: NOW, trigger: 'event', outcome: 'ok' })
  await store.appendEvent({ id: 'e1', ts: NOW, kind: 'message', source: 'bili', payload: { text: '显卡散热坏了' } })

  const state = await handle('state', {})
  assert.equal(state.ok, true)
  assert.equal(state.value.status, 'RUNNING')

  const rounds = await handle('rounds', { limit: 5 })
  assert.equal(rounds.ok, true)
  assert.equal(rounds.value[0].roundId, 'r1')

  const memory = await handle('memory', { query: '散热', topK: 5 })
  assert.equal(memory.ok, true)
  assert.equal(memory.value.recalled[0].id, 'e1')

  const stats = await handle('stats', { days: 1 })
  assert.equal(stats.ok, true)
  assert.ok(stats.value.events >= 1)
})

test('notes RPC：关键词表、条目、按编号增删改与 promote/demote', async (t) => {
  const { handle, store } = await setup(t)
  const added = await handle('noteAdd', { tier: 'persistent', tag: '猫粮', text: '先看粉料比例', core: true })
  assert.equal(added.ok, true)
  assert.equal(added.value.code, 'S1')
  assert.equal(added.value.note, undefined, '成功只回编号与余量，不回读正文')
  assert.equal(added.value.stats.persistent, 1)
  assert.equal(added.value.stats.core, 1)
  assert.equal(added.value.stats.text, 'S 1/50 · A 0/10 · B 0（只读）')

  const table = await handle('notes', {})
  assert.equal(table.ok, true)
  assert.deepEqual(table.value.keywords, [{ tag: '猫粮', s: 1, a: 0, b: 0 }])
  assert.match(table.value.stats.day, /^\d{4}-\d{2}-\d{2}$/)

  const entries = await handle('noteEntries', { tag: '猫粮' })
  assert.equal(entries.ok, true)
  assert.deepEqual(entries.value.entries.map((entry) => entry.code), ['S1'])
  assert.equal(entries.value.entries[0].readOnly, false)

  const read = await handle('noteRead', { code: 'S1' })
  assert.equal(read.ok, true)
  assert.equal(read.value.note.text, '先看粉料比例')

  const updated = await handle('noteUpdate', { code: 'S1', text: '先看粉料比例和脂肪' })
  assert.equal(updated.ok, true)
  assert.match(updated.value.note.text, /脂肪/)
  assert.equal(updated.value.note.code, 'S1')

  const demoted = await handle('noteDemote', { code: 'S1' })
  assert.equal(demoted.ok, true)
  assert.equal(demoted.value.note.tier, 'temp')
  assert.equal(demoted.value.note.code, 'A1')
  assert.equal(demoted.value.stats.tempToday, 1)

  const promoted = await handle('notePromote', { code: 'A1', core: false })
  assert.equal(promoted.ok, true)
  assert.equal(promoted.value.note.tier, 'persistent')
  assert.equal(promoted.value.note.code, 'S1')

  const removed = await handle('noteDelete', { code: 'S1' })
  assert.equal(removed.ok, true)
  assert.equal(removed.value.removed, true)
  assert.deepEqual((await handle('notes', {})).value.keywords, [])

  await store.addNote({ tier: 'temp', tag: '旧', text: '昨天的事', day: '2026-11-30' })
  const readonly = await handle('noteUpdate', { code: 'B1', text: '改' })
  assert.equal(readonly.ok, false)
  assert.match(readonly.error.message, /只读/)
  assert.equal((await handle('noteRead', { code: 'B1' })).value.note.readOnly, true)
})

test('sessionVisibility：可见性由主会话管理器落地，state 带会话快照', async (t) => {
  const { runtime, store, home } = await setup(t)
  const seen = []
  const session = {
    setVisible: async (visible) => {
      seen.push(visible)
      return { id: 'living_1', visible }
    },
    snapshot: () => ({ id: 'living_1', visible: seen.at(-1) ?? false }),
  }
  const handle = createAdminRpc({ runtime, store, home, session })
  const toggled = await handle('sessionVisibility', { visible: true })
  assert.equal(toggled.ok, true)
  assert.equal(toggled.value.visible, true)
  assert.deepEqual(seen, [true])
  const state = await handle('state', {})
  assert.equal(state.value.session.id, 'living_1')
  assert.equal((await handle('sessionVisibility', {})).value.visible, false)
})

test('sessionVisibility：没有会话管理器时明确失败', async (t) => {
  const { handle } = await setup(t)
  const result = await handle('sessionVisibility', { visible: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session_unavailable')
})

test('persona 管理面：状态、模式、charter/self、版本与重置', async (t) => {
  const { runtime, store, home } = await setup(t)
  const handle = createAdminRpc({ runtime, store, home })

  const initial = await handle('personaState', {})
  assert.equal(initial.ok, true)
  assert.equal(initial.value.mode, 'night')
  assert.deepEqual(initial.value.versions, [])

  const off = await handle('personaEvolveMode', { mode: 'off' })
  assert.equal(off.value.mode, 'off')
  assert.equal((await handle('personaEvolveMode', { mode: 'nope' })).ok, false)

  const charter = await handle('personaCharterSet', { text: '我是谁\n做点有用的事' })
  assert.equal(charter.ok, true)
  assert.ok(charter.value.charter.includes('做点有用的事'))

  const first = await handle('personaSelfSet', { text: '第一版 self' })
  assert.equal(first.value.self.trim(), '第一版 self')
  const second = await handle('personaSelfSet', { text: '第二版 self' })
  assert.equal(second.value.self.trim(), '第二版 self')
  assert.equal(second.value.versions.length, 3, 'charter 版本 + 两个 self 版本')
  assert.deepEqual(second.value.versions.map((row) => row.kind), ['self', 'self', 'charter'])
  const charterVersion = second.value.versions.find((row) => row.kind === 'charter')
  await handle('personaCharterSet', { text: '第二版 charter' })
  const restoredCharter = await handle('personaReset', { to: 'version', version: charterVersion.id })
  assert.equal(restoredCharter.value.charter.trim(), '我是谁\n做点有用的事')
  const older = second.value.versions[1]
  const version = await handle('personaVersion', { id: older.id })
  assert.equal(version.value.text.trim(), '第一版 self')

  const restored = await handle('personaReset', { to: 'version', version: older.id })
  assert.equal(restored.value.self.trim(), '第一版 self')
  const cleared = await handle('personaReset', { to: 'empty' })
  assert.equal(cleared.value.self.trim(), '')
  assert.equal((await handle('personaReset', { to: 'nope' })).ok, false)
})

test('budgetReset：管理面可清零今日用量', async (t) => {
  const { store, handle } = await setup(t)
  const result = await handle('budgetReset', { reason: 'test' })
  assert.equal(result.ok, true)
  assert.equal(result.value.budget.tokensUsed, 0)
  assert.equal(result.value.budget.rounds, 0)
  assert.equal(result.value.status, 'RUNNING')
  const [event] = store.listEvents({ kind: 'budget_reset', limit: 10 })
  assert.equal(event.payload.reason, 'test')
})

test('outbox 列表与批准/拒绝', async (t) => {
  const { store, handle } = await setup(t)
  await store.enqueueOutbox({ id: 'o1', gem: 'bili', to: 'u', text: 'x', createdAt: NOW })
  await store.deferOutbox('o1', Number.MAX_SAFE_INTEGER, '待确认')
  const list = await handle('outbox', { limit: 5 })
  assert.equal(list.ok, true)
  assert.equal(list.value[0].nextAttemptAt, Number.MAX_SAFE_INTEGER)

  const approved = await handle('approve', { id: 'o1' })
  assert.equal(approved.ok, true)
  assert.equal((await store.claimOutbox({ gem: 'bili', nowMs: NOW })).length, 1)

  await store.enqueueOutbox({ id: 'o2', gem: 'bili', to: 'u', text: 'y', createdAt: NOW })
  await store.deferOutbox('o2', Number.MAX_SAFE_INTEGER, '待确认')
  const rejected = await handle('reject', { id: 'o2', reason: 'no' })
  assert.equal(rejected.ok, true)
  assert.equal(store.listOutbox({ limit: 5 }).find((item) => item.id === 'o2').failedAt !== null, true)
})

test('宝石管理：列表、配置保存、登录控制、token 写 only', async (t) => {
  const { runtime, store, home } = await setup(t)
  const gem = {
    manifest: {
      id: 'demo',
      name: 'Demo',
      version: '0.1.0',
      capabilities: { text: true },
      limits: { perMinute: 10 },
      etiquette: [],
      failure_hints: {},
      config: {
        fields: [
          { key: 'dmPollSeconds', label: '私信轮询', type: 'number', default: 30, min: 15, max: 600 },
          { key: 'ownerUid', label: '主人 UID', type: 'text', default: '' },
        ],
      },
    },
    dir: join(home, 'gem-demo'),
    skill: '',
  }
  const calls = []
  const gemLogin = {
    start: (id) => {
      calls.push(['start', id])
      return { gem: id, status: 'wait', qr: { url: 'u', svg: '<svg/>' } }
    },
    status: (id) => ({ gem: id, status: 'idle' }),
    input: (id, promptId, value) => {
      calls.push(['input', id, promptId, value])
      return { gem: id, status: 'wait', prompts: [] }
    },
    cancel: (id) => ({ gem: id, status: 'cancelled' }),
  }
  const tokens = new Map()
  const handle = createAdminRpc({
    runtime,
    store,
    home,
    gems: [gem],
    gemHomes: { demo: home },
    gemLogin,
    setGemToken: async (id, token) => {
      if (token === '') tokens.delete(id)
      else tokens.set(id, token)
      return { configured: token !== '' }
    },
    gemTokenStatus: () => ({ demo: tokens.has('demo') }),
  })

  const list = await handle('gems', {})
  assert.equal(list.ok, true)
  assert.equal(list.value[0].id, 'demo')
  assert.equal(list.value[0].credential.present, false)
  assert.deepEqual(list.value[0].configSchema.fields.map((field) => field.key), ['dmPollSeconds', 'ownerUid'])

  const saved = await handle('gemConfig', { gem: 'demo', config: { dmPollSeconds: 30, ownerUid: '42' } })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.value.config, { dmPollSeconds: 30, ownerUid: '42' })
  assert.deepEqual((await handle('gems', {})).value[0].config, { dmPollSeconds: 30, ownerUid: '42' })

  const rejected = await handle('gemConfig', { gem: 'demo', config: { dmPollSeconds: 5 } })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'config_invalid')

  const tokenSet = await handle('gemTokenSet', { gem: 'demo', token: 'abc12345' })
  assert.equal(tokenSet.ok, true)
  assert.equal(tokenSet.value.configured, true)
  assert.equal((await handle('gems', {})).value[0].tokenConfigured, true)
  assert.equal((await handle('gemTokenSet', { gem: 'demo', token: '' })).value.configured, false)
  assert.equal((await handle('gemTokenSet', { gem: 'demo', token: 'x' })).error.code, 'invalid_token')

  assert.equal((await handle('gemLoginStart', { gem: 'demo' })).value.status, 'wait')
  assert.equal((await handle('gemLoginStatus', { gem: 'demo' })).value.status, 'idle')
  const loginInput = await handle('gemLoginInput', { gem: 'demo', promptId: 'username', value: 'alice' })
  assert.equal(loginInput.ok, true)
  assert.deepEqual(loginInput.value.prompts, [])
  assert.equal((await handle('gemLoginInput', { gem: 'demo', promptId: '', value: 'x' })).error.code, 'invalid_prompt')
  assert.equal((await handle('gemLoginInput', { gem: 'demo', promptId: 'username', value: 1 })).error.code, 'invalid_value')
  assert.equal((await handle('gemLoginCancel', { gem: 'demo' })).value.status, 'cancelled')
  assert.equal((await handle('gemConfig', { gem: 'nope', config: {} })).ok, false)
  assert.deepEqual(calls, [['start', 'demo'], ['input', 'demo', 'username', 'alice']])
})

test('reports / report / 未知端点', async (t) => {
  const { handle } = await setup(t)
  const reports = await handle('reports', {})
  assert.deepEqual(reports, { ok: true, value: [] })

  const live = await handle('report', { date: '2026-11-17' })
  assert.equal(live.ok, true)
  assert.equal(live.value.live, true)
  assert.equal(live.value.date, '2026-11-17')
  assert.match(live.value.markdown, /Living 日报/)

  const badDate = await handle('report', { date: 'nope' })
  assert.equal(badDate.error.code, 'invalid_date')

  const unknown = await handle('nope', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'unknown_endpoint')
})

test('embedConfig / embedConfigSave 走同一通道', async (t) => {
  const { handle } = await setup(t)
  const config = await handle('embedConfig', {})
  assert.equal(config.ok, true)
  assert.equal(config.value.url, 'http://127.0.0.1:11434')
  assert.equal(config.value.fallbackDays, 3)
  assert.equal(config.value.minConfidence, 0.35)
  assert.equal(config.value.maxSegmentDays, 7)

  const saved = await handle('embedConfigSave', { fallbackDays: 30, minConfidence: 0.5, maxSegmentDays: 14 })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.fallbackDays, 30)
  assert.equal(saved.value.minConfidence, 0.5)
  assert.equal(saved.value.maxSegmentDays, 14)
  assert.equal(saved.value.cleared, false)
})

test('dataInfo / backup / importBackup / importCancel', async (t) => {
  const { handle, home, layout } = await setup(t)
  const info = await handle('dataInfo', {})
  assert.equal(info.ok, true)
  assert.equal(info.value.dbPath, join(home, 'data', 'life.db'))
  assert.equal(info.value.workspace, layout.workspace)
  assert.equal(info.value.schemaVersion, SCHEMA_VERSION)

  const backup = await handle('backup', {})
  assert.equal(backup.ok, true)
  assert.match(backup.value.name, /^dsh-living-life-.*\.db$/)
  assert.ok(Buffer.from(backup.value.data, 'base64').length > 0)

  const staged = await handle('importBackup', { name: 'memory.db', data: backup.value.data })
  assert.equal(staged.ok, true)
  assert.equal(staged.value.restartRequired, true)
  assert.equal(staged.value.name, 'memory.db')
  assert.equal((await handle('importStatus', {})).value.name, 'memory.db')

  const cancelled = await handle('importCancel', {})
  assert.equal(cancelled.value.cancelled, true)
  assert.equal((await handle('importStatus', {})).value, null)

  const invalid = await handle('importBackup', { name: 'x.db', data: 'aGVsbG8=' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'living_admin_error')
})
