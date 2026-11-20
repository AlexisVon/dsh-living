import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { createRuntime, RUNTIME_STATUS } from '../lib/runtime.mjs'
import { collectMemoryItems } from '../lib/memory.mjs'
import { encodeVector } from '../lib/embed.mjs'
import { createClockState, dayKey } from '../lib/clock.mjs'
import { gemNotifyPolicies } from '../lib/gems.mjs'

const TZ = 480
const MIN = 60000
const HOUR = 3600000
const DAY = 86400000
const NOW = Date.UTC(2026, 10, 17, 2) // 10:00 UTC+8

function baseConfig(over = {}) {
  return {
    l0Tokens: 500,
    tzOffsetMinutes: TZ,
    clock: {
      tzOffsetMinutes: TZ,
      autoWake: {
        gridMinutes: 10,
        sampleSeconds: 30,
        normalExpected: 0.1,
        lowExpected: 0.05,
        highExpected: 0.2,
        hotRanges: [[6, 8], [12, 14], [18, 24]],
        coldRanges: [[0, 6]],
      },
      nightAtMinutes: 3 * 60 + 30,
      nightWindowMinutes: 360,
    },
    budget: { tzOffsetMinutes: TZ, dailyTokens: 1_000_000, dailyRounds: 100, roundTokens: 100_000 },
    gemTokens: { bili: 't-bili' },
    gemLimits: { bili: { perMinute: 100 } },
    ...over,
  }
}

async function setup(t, { config = {}, runner = null, adjudicate = null, rotateSession = null, evolvePersona = null, extractMemory = null, recollector = null, embedder = null, upgradeGems = null, clock = { now: NOW }, gems = [], seed = {}, wakeSchedule = () => {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'living-runtime-'))
  const store = createStore({ path: join(home, 'life.db'), now: () => clock.now })
  for (const [key, value] of Object.entries(seed)) await store.setState(key, value)
  const rt = createRuntime({
    home,
    store,
    gems,
    config: baseConfig(config),
    runner,
    adjudicate,
    rotateSession,
    evolvePersona,
    extractMemory,
    recollector,
    embedder,
    upgradeGems,
    now: () => clock.now,
    rng: () => 0,
    logger: { error: () => {}, warn: () => {} },
    wakeSchedule,
  })
  t.after(async () => {
    await store.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, store, rt, clock }
}

function collector() {
  const calls = []
  const runner = async ({ prompt }) => {
    calls.push(prompt)
    return { tokens: 10, outcome: 'ok', sessionId: 's1' }
  }
  return { calls, runner }
}

function fakeEmbedder({ throwOnEmbed = false, uniform = false, models = [{ name: 'fake-embed', digest: 'sha256:v1', embedding: true }] } = {}) {
  return {
    models,
    async listModels() {
      return models
    },
    async embed({ input }) {
      if (throwOnEmbed) throw new Error('embed_down')
      const texts = Array.isArray(input) ? input : [input]
      return texts.map((text) => (uniform ? [1, 0] : (String(text).includes('显卡') ? [1, 0] : [0, 1])))
    },
  }
}

test('自动唤醒：起一轮、写锚点与事件、预算计一轮', async (t) => {
  const { calls, runner } = collector()
  const { rt, store } = await setup(t, { runner })
  const { decision, status } = await rt.tick()
  assert.equal(decision.action, 'wake')
  assert.equal(decision.trigger, 'auto')
  assert.equal(calls.length, 1)
  assert.equal(status, RUNTIME_STATUS.RUNNING)

  const rounds = store.listRounds({ limit: 10 })
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].outcome, 'ok')
  assert.equal(rounds[0].trigger, 'auto')
  assert.equal(rt.snapshot().budget.rounds, 1)
  assert.equal(rt.snapshot().budget.tokensUsed, 10, '真实用量必须进入预算')
})

test('人格与技能进会话静态前缀，不进本轮 prompt', async (t) => {
  const { calls, runner } = collector()
  const { rt, store } = await setup(t, { runner })
  await store.setPersonaDoc({ kind: 'charter', text: 'CHARTER-TEXT' })
  await store.setPersonaDoc({ kind: 'self', text: '我在想散热的事' })

  const prelude = rt.service().prelude()
  assert.ok(prelude.includes('CHARTER-TEXT'))
  assert.ok(prelude.includes('我在想散热的事'))
  assert.ok(prelude.includes('## 外部内容边界'))

  await rt.tick()
  assert.ok(!calls[0].includes('我在想散热的事'), '本轮 prompt 不应重复注入人格')
  assert.ok(!calls[0].includes('## 外部内容边界'), '信任边界属于静态前缀')
})

test('静态前缀包含全部宝石 skill（含暂时不可用的）', async (t) => {
  const gem = {
    manifest: { id: 'example', name: '示例', version: '0.1.0', capabilities: {}, limits: {}, etiquette: [], failure_hints: {} },
    skill: '示例宝石说明',
  }
  const { rt } = await setup(t, { runner: async () => ({ tokens: 0 }), gems: [gem] })
  assert.ok(rt.service().prelude().includes('示例宝石说明'))
})

test('预算耗尽：不叫模型，状态 BUDGET_HOLD', async (t) => {
  const { calls, runner } = collector()
  const { rt } = await setup(t, { runner, config: { budget: { tzOffsetMinutes: TZ, dailyRounds: 0, dailyTokens: 1000, roundTokens: 100 } } })
  const { status } = await rt.tick()
  assert.equal(calls.length, 0)
  assert.equal(status, RUNTIME_STATUS.BUDGET_HOLD)
})

test('进入 BUDGET_HOLD 写事件，同一天不重复', async (t) => {
  const { calls, runner } = collector()
  const { rt, store } = await setup(t, { runner, config: { budget: { tzOffsetMinutes: TZ, dailyRounds: 0, dailyTokens: 1000, roundTokens: 100 } } })
  await rt.tick()
  await rt.tick()
  const events = store.listEvents({ kind: 'budget_exhausted', limit: 100 })
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.which, 'rounds')
  assert.equal(calls.length, 0)
})

test('次日预算恢复：状态回到 RUNNING 并写 budget_resumed', async (t) => {
  const { runner } = collector()
  const clock = { now: NOW }
  const { rt, store } = await setup(t, {
    runner,
    clock,
    config: { budget: { tzOffsetMinutes: TZ, dailyRounds: 1, dailyTokens: 1000, roundTokens: 100 } },
  })
  await rt.tick()
  const held = await rt.tick()
  assert.equal(held.status, RUNTIME_STATUS.BUDGET_HOLD)

  clock.now = NOW + DAY
  const resumed = await rt.tick()
  assert.equal(resumed.status, RUNTIME_STATUS.RUNNING)
  assert.equal(store.listEvents({ kind: 'budget_resumed', limit: 10 }).length, 1)
})

test('日程到期：本轮指令带意图，完成后标记 done', async (t) => {
  const { calls, runner } = collector()
  const { rt } = await setup(t, { runner })
  await rt.service().plan([{ id: 's1', at: NOW - 10 * MIN, intent: '写日报' }])
  const { decision } = await rt.tick()
  assert.equal(decision.trigger, 'schedule')
  assert.ok(calls[0].includes('写日报'))
  assert.equal(rt.snapshot().schedule.find((item) => item.id === 's1').done, true)
})

test('事件醒：处理后游标前移，同一事件不重复起轮', async (t) => {
  const { calls, runner } = collector()
  const clock = { now: NOW }
  const { rt } = await setup(t, {
    runner,
    clock,
    config: { clock: { tzOffsetMinutes: TZ, hMin: 0, hMax: 0, cooldownMinutes: 0, exploreProb: 0 } },
  })
  const ingested = await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'dm_1', from: { id: 'u1' }, text: '在吗', ts: NOW, meta: { reply_to: 'uid:u1' } },
    nowMs: NOW,
  })
  assert.equal(ingested.accepted, true)

  const first = await rt.tick()
  assert.equal(first.decision.trigger, 'event')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('在吗'), '事件正文必须进当轮 prompt')
  assert.ok(calls[0].includes('回复目标: uid:u1'), '回复地址必须进 prompt')

  clock.now = NOW + 1
  const second = await rt.tick()
  assert.notEqual(second.decision.trigger, 'event')
  assert.equal(calls.length, 1)
})

test('service.events 可读待处理事件（轮次未消费）', async (t) => {
  const { rt } = await setup(t, { config: { clock: { tzOffsetMinutes: TZ, hMin: 0, hMax: 0, cooldownMinutes: 0, exploreProb: 0 } } })
  await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'evt_a', from: { id: 'u1' }, text: '第一条', ts: NOW },
    nowMs: NOW,
  })
  await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'evt_b', from: { id: 'u2' }, text: '第二条', ts: NOW + 1 },
    nowMs: NOW + 1,
  })
  const events = rt.service().events({ limit: 10 })
  assert.deepEqual(events.map((event) => event.payload.text), ['第一条', '第二条'])
  assert.deepEqual(rt.service().events({ since: NOW + 1 }).map((event) => event.payload.text), ['第二条'])
})

test('连续 3 轮失败进入 DEGRADED', async (t) => {
  const runner = async () => {
    throw new Error('boom')
  }
  const clock = { now: NOW }
  const { rt } = await setup(t, { runner, clock })
  await rt.tick()
  clock.now = NOW + 30_000
  await rt.tick()
  clock.now = NOW + 60_000
  await rt.tick()
  assert.equal(rt.snapshot().status, RUNTIME_STATUS.DEGRADED)
  assert.equal(rt.snapshot().failures, 3)
})

test('执行结果 error：计入失败，连续 3 次进 DEGRADED', async (t) => {
  const clock = { now: NOW }
  const { rt } = await setup(t, {
    clock,
    runner: async () => ({ tokens: 5, outcome: 'error', errorCode: 'provider_auth', sessionId: 's1' }),
  })
  await rt.tick()
  clock.now = NOW + 30_000
  await rt.tick()
  clock.now = NOW + 60_000
  await rt.tick()
  assert.equal(rt.snapshot().failures, 3)
  assert.equal(rt.snapshot().status, RUNTIME_STATUS.DEGRADED)
  assert.equal(rt.snapshot().budget.tokensUsed, 15, '失败轮次也消耗已发生 token')
  assert.equal(rt.snapshot().lastError, 'provider_auth')
})

test('预算抑制只写一条事件（状态变化时），跨日恢复再写一条', async (t) => {
  const clock = { now: NOW }
  const { runner } = collector()
  const { rt, store } = await setup(t, {
    runner,
    clock,
    config: {
      clock: { tzOffsetMinutes: TZ, hMin: 1, hMax: 1, exploreProb: 1, cooldownMinutes: 0, selfWakeLimit: 12 },
      budget: { tzOffsetMinutes: TZ, dailyTokens: 10, dailyRounds: 100, roundTokens: 1000 },
    },
  })
  await rt.tick()
  assert.equal(rt.snapshot().budget.tokensUsed, 10)

  clock.now = NOW + 60_000
  await rt.tick()
  clock.now = NOW + 2 * 60_000
  await rt.tick()
  const suppressed = store.listEvents({ limit: 200 }).filter((event) => event.kind === 'round_suppressed')
  assert.equal(suppressed.length, 1, '同一 reason 不重复写')
  assert.equal(suppressed[0].payload.reason, 'budget')
  assert.equal(rt.snapshot().status, RUNTIME_STATUS.BUDGET_HOLD)

  clock.now = NOW + 25 * 3600_000
  await rt.tick()
  const resumed = store.listEvents({ limit: 200 }).filter((event) => event.kind === 'round_resumed')
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].payload.after, 'budget')
})

test('并发 tick 只起一轮（in-flight 守卫）', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const runner = async () => {
    await gate
    return { tokens: 0, outcome: 'ok', sessionId: 's1' }
  }
  const { rt, store } = await setup(t, { runner })
  const first = rt.tick()
  const second = await rt.tick()
  assert.equal(second.decision.reason, 'busy')
  release()
  await first
  assert.equal(store.listRounds({ limit: 10 }).length, 1)
})

test('一条 message 事件跑 10 个 tick 最多起 1 轮', async (t) => {
  const clock = { now: NOW }
  const { rt, store } = await setup(t, {
    runner: async () => ({ tokens: 1, outcome: 'ok', sessionId: 's1' }),
    clock,
    config: { clock: { tzOffsetMinutes: TZ, hMin: 0, hMax: 0, cooldownMinutes: 0, exploreProb: 0 } },
  })
  await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'once', from: { id: 'u1' }, text: '在吗', ts: NOW },
    nowMs: NOW,
  })
  for (let i = 0; i < 10; i += 1) {
    clock.now = NOW + i * 1000
    await rt.tick()
  }
  assert.equal(store.listRounds({ limit: 10 }).length, 1)
})

test('旧的 budget.holdDay 不再锁天：重启直接 RUNNING', async (t) => {
  const { rt } = await setup(t, { runner: collector().runner, seed: { 'budget.holdDay': '2026-11-17' } })
  assert.equal(rt.snapshot().status, RUNTIME_STATUS.RUNNING)
})

test('宝石静默：旧未 claim 的 outbox 让宝石不可用且只记一条事件', async (t) => {
  const clock = { now: NOW }
  const { calls, runner } = collector()
  const gem = {
    manifest: { id: 'example', name: '示例', version: '0.1.0', capabilities: {}, limits: { perMinute: 100 }, etiquette: [], failure_hints: {} },
    skill: '示例宝石说明',
  }
  const { rt, store } = await setup(t, {
    runner,
    clock,
    gems: [gem],
    config: { gemSilenceMinutes: 10, gemTokens: { example: 't-example' }, gemLimits: { example: { perMinute: 100 } } },
  })
  await store.enqueueOutbox({ gem: 'example', to: 'u', text: 'x', createdAt: NOW - 11 * MIN })
  await rt.tick()

  assert.ok(calls[0].includes('本轮不可用：example'))
  assert.ok(!calls[0].includes('示例宝石说明'), '静默宝石的 skill 应被摘掉')
  assert.equal(rt.service().gemHealth()[0].lastError, 'gem_unavailable')

  clock.now = NOW + MIN
  await rt.tick()
  const silent = store.listEvents({ limit: 200 }).filter((event) => event.kind === 'gem_silent')
  assert.equal(silent.length, 1, '同一段静默只记一条事件')
  assert.equal(silent[0].payload.gem, 'example')
  assert.equal(silent[0].payload.pending, 1)
})

test('宝石静默：待人工审批的 outbox 不算通道静默', async (t) => {
  const { calls, runner } = collector()
  const gem = {
    manifest: { id: 'example', name: '示例', version: '0.1.0', capabilities: {}, limits: { perMinute: 100 }, etiquette: [], failure_hints: {} },
    skill: '示例宝石说明',
  }
  const { rt, store } = await setup(t, {
    runner,
    gems: [gem],
    config: { gemSilenceMinutes: 10, gemTokens: { example: 't-example' }, gemLimits: { example: { perMinute: 100 } } },
  })
  const id = await store.enqueueOutbox({ gem: 'example', to: 'u', text: 'x', createdAt: NOW - 11 * MIN })
  await store.deferOutbox(id, Number.MAX_SAFE_INTEGER, '非白名单外发需确认')
  await rt.tick()

  assert.ok(rt.service().prelude().includes('示例宝石说明'), '待审条目不应把宝石判成静默')
  assert.equal(store.listEvents({ limit: 200 }).filter((event) => event.kind === 'gem_silent').length, 0)
})

test('宝石级降级：本轮注记不可用，skill 留在静态前缀，冷却后半开恢复', async (t) => {
  const clock = { now: NOW }
  const { calls, runner } = collector()
  const gem = {
    manifest: { id: 'example', name: '示例', version: '0.1.0', capabilities: {}, limits: { perMinute: 100 }, etiquette: [], failure_hints: {} },
    skill: '示例宝石说明',
  }
  const { rt, store } = await setup(t, {
    runner,
    clock,
    gems: [gem],
    config: { gemTokens: { example: 't-example' }, gemLimits: { example: { perMinute: 100 } } },
  })
  await store.enqueueOutbox({ gem: 'example', to: 'u', text: 'x', createdAt: NOW })
  const [item] = await rt.channel.pullOutbox({ gem: 'example', token: 't-example', nowMs: NOW })
  await rt.channel.ack({ gem: 'example', token: 't-example', id: item.id, body: { ok: false, code: 'gem_unavailable' }, nowMs: NOW })

  const health = rt.service().gemHealth()
  assert.equal(health[0].available, false)
  assert.equal(health[0].lastError, 'gem_unavailable')

  await rt.tick()
  assert.ok(calls[0].includes('本轮不可用：example'))
  assert.ok(!calls[0].includes('示例宝石说明'), 'skill 属于静态前缀，不随轮次重复')
  assert.ok(rt.service().prelude().includes('示例宝石说明'))

  clock.now = NOW + 61_000
  await rt.tick()
  assert.ok(!calls[1].includes('本轮不可用：example'), '冷却后应半开恢复')
  assert.ok(rt.service().prelude().includes('示例宝石说明'))
})

test('rest 生成情节；夜睡产生降维候选', async (t) => {
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }) })
  await store.appendEvent({ id: 'e1', ts: NOW - 3 * HOUR, kind: 'message', payload: { text: '早上修显卡' } })
  await store.appendEvent({ id: 'e2', ts: NOW - 2 * HOUR, kind: 'message', payload: { text: '换了风扇' } })
  const rest = await rt.consolidate('rest')
  assert.ok(rest.episodes >= 1)
  assert.ok(store.listEpisodes({ limit: 10 }).length >= 1)

  await store.appendEvent({ id: 'old', ts: NOW - 1000 * DAY, kind: 'message', payload: { text: '显卡散热坏了' } })
  const night = await rt.sleep('night')
  assert.ok(night.demotions >= 1)
  assert.ok(store.listCold({ limit: 10 }).length >= 1)
})

test('sleep 缺 session 时在轨迹写 raw_fallback', async (t) => {
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }) })
  await store.appendEvent({ id: 'e1', ts: NOW - HOUR, kind: 'message', payload: { text: '早上修显卡' } })
  await rt.sleep('night')
  const [event] = store.listEvents({ kind: 'raw_fallback', limit: 10 })
  assert.ok(event, '应写 raw_fallback')
  assert.equal(event.payload.kind, 'night')
  assert.equal(event.payload.reason, 'session_unavailable')
  assert.equal(event.payload.source, 'events')
  assert.ok(event.payload.messages >= 1)
})

test('night 一次处理完全部 pending raw，再用结果演化', async (t) => {
  const calls = []
  let evolved = 0
  const extractMemory = async ({ segments }) => {
    calls.push(segments.map((segment) => segment.id))
    return {
      ok: true,
      tokens: 5,
      items: [{
        kind: 'episode',
        title: `批次 ${calls.length}`,
        description: '摘要',
        importance: 0.5,
        confidence: 0.8,
        tsStart: segments[0].tsStart,
        tsEnd: segments[0].tsStart,
        raw: segments[0].id,
        facets: {},
      }],
      edges: [],
    }
  }
  const evolvePersona = async () => {
    evolved += 1
    return { ok: true, text: 'SELF', tokens: 2 }
  }
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }), extractMemory, evolvePersona })
  for (let index = 0; index < 13; index += 1) {
    await store.appendRawSegment({
      id: `raw_journal_j${index}`,
      kind: 'journal',
      tsStart: NOW - HOUR + index,
      tsEnd: NOW - HOUR + index,
      payload: { source: 'journal', messages: [{ role: 'journal', ts: NOW - HOUR + index, text: `日记 ${index}` }] },
    })
  }
  const night = await rt.sleep('night')
  assert.equal(night.rawPending, 0)
  assert.equal(night.evolution?.ok, true)
  assert.equal(evolved, 1)
  assert.equal(calls.length, 3)
  assert.equal(store.countRawSegments({ status: 'pending' }), 0)
})

test('night 自动检查宝石更新：变更写 silent 事件，失败不打断睡眠', async (t) => {
  let mode = 'ok'
  const upgradeGems = async () => {
    if (mode === 'throw') throw new Error('registry_down')
    return [
      { id: 'petkit', changed: true, version: '0.1.1', previousVersion: '0.1.0', latestVersion: '0.1.1' },
      { id: 'wechat', changed: false, version: '0.2.0', previousVersion: '0.2.0', latestVersion: '0.2.0' },
      { id: 'bili', error: 'network' },
    ]
  }
  const evolvePersona = async () => ({ ok: true, text: 'SELF', tokens: 1 })
  const { rt, store } = await setup(t, { upgradeGems, evolvePersona })

  const night = await rt.sleep('night')
  assert.equal(night.gemUpgrades.length, 3)
  const [change] = store.listEvents({ kind: 'change', limit: 10 })
  assert.equal(change.payload.meta.silent, true)
  assert.deepEqual(change.payload.meta.gems, ['petkit'])
  assert.match(change.payload.text, /0\.1\.0→0\.1\.1/)
  assert.ok(store.getState('gems.lastUpgrade'))
  assert.ok(store.getState('gems.lastUpgradeError'))

  mode = 'throw'
  const second = await rt.sleep('night')
  assert.match(second.gemUpgrades[0].error, /registry_down/)
})

test('手动 sleep 可选不限制 token：预算耗尽也清空 raw 并演化', async (t) => {
  let evolved = 0
  const extractMemory = async ({ segments }) => ({
    ok: true,
    tokens: 10,
    items: [{
      kind: 'episode',
      title: 't',
      description: 'd',
      importance: 0.5,
      confidence: 0.8,
      tsStart: segments[0].tsStart,
      tsEnd: segments[0].tsStart,
      raw: segments[0].id,
      facets: {},
    }],
    edges: [],
  })
  const evolvePersona = async () => {
    evolved += 1
    return { ok: true, text: 'SELF', tokens: 2 }
  }
  const { rt, store } = await setup(t, {
    extractMemory,
    evolvePersona,
    seed: { budget: { day: dayKey(NOW, TZ), tokensUsed: 1_000_000, rounds: 0 } },
  })
  await store.appendRawSegment({
    id: 'raw_journal_unlimited',
    kind: 'journal',
    tsStart: NOW - HOUR,
    tsEnd: NOW - HOUR,
    payload: { messages: [{ role: 'journal', ts: NOW - HOUR, text: 'x' }] },
  })
  const result = await rt.service().manualSleep('night', { unlimited: true })
  assert.equal(result.ok, true)
  assert.equal(result.unlimited, true)
  assert.equal(result.rawPending, 0)
  assert.equal(evolved, 1)
  assert.equal(rt.snapshot().budget.tokensUsed, 1_000_012)
})

test('raw 卡住时跳过并记录，pending 未清空则跳过自动演化', async (t) => {
  let evolved = 0
  const extractMemory = async () => {
    throw new Error('memory_extract_timeout')
  }
  const evolvePersona = async () => {
    evolved += 1
    return { ok: true, text: 'SELF', tokens: 2 }
  }
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }), extractMemory, evolvePersona })
  for (let index = 0; index < 6; index += 1) {
    await store.appendRawSegment({
      id: `raw_journal_stuck${index}`,
      kind: 'journal',
      tsStart: NOW - HOUR + index,
      tsEnd: NOW - HOUR + index,
      payload: { source: 'journal', messages: [{ role: 'journal', ts: NOW - HOUR + index, text: `卡住 ${index}` }] },
    })
  }
  const night = await rt.sleep('night')
  assert.equal(night.rawPending, 6)
  assert.equal(night.evolution?.skipped, 'raw_pending')
  assert.equal(evolved, 0)
  const [skipped] = store.listEvents({ kind: 'persona_evolve_skipped', limit: 5 })
  assert.equal(skipped.payload.reason, 'raw_pending')
  const [failed] = store.listEvents({ kind: 'memory_extract_failed', limit: 5 })
  assert.match(failed.payload.error, /memory_extract_timeout/)
})

test('memorySegments：自动选第一个 embedding 模型并落向量索引', async (t) => {
  const { rt, store } = await setup(t, { embedder: fakeEmbedder() })
  await store.appendEvent({ id: 'e1', ts: NOW - 2 * HOUR, kind: 'message', payload: { text: '早上修显卡散热' } })
  await store.appendEvent({ id: 'e2', ts: NOW - HOUR, kind: 'message', payload: { text: '中午吃面条' } })

  const result = await rt.service().memorySegments({ key: '显卡' })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'embed')
  assert.equal(result.degraded, false)
  assert.equal(result.model, 'fake-embed')
  assert.equal(result.segments.length, 1)
  assert.ok(result.segments[0].confidence >= 0.35)
  assert.ok(result.segments[0].from <= NOW - 2 * HOUR)
  assert.ok(result.segments[0].to >= NOW - HOUR)
  assert.equal(result.digest, 'sha256:v1')
  assert.equal(rt.service().embedConfig().model, 'fake-embed')
  assert.equal(rt.service().embedConfig().index.signature, 'sha256:v1')
  assert.equal(store.countMemoryVectors({ model: 'sha256:v1' }), 2)
})

test('memorySegments：embed 失败时词法兜底并标 degraded', async (t) => {
  const { rt, store } = await setup(t, { embedder: fakeEmbedder({ throwOnEmbed: true }) })
  await store.appendEvent({ id: 'e1', ts: NOW - 2 * HOUR, kind: 'message', payload: { text: '早上修显卡散热' } })

  const result = await rt.service().memorySegments({ key: '显卡' })
  assert.equal(result.source, 'lexical')
  assert.equal(result.degraded, true)
  assert.match(result.error, /embed_down/)
  assert.equal(result.segments.length, 1)
})

test('memorySegments：低于 minConfidence 的区段不返回', async (t) => {
  const { rt, store } = await setup(t, {
    embedder: fakeEmbedder({ uniform: true }),
    seed: { 'embed.config': { model: 'fake-embed', minConfidence: 0.9 } },
  })
  await store.appendEvent({ id: 'e1', ts: NOW - 2 * HOUR, kind: 'message', payload: { text: '早上修显卡散热' } })

  const result = await rt.service().memorySegments({ key: '显卡' })
  assert.equal(result.source, 'none')
  assert.equal(result.segments.length, 0)
})

test('memoryScan：from/to 限定区段', async (t) => {
  const { rt, store } = await setup(t)
  await store.appendEvent({ id: 'e1', ts: NOW - 3 * HOUR, kind: 'message', payload: { text: '三条前' } })
  await store.appendEvent({ id: 'e2', ts: NOW - 2 * HOUR, kind: 'message', payload: { text: '两条前' } })
  await store.appendEvent({ id: 'e3', ts: NOW - HOUR, kind: 'message', payload: { text: '一条前' } })
  const context = {
    detail: 'brief',
    mode: 'lookup',
    maxScans: 8,
    stats: { scans: 0, candidates: 0, truncated: false, hitLimit: false, minTs: null, maxTs: null, ranges: [] },
  }

  const page = rt.service().memoryScan({ sources: ['events'], from: NOW - 2.5 * HOUR, to: NOW - 1.5 * HOUR, limit: 10 }, context)
  assert.deepEqual(page.rows.map((row) => row.id), ['e2'])
  assert.deepEqual(context.stats.ranges, [{ from: NOW - 2.5 * HOUR, to: NOW - 1.5 * HOUR }])
})

test('embedConfigSave：模型变更清空向量，非法值拒绝', async (t) => {
  const { rt, store } = await setup(t, { embedder: fakeEmbedder() })
  await store.appendEvent({ id: 'e1', ts: NOW - 2 * HOUR, kind: 'message', payload: { text: '早上修显卡散热' } })
  await rt.service().memorySegments({ key: '显卡' })
  assert.ok(store.countMemoryVectors() > 0)

  const saved = await rt.service().embedConfigSave({ model: 'other-embed' })
  assert.equal(saved.cleared, true)
  assert.equal(saved.model, 'other-embed')
  assert.equal(saved.url, 'http://127.0.0.1:11434')
  assert.equal(saved.index.model, 'other-embed')
  assert.equal(saved.index.digest, null)
  assert.equal(saved.index.signature, 'other-embed@http://127.0.0.1:11434')
  assert.equal(saved.index.dim, null)
  assert.equal(saved.job, null)
  const started = rt.service().embedReindex()
  await started.job.promise
  assert.ok(store.countMemoryVectors({ model: 'other-embed@http://127.0.0.1:11434' }) > 0)
  await assert.rejects(() => rt.service().embedConfigSave({ fallbackDays: 0 }), /fallbackDays/)
})

test('向量模型变更：旧模型索引清空并按新模型重建', async (t) => {
  const { rt, store } = await setup(t, {
    embedder: fakeEmbedder(),
    seed: { 'embed.config': { model: 'fake-embed' } },
  })
  await store.appendEvent({ id: 'e1', ts: NOW - HOUR, kind: 'message', payload: { text: '早上修显卡散热' } })
  await store.upsertMemoryVectors([{
    source: 'events',
    id: 'old',
    ts: NOW - HOUR,
    kind: 'message',
    text: '旧模型',
    model: 'sha256:old',
    dim: 2,
    hash: 'h',
    vector: encodeVector([1, 0]),
    createdAt: NOW,
  }])
  await store.setState('embed.index', {
    model: 'old-embed',
    digest: 'sha256:old',
    signature: 'sha256:old',
    url: 'http://127.0.0.1:11434',
    dim: 2,
    updatedAt: NOW,
  })

  const result = await rt.service().memorySegments({ key: '显卡' })
  assert.equal(result.degraded, true)
  const job = rt.service().embedConfig().job
  assert.ok(job)
  await job.promise
  assert.equal(store.countMemoryVectors({ model: 'sha256:old' }), 0)
  assert.ok(store.countMemoryVectors({ model: 'sha256:v1' }) > 0)
  assert.equal(rt.service().embedConfig().index.model, 'fake-embed')
})

test('向量索引升级：旧 meta 无签名时保留向量并补签名', async (t) => {
  const { rt, store } = await setup(t, {
    embedder: fakeEmbedder(),
    seed: { 'embed.config': { model: 'fake-embed' } },
  })
  await store.appendEvent({ id: 'e1', ts: NOW - HOUR, kind: 'message', payload: { text: '早上修显卡散热' } })
  await store.upsertMemoryVectors([{
    source: 'events',
    id: 'e1',
    ts: NOW - HOUR,
    kind: 'message',
    text: '早上修显卡散热',
    model: 'fake-embed',
    dim: 2,
    hash: 'h',
    vector: encodeVector([1, 0]),
    createdAt: NOW,
  }])
  await store.setState('embed.index', { model: 'fake-embed', url: 'http://127.0.0.1:11434', dim: 2, updatedAt: NOW })

  const result = await rt.service().memorySegments({ key: '显卡' })
  assert.equal(result.source, 'embed')
  assert.equal(result.signature, 'sha256:v1')
  assert.equal(store.countMemoryVectors({ model: 'fake-embed' }), 0)
  assert.equal(store.countMemoryVectors({ model: 'sha256:v1' }), 1)
  assert.equal(rt.service().embedConfig().job, null)
})

test('向量签名：同名模型 digest 变化时旧向量失效并重建', async (t) => {
  const embedder = fakeEmbedder()
  const { rt, store } = await setup(t, {
    embedder,
    seed: { 'embed.config': { model: 'fake-embed' } },
  })
  await store.appendEvent({ id: 'e1', ts: NOW - HOUR, kind: 'message', payload: { text: '早上修显卡散热' } })
  const first = await rt.service().memorySegments({ key: '显卡' })
  assert.equal(first.digest, 'sha256:v1')
  const oldSignature = rt.service().embedConfig().index.signature
  assert.ok(store.countMemoryVectors({ model: oldSignature }) > 0)

  embedder.models[0].digest = 'sha256:v2'
  const second = await rt.service().memorySegments({ key: '显卡' })
  assert.equal(second.degraded, true)
  const job = rt.service().embedConfig().job
  assert.ok(job)
  await job.promise
  const state = rt.service().embedConfig()
  assert.equal(state.index.digest, 'sha256:v2')
  assert.equal(store.countMemoryVectors({ model: oldSignature }), 0)
  assert.ok(store.countMemoryVectors({ model: 'sha256:v2' }) > 0)
})

test('夜睡：全量补齐向量、清理窗口外旧向量并记录进度', async (t) => {
  const { rt, store } = await setup(t, {
    embedder: fakeEmbedder(),
    seed: { 'embed.config': { model: 'fake-embed' } },
  })
  await store.appendEvent({ id: 'e1', ts: NOW - HOUR, kind: 'message', payload: { text: '早上修显卡散热' } })
  await store.appendEvent({ id: 'old', ts: NOW - 40 * DAY, kind: 'message', payload: { text: '很久以前' } })
  await store.upsertMemoryVectors([{
    source: 'events',
    id: 'old',
    ts: NOW - 40 * DAY,
    kind: 'message',
    text: '很久以前',
    model: 'sha256:v1',
    dim: 2,
    hash: 'h',
    vector: encodeVector([0, 1]),
    createdAt: NOW,
  }])
  await store.setState('embed.index', {
    model: 'fake-embed',
    digest: 'sha256:v1',
    signature: 'sha256:v1',
    url: 'http://127.0.0.1:11434',
    dim: 2,
    updatedAt: NOW,
  })

  const result = await rt.consolidate('night', NOW)
  assert.equal(result.embedIndex.error, undefined)
  assert.ok(result.embedIndex.indexed >= 1)
  assert.equal(result.embedIndex.pruned, 1)
  assert.equal(store.countMemoryVectors({ model: 'sha256:v1' }), result.embedIndex.indexed)
  const progress = rt.snapshot().sleepProgress
  assert.equal(progress.running, false)
  assert.equal(progress.step, 'done')
  assert.ok(progress.steps.every((step) => step.state === 'done'))
})

test('recollect：成功返回主备、扫描统计并计 token', async (t) => {
  let rt
  let seenTimeout = null
  let seenPrompt = null
  const recollector = async ({ context, timeoutMs, prompt }) => {
    seenTimeout = timeoutMs
    seenPrompt = prompt
    const page = rt.service().memoryScan({ sources: ['events'], limit: 10 }, context)
    const evidence = [{ source: 'events', id: page.rows[0].id, ts: page.rows[0].ts }]
    return {
      outcome: 'ok',
      tokens: 123,
      text: JSON.stringify({
        ok: true,
        summary: '总结',
        primary: { answer: '主答案', confidence: 'high', evidence },
        backup: { answer: '备选答案', evidence },
      }),
    }
  }
  const setupResult = await setup(t, { recollector, config: { recollectTimeoutMs: 5000 } })
  rt = setupResult.rt
  const { store } = setupResult
  await store.appendEvent({ id: 'e1', ts: NOW - HOUR, kind: 'message', payload: { text: '早上修显卡' } })
  const result = await rt.service().recollect({ question: '我早上修了什么？' })
  assert.equal(seenTimeout, 5000)
  assert.ok(seenPrompt.includes('living_memory_segments'))
  assert.ok(seenPrompt.includes('最近 3 天'))
  assert.equal(result.ok, true)
  assert.equal(result.summary, '总结')
  assert.equal(result.primary.answer, '主答案')
  assert.equal(result.backup.answer, '备选答案')
  assert.equal(result.scanned.scans, 1)
  assert.ok(result.scanned.candidates >= 1)
  assert.ok(result.scanned.from >= NOW - 3 * DAY, '无区段扫描默认只回退 fallbackDays')
  assert.equal(result.usage.tokens, 123)
  assert.equal(rt.snapshot().budget.tokensUsed, 123)
  const [event] = store.listEvents({ kind: 'recollect', limit: 10 })
  assert.equal(event.payload.ok, true)
  assert.equal(event.payload.tokens, 123)
})

test('recollect：子 agent 失败返回 ok:false，主备为空，token 计入预算', async (t) => {
  const recollector = async () => {
    const error = new Error('recollect_timeout')
    error.usage = { total: 7 }
    throw error
  }
  const { rt, store } = await setup(t, { recollector })
  const result = await rt.service().recollect({ question: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'recollect_timeout')
  assert.equal(result.primary, null)
  assert.equal(result.backup, null)
  assert.equal(result.usage.tokens, 7)
  assert.equal(rt.snapshot().budget.tokensUsed, 7)
  const [event] = store.listEvents({ kind: 'recollect', limit: 10 })
  assert.equal(event.payload.ok, false)
  assert.equal(event.payload.tokens, 7)
})

test('recollect：输出不合法 → 失败而不是编答案', async (t) => {
  const recollector = async () => ({ outcome: 'ok', tokens: 3, text: 'not json' })
  const { rt } = await setup(t, { recollector })
  const result = await rt.service().recollect({ question: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /JSON/)
  assert.equal(result.primary, null)
  assert.equal(result.usage.tokens, 3)
})

test('recollect：预算用尽时直接失败，不调用子 agent', async (t) => {
  let called = 0
  const recollector = async () => {
    called += 1
    return { outcome: 'ok', tokens: 0, text: '{}' }
  }
  const { rt } = await setup(t, {
    recollector,
    seed: { budget: { day: dayKey(NOW, TZ), tokensUsed: 1_000_000, rounds: 0 } },
  })
  const result = await rt.service().recollect({ question: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'budget_exhausted')
  assert.equal(called, 0)
})

test('宝石 token 运行时更新：旧 token 立即失效，空 token 变未知宝石', async (t) => {
  const gem = {
    manifest: { id: 'bili', name: 'B站', version: '0.1.0', capabilities: {}, limits: {}, etiquette: [], failure_hints: {} },
    dir: '/gems/bili',
    skill: '',
  }
  const { rt } = await setup(t, { runner: async () => ({ tokens: 0 }), gems: [gem] })
  assert.deepEqual(rt.service().gemTokenStatus(), { bili: true })
  rt.service().setGemToken('bili', 't-new')
  const payload = { gem: 'bili', kind: 'notice', external_id: 'e1', from: { id: 'u' }, text: 'x', meta: {} }
  await assert.rejects(
    () => rt.channel.ingest({ token: 't-bili', payload, nowMs: NOW }),
    (error) => error.code === 'unauthorized',
  )
  assert.equal((await rt.channel.ingest({ token: 't-new', payload, nowMs: NOW })).accepted, true)
  rt.service().setGemToken('bili', '')
  assert.deepEqual(rt.service().gemTokenStatus(), { bili: false })
  await assert.rejects(
    () => rt.channel.ingest({ token: 't-new', payload: { ...payload, external_id: 'e2' }, nowMs: NOW }),
    (error) => error.code === 'unknown_gem',
  )
  assert.throws(() => rt.service().setGemToken('nope', 'x'), /未知宝石/)
})

test('夜睡演化人格：写 self、记事件、计 token', async (t) => {
  const calls = []
  const { rt, home, store } = await setup(t, {
    runner: async () => ({ tokens: 0 }),
    evolvePersona: async (input) => {
      calls.push(input)
      return { ok: true, text: 'EVOLVED SELF', tokens: 42 }
    },
  })
  await store.setPersonaDoc({ kind: 'charter', text: 'CHARTER' })
  await rt.sleep('night')
  assert.equal(calls.length, 1, '夜睡调用一次演化')
  assert.ok(calls[0].charter.includes('CHARTER'))
  assert.equal(rt.service().personaState().self.trim(), 'EVOLVED SELF')
  assert.equal(rt.snapshot().budget.tokensUsed, 42)
  const [event] = store.listEvents({ kind: 'persona_evolved', limit: 10 })
  assert.equal(event.payload.tokens, 42)
  assert.equal(event.payload.chars, 'EVOLVED SELF'.length)
  assert.ok(event.payload.version)
  assert.equal(rt.service().personaState().versions.length, 1)
})

test('人格演化模式 off：自动不跑，手动仍可跑', async (t) => {
  const calls = []
  const { rt, store } = await setup(t, {
    runner: async () => ({ tokens: 0 }),
    evolvePersona: async () => {
      calls.push(1)
      return { ok: true, text: 'MANUAL SELF', tokens: 7 }
    },
  })
  await store.setPersonaDoc({ kind: 'charter', text: 'CHARTER' })
  await rt.service().setPersonaEvolveMode('off')
  await rt.sleep('night')
  assert.equal(calls.length, 0)
  const manual = await rt.service().evolvePersonaNow()
  assert.equal(manual.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(rt.service().personaState().self.trim(), 'MANUAL SELF')
})

test('人格演化失败：保留旧 self 并写失败事件', async (t) => {
  const { rt, home, store } = await setup(t, {
    runner: async () => ({ tokens: 0 }),
    evolvePersona: async () => ({ ok: false, tokens: 3, error: 'provider_timeout' }),
  })
  await store.setPersonaDoc({ kind: 'charter', text: 'CHARTER' })
  await rt.sleep('night')
  assert.equal(rt.service().personaState().self.trim(), '')
  const [event] = store.listEvents({ kind: 'persona_evolve_failed', limit: 10 })
  assert.equal(event.payload.error, 'provider_timeout')
})

test('人设手工编辑、清空与恢复版本', async (t) => {
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }) })
  await store.setPersonaDoc({ kind: 'charter', text: 'CHARTER' })
  let state = await rt.service().personaSelfSet('第一版')
  assert.equal(state.self.trim(), '第一版')
  state = await rt.service().personaSelfSet('第二版')
  assert.equal(state.self.trim(), '第二版')
  const history = state.versions
  assert.equal(history.length, 2)
  const older = history[1]
  state = await rt.service().personaReset({ to: 'version', version: older.id })
  assert.equal(state.self.trim(), '第一版')
  state = await rt.service().personaReset({ to: 'empty' })
  assert.equal(state.self.trim(), '')
  assert.throws(() => rt.service().personaVersion('nope'), /未知/)
  assert.equal(rt.service().personaVersion(history[0].id).text.trim(), '第二版')
})

test('夜睡：pending raw 整理成 memory_items + facets + edges', async (t) => {
  const seen = []
  const extractMemory = async ({ segments }) => {
    seen.push(segments)
    const rawRef = segments[0].id
    return {
      ok: true,
      tokens: 20,
      items: [
        {
          kind: 'episode',
          title: '修显卡',
          description: '换了风扇',
          importance: 0.8,
          confidence: 0.9,
          tsStart: NOW - 1000,
          tsEnd: NOW,
          rawRef,
          facets: { who: ['小明'], what: ['修显卡'] },
        },
        {
          kind: 'fact',
          subject: '小明',
          predicate: '修了',
          object: '显卡',
          confidence: 0.9,
          tsStart: NOW - 1000,
          tsEnd: NOW,
          rawRef,
          facets: { who: ['小明'] },
        },
      ],
      edges: [{ from: 0, to: 1, relation: 'supports', note: '同一件事', confidence: 0.8 }],
    }
  }
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }), extractMemory })
  await store.appendEvent({ id: 'e-memory', ts: NOW - 1000, kind: 'message', payload: { text: '修显卡换风扇' } })
  const result = await rt.consolidate('night')
  assert.equal(result.memoryItems, 2)
  assert.equal(result.memoryEdges, 1)
  const [raw] = store.listRawSegments({ status: 'processed' })
  assert.ok(raw)
  assert.equal(seen[0][0].id, raw.id)
  const items = store.listMemoryItems({ limit: 20 }).filter((item) => item.rawRefs.includes(raw.id))
  assert.equal(items.length, 2)
  const episode = items.find((item) => item.kind === 'episode')
  assert.deepEqual(store.getFacets('episode', episode.id), { who: ['小明'], what: ['修显卡'] })
  const edges = store.listMemoryEdges({ kind: 'episode', id: episode.id })
  assert.equal(edges[0].relation, 'supports')
  assert.equal(edges[0].otherKind, 'fact')
})

test('夜睡：journal 独立 raw，整理后直接条目不再重复', async (t) => {
  const seen = []
  const extractMemory = async ({ segments }) => {
    seen.push(segments.map((segment) => segment.id))
    const rawRef = segments[0].id
    return {
      ok: true,
      tokens: 1,
      items: [{
        kind: 'episode',
        title: '日记',
        description: '读了郑渊洁的 AI 动画新闻',
        importance: 0.6,
        confidence: 0.9,
        tsStart: NOW,
        tsEnd: NOW,
        rawRef,
        facets: {},
      }],
      edges: [],
    }
  }
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }), extractMemory })
  await store.appendJournalEntry({ id: 'jr_n1', date: '2026-11-17', ts: NOW - 1000, text: '今天读了郑渊洁的 AI 动画新闻' })
  assert.ok(collectMemoryItems(store, { now: NOW }).some((item) => item.id === 'jr_n1'))

  await rt.consolidate('night')
  assert.ok(store.listRawSegments({ status: 'processed', limit: 100 }).some((segment) => segment.id === 'raw_journal_jr_n1'))
  assert.ok(seen.flat().includes('raw_journal_jr_n1'))
  const after = collectMemoryItems(store, { now: NOW })
  assert.ok(!after.some((item) => item.id === 'jr_n1'), '整理后直接 journal 条目让位')
  assert.ok(after.some((item) => item.id.includes('raw_journal_jr_n1')), '归一化条目接管召回')
})

test('夜睡：没有整理器时退化为 raw episode，仍标记 processed', async (t) => {
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }) })
  await store.appendEvent({ id: 'e-fallback', ts: NOW - 1000, kind: 'message', payload: { text: '今天在修显卡' } })
  const result = await rt.consolidate('night')
  assert.equal(result.memoryItems, 1)
  const [raw] = store.listRawSegments({ status: 'processed' })
  assert.ok(raw)
  const items = store.listMemoryItems({ limit: 20 }).filter((item) => item.rawRefs.includes(raw.id))
  assert.equal(items[0].kind, 'episode')
})

test('夜睡：模型整理失败先保留 pending，第三次 fallback', async (t) => {
  const extractMemory = async () => ({ ok: false, tokens: 1, error: 'bad json' })
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }), extractMemory })
  await store.appendEvent({ id: 'e-retry', ts: NOW - 1000, kind: 'message', payload: { text: '反复失败的事' } })
  await rt.consolidate('night')
  assert.equal(store.listRawSegments({ status: 'pending' })[0].attempts, 1)
  await rt.consolidate('night')
  assert.equal(store.listRawSegments({ status: 'pending' })[0].attempts, 2)
  const third = await rt.consolidate('night')
  assert.equal(third.memoryItems, 1)
  assert.equal(store.listRawSegments({ status: 'pending' }).length, 0)
  assert.equal(store.listRawSegments({ status: 'processed' }).length, 1)
  assert.equal(store.listEvents({ kind: 'memory_extract_failed', limit: 10 }).length, 2)
})

test('rest：只采集 raw，不做整理', async (t) => {
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }) })
  await store.appendEvent({ id: 'e-rest', ts: NOW - 1000, kind: 'message', payload: { text: '白天的事' } })
  const result = await rt.consolidate('rest')
  assert.equal(result.memoryItems, 0)
  const [raw] = store.listRawSegments({ status: 'pending' })
  assert.ok(raw)
  assert.equal(store.listMemoryItems({ limit: 20 }).filter((item) => item.rawRefs.includes(raw.id)).length, 0)
})

test('rest、夜睡都轮换主会话（新一段对话）', async (t) => {
  const rotations = []
  const { rt } = await setup(t, {
    runner: async () => ({ tokens: 0 }),
    rotateSession: async (kind) => {
      rotations.push(kind)
    },
  })
  await rt.consolidate('rest')
  assert.deepEqual(rotations, ['rest'])
  await rt.sleep('night')
  assert.deepEqual(rotations, ['rest', 'night'])
})

test('上下文保险：先 handoff，再 rest 换会话', async (t) => {
  const calls = []
  const rotations = []
  const runner = async ({ prompt }) => {
    calls.push(prompt)
    if (prompt.startsWith('上下文即将用尽')) {
      return { tokens: 30, contextTokens: 900, outcome: 'ok', text: '交接：在修 DSH', sessionId: 's1' }
    }
    return { tokens: 100, contextTokens: 800, outcome: 'error', errorCode: 'context_guard', sessionId: 's1' }
  }
  const { rt, store } = await setup(t, {
    runner,
    rotateSession: async (kind) => {
      rotations.push(kind)
    },
  })
  await rt.tick()
  assert.equal(calls.length, 2, '一轮 + handoff')
  assert.deepEqual(rotations, ['rest'])
  const handoff = store.getState('session.handoff')
  assert.equal(handoff.text, '交接：在修 DSH')
  assert.equal(handoff.fromSessionId, 's1')
  assert.ok(!store.listEpisodes({ limit: 10 }).some((episode) => String(episode.summary).includes('交接：在修 DSH')), 'handoff 不写进 episode')
  assert.equal(store.listFacts({ limit: 10 }).length, 0, 'handoff 不写进 fact')
  const [guard] = store.listEvents({ kind: 'context_guard', limit: 10 })
  assert.equal(guard.payload.handoff, 'ok')
  assert.equal(rt.snapshot().status, RUNTIME_STATUS.RUNNING)
  assert.equal(rt.snapshot().failures, 0, 'context guard 不是失败')
  const [consolidation] = store.listEvents({ kind: 'consolidation', limit: 10 })
  assert.equal(consolidation.payload.kind, 'rest')
  assert.ok(rt.snapshot().clock.lastConsolidationAt >= NOW)
})

test('上下文保险发生在事件轮：事件保留给新会话', async (t) => {
  const runner = async ({ prompt }) => {
    if (prompt.startsWith('上下文即将用尽')) {
      return { tokens: 0, outcome: 'ok', text: '交接：有人找我', sessionId: 's1' }
    }
    return { tokens: 0, outcome: 'error', errorCode: 'context_guard', sessionId: 's1' }
  }
  const { rt } = await setup(t, { runner, rotateSession: async () => {} })
  await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'evt-guard', from: { id: 'u1' }, text: '在吗', ts: NOW },
    nowMs: NOW,
  })
  await rt.tick()
  assert.ok(rt.service().events().some((event) => event.payload?.text === '在吗'), '事件未被游标消费')
})

test('新会话只注入一次 handoff，注入后清除', async (t) => {
  const prompts = []
  const runner = async ({ prompt }) => {
    if (prompt.startsWith('上下文即将用尽')) {
      return { tokens: 0, outcome: 'ok', text: '交接', sessionId: 's1' }
    }
    prompts.push(prompt)
    if (prompts.length === 1) {
      return { tokens: 0, outcome: 'error', errorCode: 'context_guard', sessionId: 's1' }
    }
    return { tokens: 0, outcome: 'ok', sessionId: `s${prompts.length}` }
  }
  const clock = { now: NOW }
  const { rt } = await setup(t, { runner, clock, rotateSession: async () => {} })
  await rt.tick()

  clock.now = NOW + 30_000
  await rt.tick()
  assert.ok(prompts[1].includes('## 上一段会话交接'))

  clock.now = NOW + 60_000
  await rt.tick()
  assert.ok(!prompts[2].includes('## 上一段会话交接'))
})

test('handoff 失败仍 rest 换会话', async (t) => {
  const rotations = []
  const runner = async ({ prompt }) => {
    if (prompt.startsWith('上下文即将用尽')) {
      return { tokens: 0, outcome: 'error', errorCode: 'provider_timeout', sessionId: 's1' }
    }
    return { tokens: 0, outcome: 'error', errorCode: 'context_guard', sessionId: 's1' }
  }
  const { rt, store } = await setup(t, {
    runner,
    rotateSession: async (kind) => {
      rotations.push(kind)
    },
  })
  await rt.tick()
  assert.deepEqual(rotations, ['rest'])
  assert.equal(store.getState('session.handoff'), null)
  const [failed] = store.listEvents({ kind: 'session_handoff_failed', limit: 10 })
  assert.equal(failed.payload.error, 'provider_timeout')
})

test('公开发言：判决层 pass 后直接放行，不需要白名单', async (t) => {
  const seen = []
  const adjudicate = async (input) => {
    seen.push(input)
    return { pass: true, rule_id: null, reason: '' }
  }
  const { rt, store } = await setup(t, { adjudicate, config: { whitelist: [] } })
  const result = await rt.sendOutbound({ gem: 'bili', to: 'reply:1:2:3', text: '这是回复', visibility: 'public' })

  assert.deepEqual(seen, [{ gem: 'bili', target: 'reply:1:2:3', text: '这是回复', visibility: 'public' }])
  assert.equal(result.queued, true)
  assert.equal(result.state, 'approved')
  const [item] = store.listOutbox({ limit: 10 })
  assert.ok(item.nextAttemptAt < Number.MAX_SAFE_INTEGER, '判决通过后应可被通道 claim')
  assert.equal(item.decision, 'send')
  assert.equal(item.verdictSource, 'limiter')
  const decisionEvent = store.listEvents({ limit: 50 }).find((event) => event.kind === 'outbound_decision')
  assert.equal(decisionEvent.payload.limiter, 'pass')
  assert.equal(decisionEvent.payload.decision, 'send')
})

test('公开发言：白名单目标跳过限制层', async (t) => {
  let calls = 0
  const adjudicate = async () => {
    calls += 1
    return { pass: false, rule_id: 'R-04', reason: '不该被调用' }
  }
  const { rt } = await setup(t, { adjudicate, config: { whitelist: ['comment:BV1'] } })
  const result = await rt.sendOutbound({ gem: 'bili', to: 'comment:BV1', text: '这是白名单公开评论', visibility: 'public' })

  assert.equal(result.queued, true)
  assert.equal(result.state, 'approved')
  assert.equal(result.silent, true)
  assert.equal(calls, 0)
})

test('公开发言：判决层拒绝 → 不进 outbox', async (t) => {
  const adjudicate = async () => ({ pass: false, rule_id: 'R-04', reason: '攻击性内容' })
  const { rt, store } = await setup(t, { adjudicate, config: { whitelist: [] } })
  const result = await rt.sendOutbound({ gem: 'bili', to: 'reply:1:2:3', text: '普通但判决拒绝', visibility: 'public' })

  assert.equal(result.queued, false)
  assert.equal(result.state, 'blocked')
  assert.equal(result.ruleId, 'R-04')
  assert.equal(store.listOutbox({ limit: 10 }).length, 0)
  const decisionEvent = store.listEvents({ limit: 50 }).find((event) => event.kind === 'outbound_decision')
  assert.equal(decisionEvent.payload.decision, 'block')
  assert.equal(decisionEvent.payload.ruleId, 'R-04')
  assert.equal(decisionEvent.payload.limiter, 'block')
})

test('公开发言：判决层异常 → 拦截，不直发', async (t) => {
  const adjudicate = async () => {
    throw new Error('provider_timeout')
  }
  const { rt, store } = await setup(t, { adjudicate, config: { whitelist: [] } })
  const result = await rt.sendOutbound({ gem: 'bili', to: 'reply:1:2:3', text: '这是回复', visibility: 'public' })

  assert.equal(result.queued, false)
  assert.equal(result.state, 'blocked')
  assert.equal(result.ruleId, 'R-00')
  assert.equal(store.listOutbox({ limit: 10 }).length, 0)
})

test('私聊不调用判决层；规则表命中也不调用', async (t) => {
  let calls = 0
  const adjudicate = async () => {
    calls += 1
    return { pass: true, rule_id: null, reason: '' }
  }
  const { rt } = await setup(t, { adjudicate, config: { whitelist: ['uid:9'] } })
  const direct = await rt.sendOutbound({ gem: 'bili', to: 'uid:9', text: '在吗', visibility: 'private' })
  assert.equal(direct.state, 'approved')

  const trustedHit = await rt.sendOutbound({ gem: 'bili', to: 'uid:9', text: '我的手机 13800138000', visibility: 'private' })
  assert.equal(trustedHit.state, 'approved')

  const ruleHit = await rt.sendOutbound({ gem: 'bili', to: 'reply:1:2:3', text: '我的手机 13800138000', visibility: 'public' })
  assert.equal(ruleHit.state, 'blocked')
  assert.equal(ruleHit.ruleId, 'R-01')
  assert.equal(calls, 0)
})

test('显式 limiter verdict 优先于判决层', async (t) => {
  let calls = 0
  const adjudicate = async () => {
    calls += 1
    return { pass: false, rule_id: 'R-02', reason: '不该被调用' }
  }
  const { rt } = await setup(t, { adjudicate, config: { whitelist: [] } })
  const result = await rt.sendOutbound({
    gem: 'bili',
    to: 'reply:1:2:3',
    text: '这是回复',
    visibility: 'public',
    limiter: { pass: true },
  })
  assert.equal(result.state, 'approved')
  assert.equal(calls, 0)
})

test('外发闸门：白名单私聊直发（规则表也跳过）、非白名单规则通过即放行、规则命中拦截', async (t) => {
  const { rt, store } = await setup(t, {
    runner: async () => ({ tokens: 0 }),
    config: { whitelist: ['uid_ok'] },
  })

  const allow = await rt.sendOutbound({ gem: 'bili', to: 'uid_ok', text: '在', visibility: 'private' })
  assert.equal(allow.queued, true)
  assert.equal(allow.silent, true)

  const trustedHit = await rt.sendOutbound({ gem: 'bili', to: 'uid_ok', text: '我的手机 13800138000', visibility: 'private' })
  assert.equal(trustedHit.queued, true)
  assert.equal(trustedHit.state, 'approved')

  const direct = await rt.sendOutbound({ gem: 'bili', to: 'uid_new', text: '在', visibility: 'private' })
  assert.equal(direct.queued, true)
  assert.equal(direct.state, 'approved')

  const blocked = await rt.sendOutbound({ gem: 'bili', to: 'uid_new', text: '我的手机 13800138000', visibility: 'private' })
  assert.equal(blocked.queued, false)
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.ruleId, 'R-01')

  const items = store.listOutbox({ gem: 'bili', limit: 10 })
  assert.equal(items.length, 3, 'blocked 不进入 outbox')
  const claimable = await store.claimOutbox({ gem: 'bili', limit: 10, nowMs: NOW })
  assert.equal(claimable.length, 3, '放行的外发都可被 pull')
  assert.ok(claimable.some((item) => item.to === 'uid_new'))
})

test('外发媒体：绝对路径落到 outbox，claim 时带回 visibility/media', async (t) => {
  const { rt, store } = await setup(t, { config: { whitelist: ['uid_ok'] } })
  const result = await rt.sendOutbound({
    gem: 'wechat',
    to: 'uid_ok',
    visibility: 'private',
    media: [{ path: '/tmp/a.png', kind: 'image' }],
  })
  assert.equal(result.queued, true)
  const [item] = await store.claimOutbox({ gem: 'wechat', nowMs: NOW })
  assert.deepEqual(item.media, [{ path: '/tmp/a.png', kind: 'image' }])
  assert.equal(item.visibility, 'private')
  assert.equal(item.text, '')
})

test('外发媒体：相对路径或空内容大声失败', async (t) => {
  const { rt } = await setup(t, { config: { whitelist: ['uid_ok'] } })
  await assert.rejects(
    () => rt.sendOutbound({ gem: 'wechat', to: 'uid_ok', visibility: 'private', media: [{ path: 'a.png' }] }),
    /绝对路径/,
  )
  await assert.rejects(
    () => rt.sendOutbound({ gem: 'wechat', to: 'uid_ok', visibility: 'private' }),
    /text 或 media/,
  )
})

test('L0 只在会话开头注入；同一会话后续轮次不再重复', async (t) => {
  const prompts = []
  const runner = async ({ prompt }) => {
    prompts.push(prompt)
    return { tokens: 0, sessionId: 's1' }
  }
  const clock = { now: NOW }
  const { rt, store } = await setup(t, { runner, clock })
  await store.appendEvent({
    kind: 'message',
    ts: NOW - 1000,
    payload: { text: '主人喜欢把散热器调到最大', importance: 1 },
  })
  await rt.tick()
  clock.now = NOW + 30_000
  await rt.tick()
  assert.equal(prompts.length, 2)
  assert.match(prompts[0], /## 你记得的事/)
  assert.doesNotMatch(prompts[1], /## 你记得的事/)
})

test('自动唤醒写网格/命中事件，agent 可写时间轴节点', async (t) => {
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0, sessionId: 's1' }) })
  await rt.tick()
  const grids = store.listEvents({ kind: 'auto_grid', limit: 10 })
  const hits = store.listEvents({ kind: 'auto_hit', limit: 10 })
  assert.ok(grids.length >= 1)
  assert.equal(grids[0].payload.points, 20)
  assert.ok(hits.length >= 1)

  const result = await rt.service().mark('决定去查原片', 'decision')
  assert.equal(result.ok, true)
  const marks = store.listEvents({ kind: 'agent_mark', limit: 10 })
  assert.equal(marks[0].payload.text, '决定去查原片')
  assert.equal(marks[0].payload.tag, 'decision')
})

test('L0 注入冷区线索', async (t) => {
  const prompts = []
  const runner = async ({ prompt }) => {
    prompts.push(prompt)
    return { tokens: 0, sessionId: 's1' }
  }
  const { rt, store } = await setup(t, { runner })
  await store.appendCold({ keyword: '显卡', label20: '显卡散热坏了', lastTs: NOW - DAY, importance: 0.5 })
  await rt.tick()
  assert.match(prompts[0], /冷区线索/)
  assert.match(prompts[0], /显卡/)
})

test('换会话后重新注入一次 L0', async (t) => {
  const prompts = []
  const runner = async ({ prompt }) => {
    prompts.push(prompt)
    return { tokens: 0, sessionId: `s${prompts.length}` }
  }
  const clock = { now: NOW }
  const { rt, store } = await setup(t, { runner, clock, rotateSession: async () => {} })
  await store.appendEvent({
    kind: 'message',
    ts: NOW - 1000,
    payload: { text: '主人喜欢把散热器调到最大', importance: 1 },
  })
  await rt.tick()
  await rt.consolidate('rest')
  clock.now = NOW + 30_000
  await rt.tick()
  assert.equal(prompts.length, 2)
  assert.match(prompts[0], /## 你记得的事/)
  assert.match(prompts[1], /## 你记得的事/, '新会话没有上一轮的 L0 上下文')
})

test('外发返回主动额度：宝石上报 + 未 ack 的主动 outbox 一起算', async (t) => {
  const { rt, store } = await setup(t, {
    config: {
      whitelist: ['uid_ok'],
      gemTokens: { bili: 't-bili', wechat: 't-wechat' },
      gemLimits: { wechat: { perMinute: 100, proactiveDaily: 5 } },
    },
  })
  const first = await rt.sendOutbound({ gem: 'wechat', to: 'uid_ok', visibility: 'private', text: '一' })
  assert.equal(first.origin, 'proactive')
  assert.equal(first.quota.cap, 5)
  assert.equal(first.remaining, 4, '本条主动发送要占一格')

  const [item] = await store.claimOutbox({ gem: 'wechat', nowMs: NOW })
  await rt.channel.ack({
    gem: 'wechat',
    token: 't-wechat',
    id: item.id,
    body: { ok: true, external_id: 'x', quota: { day: first.quota.day, cap: 5, sent: 1 } },
    nowMs: NOW,
  })

  const second = await rt.sendOutbound({ gem: 'wechat', to: 'uid_ok', visibility: 'private', text: '二' })
  assert.equal(second.quota.used, 2, '已上报 1 + 本条 1')
  assert.equal(second.remaining, 3)
})

test('外发来源：不在轮次里默认标 proactive', async (t) => {
  const { rt, store } = await setup(t, { config: { whitelist: ['uid_ok'] } })
  await rt.sendOutbound({ gem: 'wechat', to: 'uid_ok', visibility: 'private', text: '在' })
  const [item] = await store.claimOutbox({ gem: 'wechat', nowMs: NOW })
  assert.equal(item.origin, 'proactive')
})

test('外发来源：事件轮内的发送标 event，心跳轮标 proactive', async (t) => {
  let rtRef
  const runner = async () => {
    await rtRef.sendOutbound({ gem: 'wechat', to: 'uid_ok', visibility: 'private', text: '回' })
    return { tokens: 0 }
  }
  const clock = { now: NOW }
  const { rt, store } = await setup(t, { runner, clock, config: { whitelist: ['uid_ok'] } })
  rtRef = rt
  await store.recordIngest({
    gem: 'wechat',
    externalId: 'e1',
    event: { kind: 'message', source: 'wechat', ts: NOW, payload: { text: '在吗', from: { id: 'u1' }, meta: { reply_to: 'uid_ok' } } },
    nowMs: NOW,
  })
  await rt.tick()
  const [eventItem] = await store.claimOutbox({ gem: 'wechat', nowMs: NOW })
  assert.equal(eventItem.origin, 'event')

  await store.claimOutbox({ gem: 'wechat', nowMs: NOW + 10 * MIN })
  await store.ackOutbox({ id: eventItem.id, ok: true, externalId: 'x', nowMs: NOW })
  clock.now = NOW + 30_000
  await rt.tick()
  const [proactiveItem] = await store.claimOutbox({ gem: 'wechat', nowMs: NOW + 10 * MIN })
  assert.equal(proactiveItem.origin, 'proactive')
})

test('外发来源：回复目标的不同拼写（uid:/纯数字、me/self）按同一目标算', async (t) => {
  let rtRef
  const runner = async () => {
    await rtRef.sendOutbound({ gem: 'bili', to: '123', visibility: 'private', text: '回' })
    await rtRef.sendOutbound({ gem: 'wechat', to: 'self', visibility: 'private', text: '回' })
    return { tokens: 0 }
  }
  const { rt, store } = await setup(t, { runner, config: { whitelist: ['123', 'self'] } })
  rtRef = rt
  await store.recordIngest({
    gem: 'bili',
    externalId: 'e3',
    event: { kind: 'message', source: 'bili', ts: NOW, payload: { text: '在吗', from: { id: '123' }, meta: { reply_to: 'uid:123' } } },
    nowMs: NOW,
  })
  await store.recordIngest({
    gem: 'wechat',
    externalId: 'e4',
    event: { kind: 'message', source: 'wechat', ts: NOW, payload: { text: '在吗', from: { id: 'u1' }, meta: { reply_to: 'me' } } },
    nowMs: NOW,
  })
  await rt.tick()
  const items = await store.claimOutbox({ gem: 'bili', nowMs: NOW })
  assert.equal(items[0].origin, 'event')
  const [wechatItem] = await store.claimOutbox({ gem: 'wechat', nowMs: NOW })
  assert.equal(wechatItem.origin, 'event', 'me/self 别名按同一目标处理')
})

test('外发来源：事件轮里发到非回复目标仍算 proactive', async (t) => {
  let rtRef
  const runner = async () => {
    await rtRef.sendOutbound({ gem: 'wechat', to: 'uid_other', visibility: 'private', text: '主动' })
    return { tokens: 0 }
  }
  const { rt, store } = await setup(t, { runner, config: { whitelist: ['uid_other'] } })
  rtRef = rt
  await store.recordIngest({
    gem: 'wechat',
    externalId: 'e2',
    event: { kind: 'message', source: 'wechat', ts: NOW, payload: { text: '在吗', from: { id: 'u1' }, meta: { reply_to: 'uid_ok' } } },
    nowMs: NOW,
  })
  await rt.tick()
  const [item] = await store.claimOutbox({ gem: 'wechat', nowMs: NOW })
  assert.equal(item.origin, 'proactive')
})

test('孤儿轮次收尾：ended_at 为空的 anchor 标 interrupted 并写事件', async (t) => {
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }) })
  await store.appendAnchor({ roundId: 'r_orphan', startedAt: NOW - 1000, trigger: 'event' })
  const ids = await rt.closeOrphans()
  assert.deepEqual(ids, ['r_orphan'])
  const anchor = store.listRounds({ limit: 5 }).find((round) => round.roundId === 'r_orphan')
  assert.equal(anchor.outcome, 'interrupted')
  assert.equal(anchor.errorCode, 'interrupted')
  assert.equal(anchor.endedAt, NOW)
  const event = store.listEvents({ limit: 50 }).find((item) => item.kind === 'round_interrupted')
  assert.deepEqual(event.payload.roundIds, ['r_orphan'])
})

test('启动补跑：late 40 分钟恰好补 1 轮，再次调用不补', async (t) => {
  const calls = []
  const runner = async ({ prompt }) => {
    calls.push(prompt)
    return { tokens: 0, outcome: 'ok', sessionId: 's1' }
  }
  const { rt, store } = await setup(t, {
    runner,
    seed: { clock: { ...createClockState(NOW - 3600_000), nextWakeAt: NOW - 40 * 60_000 } },
  })
  const decision = await rt.recover()
  assert.equal(decision.trigger, 'recovery')
  assert.equal(decision.detail.lateMinutes, 40)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('恢复'))
  assert.ok(rt.snapshot().nextWakeAt > NOW)
  assert.equal(await rt.recover(), null)
  assert.equal(calls.length, 1)
  assert.equal(store.listRounds({ limit: 10 })[0].trigger, 'recovery')
})

test('重启激活：未过期也跑一轮 startup，待处理事件留给下一 tick', async (t) => {
  const calls = []
  const runner = async ({ prompt }) => {
    calls.push(prompt)
    return { tokens: 3, outcome: 'ok', sessionId: 's1' }
  }
  const { rt, store } = await setup(t, {
    runner,
    seed: { clock: { ...createClockState(NOW), nextWakeAt: NOW + 3600_000 } },
  })
  await store.appendEvent({ id: 'pending', ts: NOW, kind: 'message', source: 'wechat', actor: 'u', payload: { text: '在吗', from: { id: 'u' } } })
  const decision = await rt.recover()
  assert.equal(decision.trigger, 'startup')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('重启'))
  assert.equal(store.listEvents({ kind: 'message', limit: 10 }).length, 1, 'startup 不消费待处理事件')
  assert.equal(rt.snapshot().budget.rounds, 1)
  assert.equal(rt.snapshot().clock.lastWakeKind, 'startup')
  assert.equal(await rt.recover(), null)
  assert.equal(calls.length, 1)
})

test('startupRound=false：未过期不激活；过期仍补跑', async (t) => {
  const calls = []
  const runner = async ({ prompt }) => {
    calls.push(prompt)
    return { tokens: 0, outcome: 'ok', sessionId: 's1' }
  }
  const { rt } = await setup(t, {
    runner,
    config: { startupRound: false },
    seed: { clock: { ...createClockState(NOW), nextWakeAt: NOW + 3600_000 } },
  })
  assert.equal(await rt.recover(), null)
  assert.equal(calls.length, 0)

  const late = await setup(t, {
    runner,
    config: { startupRound: false },
    seed: { clock: { ...createClockState(NOW - 3600_000), nextWakeAt: NOW - 40 * 60_000 } },
  })
  const decision = await late.rt.recover()
  assert.equal(decision.trigger, 'recovery')
  assert.equal(calls.length, 1)
})

test('认证失败 3 次 DEGRADED，成功一轮自愈回 RUNNING', async (t) => {
  const clock = { now: NOW }
  const responses = [
    { tokens: 0, outcome: 'error', errorCode: 'provider_auth' },
    { tokens: 0, outcome: 'error', errorCode: 'provider_auth' },
    { tokens: 0, outcome: 'error', errorCode: 'provider_auth' },
    { tokens: 5, outcome: 'ok' },
  ]
  const { rt } = await setup(t, { clock, runner: async () => responses.shift() })
  for (let i = 0; i < 3; i += 1) {
    clock.now = NOW + i * 60_000
    await rt.tick()
  }
  assert.equal(rt.snapshot().status, RUNTIME_STATUS.DEGRADED)
  clock.now = NOW + 3 * 60_000
  await rt.tick()
  assert.equal(rt.snapshot().status, RUNTIME_STATUS.RUNNING)
  assert.equal(rt.snapshot().failures, 0)
})

function notifyGem(id, notify) {
  return {
    manifest: { id, name: id, version: '0.1.0', event: { protocol: ['ingest'], visibility: 'private' }, notify },
    skill: '',
  }
}

test('推送立即唤醒：ingest 接受后调度 tick，不等定时器', async (t) => {
  const { calls, runner } = collector()
  let scheduled = null
  const { rt } = await setup(t, {
    runner,
    wakeSchedule: (fn) => {
      scheduled = fn
    },
  })
  const ingested = await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'wake-1', from: { id: 'u1' }, text: '在吗', ts: NOW },
    nowMs: NOW,
  })
  assert.equal(ingested.wake, 'immediate')
  assert.equal(typeof scheduled, 'function')
  await scheduled()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('在吗'))
})

test('轮次运行中的推送：结束后立即补一轮，不抢占', async (t) => {
  const calls = []
  let release
  let started
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const startedP = new Promise((resolve) => {
    started = resolve
  })
  const runner = async ({ prompt }) => {
    calls.push(prompt)
    if (calls.length === 1) {
      started()
      await gate
    }
    return { tokens: 1, outcome: 'ok', sessionId: 's1' }
  }
  const scheduled = []
  const { rt } = await setup(t, { runner, wakeSchedule: (fn) => scheduled.push(fn) })

  const first = rt.tick()
  await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'mid-1', from: { id: 'u1' }, text: '第二轮消息', ts: NOW + 1 },
    nowMs: NOW + 1,
  })
  await startedP
  assert.equal(calls.length, 1, '推送不抢占当前轮')
  release()
  await first
  assert.equal(scheduled.length, 1, '当前轮结束后补一次 tick')
  await scheduled[0]()
  assert.equal(calls.length, 2)
  assert.ok(calls[1].includes('第二轮消息'))
})

test('silent：不立即唤醒，下一轮带进 prompt 后消费', async (t) => {
  const gem = notifyGem('quiet', { push: { mode: 'silent' } })
  const { calls, runner } = collector()
  const clock = { now: NOW }
  const { rt } = await setup(t, {
    runner,
    clock,
    gems: [gem],
    config: {
      gemTokens: { quiet: 't-quiet' },
      gemLimits: { quiet: { perMinute: 100 } },
      gemNotify: gemNotifyPolicies([gem]),
      clock: { tzOffsetMinutes: TZ, hMin: 1, hMax: 1, exploreProb: 1, cooldownMinutes: 0, selfWakeLimit: 12 },
    },
  })

  const ingested = await rt.channel.ingest({
    token: 't-quiet',
    payload: { gem: 'quiet', kind: 'message', external_id: 'q1', from: { id: 'u1' }, text: '静默消息', ts: NOW },
    nowMs: NOW,
  })
  assert.equal(ingested.wake, 'none')

  const first = await rt.tick()
  assert.equal(first.decision.trigger, 'auto', 'silent 不当成事件醒')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('静默消息'), '下一轮顺带看到')

  clock.now = NOW + MIN
  await rt.tick()
  assert.equal(calls.length, 2)
  assert.equal(rt.service().events({ limit: 10 }).length, 0, '已消费，不重复注入')
})

test('单条事件可被宝石标 silent：即使 notify.push=ring 也不唤醒', async (t) => {
  const gem = notifyGem('bili', { push: { mode: 'ring', budget: { limit: true, count: true } } })
  const { calls, runner } = collector()
  const clock = { now: NOW }
  const { rt } = await setup(t, {
    runner,
    clock,
    gems: [gem],
    config: {
      gemTokens: { bili: 't-bili' },
      gemLimits: { bili: { perMinute: 100 } },
      gemNotify: gemNotifyPolicies([gem]),
      clock: { tzOffsetMinutes: TZ, hMin: 1, hMax: 1, exploreProb: 1, cooldownMinutes: 0, selfWakeLimit: 12 },
    },
  })

  const ingested = await rt.channel.ingest({
    token: 't-bili',
    payload: {
      gem: 'bili',
      kind: 'notice',
      external_id: 'sys-1',
      from: { id: '30003' },
      text: '你的账号在新设备登录成功',
      ts: NOW,
      meta: { silent: true },
    },
    nowMs: NOW,
  })
  assert.equal(ingested.wake, 'none', '系统通知不唤醒')

  const first = await rt.tick()
  assert.equal(first.decision.trigger, 'auto', 'silent 不当成事件醒')
  assert.ok(calls[0].includes('你的账号在新设备登录成功'), '下一轮顺带看到')
})

test('预算豁免的推送：日额度锁定时仍起轮且不计费', async (t) => {
  const gem = notifyGem('wechat', { push: { mode: 'ring', budget: { limit: false, count: false } } })
  const { calls, runner } = collector()
  const { rt } = await setup(t, {
    runner,
    gems: [gem],
    config: {
      gemTokens: { wechat: 't-wechat' },
      gemLimits: { wechat: { perMinute: 100 } },
      gemNotify: gemNotifyPolicies([gem]),
      clock: { tzOffsetMinutes: TZ, hMin: 0, hMax: 0, exploreProb: 0, cooldownMinutes: 0 },
      budget: { tzOffsetMinutes: TZ, dailyTokens: 100, dailyRounds: 0, roundTokens: 1000 },
    },
  })
  await rt.channel.ingest({
    token: 't-wechat',
    payload: { gem: 'wechat', kind: 'message', external_id: 'w1', from: { id: 'owner' }, text: '在吗', ts: NOW, meta: { trusted: true } },
    nowMs: NOW,
  })
  const { status } = await rt.tick()
  assert.equal(calls.length, 1, '日额度 HOLD 也回复')
  assert.equal(status, RUNTIME_STATUS.BUDGET_HOLD)
  assert.equal(rt.snapshot().budget.tokensUsed, 0, '不计入日额度')
  assert.equal(rt.snapshot().budget.rounds, 0, '不计轮次数')
})

test('受限推送：日额度锁定时不起轮，事件留在游标后', async (t) => {
  const gem = notifyGem('bili', { push: { mode: 'ring', budget: { limit: true, count: true } } })
  const { calls, runner } = collector()
  const { rt } = await setup(t, {
    runner,
    gems: [gem],
    config: {
      gemTokens: { bili: 't-bili' },
      gemLimits: { bili: { perMinute: 100 } },
      gemNotify: gemNotifyPolicies([gem]),
      clock: { tzOffsetMinutes: TZ, hMin: 0, hMax: 0, exploreProb: 0, cooldownMinutes: 0 },
      budget: { tzOffsetMinutes: TZ, dailyTokens: 100, dailyRounds: 0, roundTokens: 1000 },
    },
  })
  await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'b1', from: { id: 'u1' }, text: '外部私信', ts: NOW },
    nowMs: NOW,
  })
  const { status } = await rt.tick()
  assert.equal(calls.length, 0)
  assert.equal(status, RUNTIME_STATUS.BUDGET_HOLD)
  assert.equal(rt.service().events({ limit: 10 }).length, 1, '未消费，额度恢复后可再处理')
})

test('主人推送豁免：trusted 策略覆盖 push', async (t) => {
  const gem = notifyGem('bili', {
    push: { mode: 'ring', budget: { limit: true, count: true } },
    trusted: { budget: { limit: false, count: false } },
  })
  const { calls, runner } = collector()
  const { rt } = await setup(t, {
    runner,
    gems: [gem],
    config: {
      gemTokens: { bili: 't-bili' },
      gemLimits: { bili: { perMinute: 100 } },
      gemNotify: gemNotifyPolicies([gem]),
      clock: { tzOffsetMinutes: TZ, hMin: 0, hMax: 0, exploreProb: 0, cooldownMinutes: 0 },
      budget: { tzOffsetMinutes: TZ, dailyTokens: 100, dailyRounds: 0, roundTokens: 1000 },
    },
  })
  await rt.channel.ingest({
    token: 't-bili',
    payload: { gem: 'bili', kind: 'message', external_id: 'owner-1', from: { id: 'me' }, text: '我发的', ts: NOW, meta: { trusted: true } },
    nowMs: NOW,
  })
  await rt.tick()
  assert.equal(calls.length, 1)
  assert.equal(rt.snapshot().budget.tokensUsed, 0)
})

test('重置今日用量：计数归零、解除 BUDGET_HOLD、写审计事件', async (t) => {
  const clock = { now: NOW }
  const { calls, runner } = collector()
  const { rt, store } = await setup(t, {
    runner,
    clock,
    config: { budget: { tzOffsetMinutes: TZ, dailyTokens: 10, dailyRounds: 1, roundTokens: 1000 } },
  })
  await rt.tick()
  assert.equal(calls.length, 1)
  clock.now = NOW + MIN
  await rt.tick()
  assert.equal(rt.snapshot().status, RUNTIME_STATUS.BUDGET_HOLD)

  const snap = await rt.service().resetBudget('test')
  assert.equal(snap.budget.tokensUsed, 0)
  assert.equal(snap.budget.rounds, 0)
  assert.equal(snap.status, RUNTIME_STATUS.RUNNING)
  const [event] = store.listEvents({ kind: 'budget_reset', limit: 10 })
  assert.equal(event.payload.reason, 'test')
  assert.equal(event.payload.before.tokensUsed, 10)

  clock.now = NOW + 2 * MIN
  await rt.tick()
  assert.equal(calls.length, 2, '重置后可以继续起轮')
})

test('服务接口：recall / import 幂等 / stats', async (t) => {
  const { rt, store } = await setup(t, { runner: async () => ({ tokens: 0 }) })
  await store.appendEvent({ id: 'e1', ts: NOW, kind: 'message', payload: { text: '显卡散热坏了' }, source: 'bili' })
  const recalled = rt.service().recall('散热')
  assert.equal(recalled.recalled[0].id, 'e1')
  assert.ok(recalled.recalled[0].why.length > 0)

  const first = await rt.service().importText({ format: 'plain', source: 'note.md', text: '一条导入' })
  const second = await rt.service().importText({ format: 'plain', source: 'note.md', text: '一条导入' })
  assert.deepEqual([first.accepted, second.accepted], [1, 0])

  const stats = rt.service().stats({ days: 7 })
  assert.ok(stats.events >= 1)
})
