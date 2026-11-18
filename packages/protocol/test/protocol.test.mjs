import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateWorldGem,
  validateGemConfigValues,
  normalizeIngest,
  validateAck,
  isRetryable,
  FAILURE_CODES,
  ERR,
  ProtocolError,
} from '../index.js'

const good = {
  id: 'bili',
  name: 'B站',
  version: '0.1.0',
  mcp: { command: 'node', args: ['mcp/server.js'], tools: ['bili_search'] },
  event: { protocol: ['ingest', 'outbox', 'ack'], visibility: 'public' },
  skill: 'skill/SKILL.md',
  capabilities: { text: true, voice: false },
  limits: { maxChars: 4000, perMinute: 10 },
  etiquette: ['公网发言必须过限制层'],
  failure_hints: { gem_cookie_expired: '登录态失效' },
}

// ── manifest ────────────────────────────────────────────────────────────

test('合法清单通过', () => {
  const r = validateWorldGem(good)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('三件全无 → 拒绝', () => {
  const r = validateWorldGem({ id: 'x1', name: 'X', version: '0.0.1' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.path === ''))
})

test('只有 skill 也算一件', () => {
  const r = validateWorldGem({ id: 'x1', name: 'X', version: '0.0.1', skill: 'skill/SKILL.md' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('channel 声明：command 必填，且必须同时声明 event', () => {
  const ok = validateWorldGem({ ...good, channel: { command: 'node', args: ['channel/run.mjs'] } })
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))

  const missingCommand = validateWorldGem({ ...good, channel: { command: '' } })
  assert.equal(missingCommand.ok, false)
  assert.ok(missingCommand.errors.some((e) => e.path === 'channel.command'))

  const badArgs = validateWorldGem({ ...good, channel: { command: 'node', args: [1] } })
  assert.equal(badArgs.ok, false)
  assert.ok(badArgs.errors.some((e) => e.path === 'channel.args'))

  const noEvent = validateWorldGem({ id: 'x1', name: 'X', version: '0.0.1', skill: 'skill/SKILL.md', channel: { command: 'node' } })
  assert.equal(noEvent.ok, false)
  assert.ok(noEvent.errors.some((e) => e.path === 'channel'))
})

test('id 不合法 → 拒绝', () => {
  for (const id of ['X1', '1abc', 'a', 'a b', 'a'.repeat(40)]) {
    const r = validateWorldGem({ ...good, id })
    assert.equal(r.ok, false, `应当拒绝 id=${id}`)
    assert.ok(r.errors.some((e) => e.path === 'id'))
  }
})

test('event 必须支持 ingest', () => {
  const r = validateWorldGem({ ...good, event: { protocol: ['outbox'], visibility: 'private' } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.path === 'event.protocol'))
})

test('visibility 只能三选一', () => {
  const r = validateWorldGem({ ...good, event: { protocol: ['ingest'], visibility: 'secret' } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.path === 'event.visibility'))
})

test('未知失败码 → 拒绝（码表在核心）', () => {
  const r = validateWorldGem({ ...good, failure_hints: { whatever: '文案' } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.path === 'failure_hints.whatever'))
})

test('限制值必须是正整数', () => {
  const r = validateWorldGem({ ...good, limits: { perMinute: 0 } })
  assert.equal(r.ok, false)
})

test('notify：合法 ring/silent 与预算开关通过', () => {
  const r = validateWorldGem({
    ...good,
    notify: {
      push: { mode: 'ring', budget: { limit: true, count: true } },
      trusted: { mode: 'silent', budget: { limit: false, count: false } },
    },
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('notify：未知字段 / 未知 mode / 非布尔预算 → 拒绝', () => {
  const badMode = validateWorldGem({ ...good, notify: { push: { mode: 'vibrate' } } })
  assert.ok(badMode.errors.some((e) => e.path === 'notify.push.mode'))

  const badKey = validateWorldGem({ ...good, notify: { push: { budget: { cap: true } } } })
  assert.ok(badKey.errors.some((e) => e.path === 'notify.push.budget.cap'))

  const badType = validateWorldGem({ ...good, notify: { push: { budget: { limit: 'yes' } } } })
  assert.ok(badType.errors.some((e) => e.path === 'notify.push.budget.limit'))

  const badAudience = validateWorldGem({ ...good, notify: { everyone: {} } })
  assert.ok(badAudience.errors.some((e) => e.path === 'notify.everyone'))
})

test('notify：没有 event 的宝石不能声明通知', () => {
  const r = validateWorldGem({ id: 'x1', name: 'X', version: '0.0.1', skill: 'skill/SKILL.md', notify: { push: {} } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.path === 'notify'))
})

// ── ingest ──────────────────────────────────────────────────────────────

test('normalizeIngest 保留 external_id 并补默认值', () => {
  const n = normalizeIngest({
    gem: 'bili',
    kind: 'message',
    external_id: 'dm_1',
    from: { id: 'uid_9' },
    text: '在吗',
    ts: 1763356800,
  })
  assert.deepEqual(n, {
    gem: 'bili',
    kind: 'message',
    external_id: 'dm_1',
    from: { id: 'uid_9', name: '' },
    text: '在吗',
    ts: 1763356800,
    meta: {},
  })
})

test('缺 external_id → 抛 ingest_invalid（长轮询会重投）', () => {
  assert.throws(
    () => normalizeIngest({ gem: 'bili', kind: 'message', from: { id: 'u' }, text: 'x' }),
    (e) => e instanceof ProtocolError && e.code === ERR.INGEST_INVALID && /external_id/.test(e.message),
  )
})

test('kind=message 必须有 text；notice 可以没有', () => {
  assert.throws(
    () => normalizeIngest({ gem: 'g', kind: 'message', external_id: 'e1', from: { id: 'u' } }),
    (e) => e.code === ERR.INGEST_INVALID,
  )
  const n = normalizeIngest({ gem: 'g', kind: 'notice', external_id: 'e2', from: { id: 'u' } })
  assert.equal(n.text, '')
  assert.equal(n.ts, null)
})

test('未知 kind → 拒绝', () => {
  assert.throws(
    () => normalizeIngest({ gem: 'g', kind: 'weird', external_id: 'e3', from: { id: 'u' } }),
    (e) => e.code === ERR.INGEST_INVALID,
  )
})

// ── ack ─────────────────────────────────────────────────────────────────

test('ack 必须给明确成败', () => {
  assert.deepEqual(validateAck({ ok: true, external_id: 'x' }), {
    ok: true,
    code: null,
    external_id: 'x',
    quota: null,
  })
  assert.throws(() => validateAck({}), (e) => e.code === ERR.ACK_INVALID)
  assert.throws(() => validateAck({ ok: 'yes' }), (e) => e.code === ERR.ACK_INVALID)
})

test('回执可带主动额度快照；形状不对大声失败', () => {
  assert.deepEqual(validateAck({ ok: true, quota: { day: '2026-11-18', cap: 20, sent: 3 } }), {
    ok: true,
    code: null,
    external_id: null,
    quota: { day: '2026-11-18', cap: 20, sent: 3 },
  })
  assert.throws(() => validateAck({ ok: true, quota: { day: 'x', cap: 20, sent: 3 } }), (e) => e.code === ERR.ACK_INVALID)
  assert.throws(() => validateAck({ ok: true, quota: { day: '2026-11-18', cap: -1, sent: 3 } }), (e) => e.code === ERR.ACK_INVALID)
})

test('失败回执的 code 必须在码表内', () => {
  const r = validateAck({ ok: false, code: FAILURE_CODES.WINDOW_CLOSED })
  assert.equal(r.code, 'window_closed')
  assert.throws(() => validateAck({ ok: false, code: 'nope' }), (e) => e.code === ERR.ACK_INVALID)
})

// ── 重试策略 ────────────────────────────────────────────────────────────

test('重试只给可能有用的失败（D-25）', () => {
  assert.equal(isRetryable(FAILURE_CODES.PROVIDER_TIMEOUT), true)
  assert.equal(isRetryable(FAILURE_CODES.PROVIDER_RATE), true)
  assert.equal(isRetryable(FAILURE_CODES.GEM_UNAVAILABLE), true)
  assert.equal(isRetryable(FAILURE_CODES.PROVIDER_AUTH), false)
  assert.equal(isRetryable(FAILURE_CODES.PROVIDER_QUOTA), false)
  assert.equal(isRetryable(FAILURE_CODES.GEM_COOKIE_EXPIRED), false, '登录态失效重试无益')
  assert.equal(isRetryable(FAILURE_CODES.WINDOW_CLOSED), false)
  assert.equal(isRetryable(FAILURE_CODES.INTERRUPTED), false, '被中断的轮次不自动重试')
  assert.equal(isRetryable('unknown'), true, '未知码宁可试一次，不静默放弃')
})

// ── 宝石配置 UI 声明 ────────────────────────────────────────────────────

const goodConfig = {
  fields: [
    { key: 'dmPollSeconds', label: '私信轮询', type: 'number', default: 30, min: 15, max: 600, step: 5, unit: '秒' },
    { key: 'ownerUid', label: '主人 UID', type: 'text', default: '', help: '主人私信免判决' },
    { key: 'mode', label: '模式', type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'users', label: '用户', type: 'list', itemType: 'string', default: [] },
    { key: 'enabled', label: '启用', type: 'boolean', default: true },
  ],
}

test('合法的 config 声明通过', () => {
  const r = validateWorldGem({ ...good, config: goodConfig })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('config：未知字段属性 / 未知类型 / 重复 key → 拒绝', () => {
  const unknownProp = validateWorldGem({ ...good, config: { fields: [{ key: 'a', label: 'A', type: 'text', cap: 1 }] } })
  assert.ok(unknownProp.errors.some((e) => e.path === 'config.fields[0].cap'))

  const badType = validateWorldGem({ ...good, config: { fields: [{ key: 'a', label: 'A', type: 'color' }] } })
  assert.ok(badType.errors.some((e) => e.path === 'config.fields[0].type'))

  const duplicate = validateWorldGem({
    ...good,
    config: { fields: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }] },
  })
  assert.ok(duplicate.errors.some((e) => e.path === 'config.fields[1].key'))
})

test('config：select 必须有 options，number 的 min/max 必须有序', () => {
  const noOptions = validateWorldGem({ ...good, config: { fields: [{ key: 'a', label: 'A', type: 'select' }] } })
  assert.ok(noOptions.errors.some((e) => e.path === 'config.fields[0].options'))

  const badDefault = validateWorldGem({
    ...good,
    config: { fields: [{ key: 'a', label: 'A', type: 'select', default: 'z', options: [{ value: 'a', label: 'A' }] }] },
  })
  assert.ok(badDefault.errors.some((e) => e.path === 'config.fields[0].default'))

  const inverted = validateWorldGem({ ...good, config: { fields: [{ key: 'a', label: 'A', type: 'number', min: 10, max: 1 }] } })
  assert.ok(inverted.errors.some((e) => e.path === 'config.fields[0].min'))
})

test('config 值校验：类型、范围、选项、必填；未知 key 允许', () => {
  const ok = validateGemConfigValues(goodConfig.fields, { dmPollSeconds: 30, ownerUid: '1', mode: 'a', users: [], extra: 'kept' })
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))

  const bad = validateGemConfigValues(goodConfig.fields, {
    dmPollSeconds: 5,
    ownerUid: 7,
    mode: 'z',
    users: [1],
    enabled: 'yes',
  })
  const paths = bad.errors.map((e) => e.path)
  assert.ok(paths.includes('config.dmPollSeconds'))
  assert.ok(paths.includes('config.ownerUid'))
  assert.ok(paths.includes('config.mode'))
  assert.ok(paths.includes('config.users'))
  assert.ok(paths.includes('config.enabled'))

  const required = validateGemConfigValues([{ key: 'x', label: 'X', type: 'text', required: true }], {})
  assert.ok(required.errors.some((e) => e.path === 'config.x'))
})
