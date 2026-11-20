/**
 * Host half: open the store, expose the `living` service, register the preset,
 * the /living routes, and the one-minute tick. Business logic lives in lib/.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createStore } from './lib/store.mjs'
import { importLegacyPersonaFiles } from './lib/persona.mjs'
import { createRuntime } from './lib/runtime.mjs'
import { createHttpHandler } from './lib/http.mjs'
import { gemLimits, gemNotifyPolicies, gemPresetPlugins, loadGem } from './lib/gems.mjs'
import { resolveGemHomes } from './lib/gem-admin.mjs'
import { ensureLayout } from './lib/layout.mjs'
import { applyPendingImport } from './lib/backup.mjs'
import { catalogStatus, installGem, loadGemCatalog, scanStoreGems, uninstallGem, upgradeInstalledGems } from './lib/gem-store.mjs'
import { createGemLoginSupervisor } from './lib/gem-login.mjs'
import { createGemChannelSupervisor } from './lib/gem-channel.mjs'
import { waitForTurn } from './lib/round.mjs'
import { findScope } from './lib/host-scope.mjs'
import { createAdjudicator } from './lib/adjudicator.mjs'
import { createPersonaEvolver, SELF_PRESET_PLUGINS } from './lib/persona-evolve.mjs'
import { createMemoryExtractor, MEMORY_PRESET_PLUGINS } from './lib/memory-extract.mjs'
import { parseMemoryParams } from './lib/memory-config.mjs'
import { createRecollector } from './lib/recollector.mjs'
import { RECOLLECT_DEFAULTS, RECOLLECT_PRESET_PLUGINS } from './lib/recollect.mjs'
import { allocateLivingSessionTitle } from './lib/session-title.mjs'
import { LIMITER_PRESET_PLUGINS } from './lib/limiter.mjs'
import { autoWakeEstimate, parseTimeOfDay, scaledNow } from './lib/clock.mjs'
import { ADMIN_CHANNEL, ADMIN_ENDPOINT, createAdminFetch } from './lib/rpc.mjs'

export const name = 'living'
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'connection', 'webServer']

const coreVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export const Config = z.object({
  // Load-time path: making it volatile would let settings orphan life.db.
  home: z.string().required(),
  /** Agent cwd; empty means `<home>/workspace`. */
  workspace: z.string().default('').extra('volatile', true),
  /** npm code store; empty means `<home>/gems`. */
  gemStoreDir: z.string().default(''),
  timeScale: z.number().default(1).extra('volatile', true),
  tickMs: z.number().default(60000).extra('volatile', true),
  /** Local HH:MM; the night sleep trigger. */
  nightAt: z.string().default('03:30').extra('volatile', true),
  nightWindowMinutes: z.number().default(360).extra('volatile', true),
  l0Tokens: z.number().default(3000).extra('volatile', true),
  /** JSON object overriding MEMORY_DEFAULTS; unknown keys ignored, ranges clamped. */
  memoryParamsJson: z.string().default('{}').extra('volatile', true),
  dailyTokens: z.number().default(2000000).extra('volatile', true),
  dailyRounds: z.number().default(96).extra('volatile', true),
  roundTokens: z.number().min(500000).max(800000).default(700000).extra('volatile', true),
  /** Deprecated: replaced by the auto-wake grid; kept so old profiles still load. */
  selfWakeLimit: z.number().default(12).extra('volatile', true),
  autoWakeGridMinutes: z.number().default(10).extra('volatile', true),
  autoWakeSampleSeconds: z.number().default(30).extra('volatile', true),
  autoWakeNormalExpected: z.number().default(0.1).extra('volatile', true),
  autoWakeLowExpected: z.number().default(0.05).extra('volatile', true),
  autoWakeHighExpected: z.number().default(0.2).extra('volatile', true),
  autoWakeHotRanges: z.string().default('06:00-08:00;12:00-14:00;18:00-24:00').extra('volatile', true),
  autoWakeColdRanges: z.string().default('00:00-06:00').extra('volatile', true),
  startupRound: z.boolean().default(true).extra('volatile', true),
  personaMaxChars: z.number().default(6000).extra('volatile', true),
  roundTimeoutMs: z.number().default(600000).extra('volatile', true),
  recollectTimeoutMs: z.number().default(RECOLLECT_DEFAULTS.timeoutMs).extra('volatile', true),
  presetId: z.string().default('living').extra('volatile', true),
  limiterEnabled: z.boolean().default(true).extra('volatile', true),
  gemSilenceMinutes: z.number().default(10).extra('volatile', true),
  gemDirs: z.array(z.string()).default([]).extra('volatile', true),
  gemHomesJson: z.string().default('{}').extra('volatile', true),
  gemTokensJson: z.string().default('{}').role('secret').extra('volatile', true),
  whitelistJson: z.string().default('[]').extra('volatile', true),
  sessionRoot: z.string().default('').extra('volatile', true),
})

export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (typeof cfg.home !== 'string' || cfg.home === '') throw new Error('living: `home` 必填')
  const memoryParams = parseMemoryParams(cfg.memoryParamsJson)
  const nightAtMinutes = parseTimeOfDay(cfg.nightAt)
  const nightWindowMinutes = Number(cfg.nightWindowMinutes)
  if (!Number.isFinite(nightWindowMinutes) || nightWindowMinutes <= 0) throw new RangeError('living: nightWindowMinutes 必须为正数')

  const layout = ensureLayout({ home: cfg.home, logger: console })
  applyPendingImport({ layout, logger: console })
  const workspace = cfg.workspace?.trim() ? resolve(cfg.workspace.trim()) : layout.workspace
  const gemStoreDir = cfg.gemStoreDir?.trim() ? resolve(cfg.gemStoreDir.trim()) : layout.gemStoreDir
  mkdirSync(workspace, { recursive: true })
  mkdirSync(gemStoreDir, { recursive: true })

  const gemTokens = parseJsonObject(cfg.gemTokensJson, 'gemTokensJson')
  const whitelist = parseJsonArray(cfg.whitelistJson, 'whitelistJson')
  const gemCatalog = loadGemCatalog()
  const storeScan = scanStoreGems(gemStoreDir, { coreVersion })
  for (const error of storeScan.errors) console.warn(`living: 宝石清单无效 ${error.dir}: ${error.message}`)
  const gems = [...storeScan.gems]
  for (const dir of cfg.gemDirs ?? []) {
    try {
      const gem = loadGem(dir, { coreVersion })
      const duplicate = gems.find((candidate) => candidate.manifest.id === gem.manifest.id)
      if (duplicate) {
        console.warn(`living: 宝石 id 重复 ${gem.manifest.id}，忽略 ${dir}（已加载 ${duplicate.dir}）`)
        continue
      }
      gems.push(gem)
    } catch (error) {
      console.warn(`living: 宝石加载失败 ${dir}: ${error.message}`)
    }
  }

  const gemHomes = resolveGemHomes(gems, parseJsonObject(cfg.gemHomesJson, 'gemHomesJson'), { gemDataDir: layout.gemDataDir })
  const gemLogin = createGemLoginSupervisor({ gems, gemHomes, logger: console })
  ctx.effect(() => () => gemLogin.dispose())

  const timeScale = Number(cfg.timeScale) > 0 ? Number(cfg.timeScale) : 1
  const baseReal = Date.now()
  const baseSim = Date.now()
  const simNow = () => scaledNow(Date.now(), baseReal, baseSim, timeScale)

  const autoWake = {
    gridMinutes: Number(cfg.autoWakeGridMinutes),
    sampleSeconds: Number(cfg.autoWakeSampleSeconds),
    normalExpected: Number(cfg.autoWakeNormalExpected),
    lowExpected: Number(cfg.autoWakeLowExpected),
    highExpected: Number(cfg.autoWakeHighExpected),
    hotRanges: parseAutoRanges(cfg.autoWakeHotRanges, 'autoWakeHotRanges'),
    coldRanges: parseAutoRanges(cfg.autoWakeColdRanges, 'autoWakeColdRanges'),
  }
  try {
    autoWakeEstimate(simNow(), { autoWake })
  } catch (error) {
    throw new Error(`living: 自动唤醒配置无效: ${error.message}`)
  }

  let channelSupervisor = null
  const store = createStore({ path: layout.dbPath, now: simNow })
  try {
    await importLegacyPersonaFiles(store, layout.legacyDir, { now: simNow() })
  } catch (error) {
    console.error(`living: 旧 persona 文件导入失败: ${error.message}`)
  }
  ctx.effect(() => () => store.close())

  const limiterPresetId = `${cfg.presetId}-judge`
  const adjudicate = cfg.limiterEnabled
    ? createAdjudicator(ctx, {
        home: cfg.home,
        workspace,
        presetId: limiterPresetId,
        logger: console,
        archive: (sessionId) => archiveSession(ctx, sessionId),
        setup: async (agentCtx) => {
          await ctx.agentPresets.mount(agentCtx, limiterPresetId)
          restrictAllTools(agentCtx, '限制层')
        },
      })
    : null

  const selfPresetId = `${cfg.presetId}-self`
  let selfPresetReady = false
  const evolvePersonaRaw = createPersonaEvolver(ctx, {
    home: cfg.home,
    workspace,
    presetId: selfPresetId,
    logger: console,
    archive: (sessionId) => archiveSession(ctx, sessionId),
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, selfPresetId)
      restrictAllTools(agentCtx, '人格演化')
    },
  })
  const evolvePersona = (input) => (selfPresetReady
    ? evolvePersonaRaw(input)
    : Promise.resolve({ ok: false, tokens: 0, error: '人格演化 preset 未就绪' }))

  const memoryPresetId = `${cfg.presetId}-memory`
  let memoryPresetReady = false
  const extractMemoryRaw = createMemoryExtractor(ctx, {
    home: cfg.home,
    workspace,
    presetId: memoryPresetId,
    logger: console,
    memoryParams,
    archive: (sessionId) => archiveSession(ctx, sessionId),
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, memoryPresetId)
      restrictAllTools(agentCtx, '记忆整理')
    },
  })
  const extractMemory = (input) => (memoryPresetReady
    ? extractMemoryRaw(input)
    : Promise.resolve({ ok: false, tokens: 0, error: '记忆整理 preset 未就绪' }))

  const recollectPresetId = `${cfg.presetId}-recollect`
  let recollectPresetReady = false
  let recollectImpl = null
  const recollector = (input) => (recollectPresetReady && recollectImpl
    ? recollectImpl(input)
    : Promise.resolve({ outcome: 'error', errorCode: 'recollect_unavailable', tokens: 0, text: '' }))

  const session = createSessionRunner(ctx, {
    store,
    home: cfg.home,
    workspace,
    presetId: cfg.presetId,
    roundTokens: cfg.roundTokens,
    sessionTitle: async () => {
      const allocated = allocateLivingSessionTitle(Date.now(), { previous: store.getState('session.titleSeq') })
      await store.setState('session.titleSeq', allocated.state)
      return allocated.title
    },
    logger: console,
  })
  ctx.effect(() => () => session.close())

  const runtime = createRuntime({
    home: cfg.home,
    store,
    now: simNow,
    gems,
    adjudicate,
    gemChannels: () => channelSupervisor?.snapshot() ?? [],
    upgradeGems: () => upgradeInstalledGems({ catalog: gemCatalog, storeDir: gemStoreDir, coreVersion, logger: console }),
    runner: (args) => session.run(args),
    rotateSession: (kind) => session.rotate(kind),
    evolvePersona,
    extractMemory,
    recollector,
    personaAvailable: () => selfPresetReady,
    config: {
      l0Tokens: cfg.l0Tokens,
      memoryParams,
      personaMaxChars: cfg.personaMaxChars,
      roundTimeoutMs: cfg.roundTimeoutMs,
      recollectTimeoutMs: cfg.recollectTimeoutMs,
      gemSilenceMinutes: cfg.gemSilenceMinutes,
      clock: { autoWake, nightAtMinutes, nightWindowMinutes },
      startupRound: cfg.startupRound,
      budget: { dailyTokens: cfg.dailyTokens, dailyRounds: cfg.dailyRounds, roundTokens: cfg.roundTokens },
      gemTokens,
      gemLimits: gemLimits(gems),
      gemNotify: gemNotifyPolicies(gems),
      whitelist,
      sessionRoot: cfg.sessionRoot || null,
    },
  })
  const livingService = runtime.service()
  recollectImpl = createRecollector(ctx, {
    workspace,
    presetId: recollectPresetId,
    living: livingService,
    timeoutMs: cfg.recollectTimeoutMs,
    archive: (sessionId) => archiveSession(ctx, sessionId),
    logger: console,
  })

  /**
   * Persist one gem token without ever handing it to the browser: the settings
   * service owns the profile patch, the runtime owns /living/ingest, and the
   * channel supervisor owns the child process env. All three move together.
   */
  async function persistGemToken(gemId, token) {
    const settings = ctx.get?.('settings') ?? ctx.settings
    if (!settings || typeof settings.update !== 'function') throw new Error('settings 服务不可用，无法保存宝石 token')
    const ns = ctx.fiber?.entry?.options?.id ?? 'living'
    const form = (settings.describe?.() ?? []).find((row) => row.ns === ns)
    if (!form) throw new Error(`找不到配置命名空间 ${ns}`)
    const current = parseJsonObject(String(form.value?.gemTokensJson ?? '{}'), 'gemTokensJson')
    if (token === '') delete current[gemId]
    else current[gemId] = token
    await settings.update(ns, { gemTokensJson: JSON.stringify(current) }, form.revision)
    livingService.setGemToken(gemId, token)
    try {
      channelSupervisor?.setToken(gemId, token)
    } catch (error) {
      console.warn(`living: 宝石通道 token 更新失败 ${gemId}: ${error.message}`)
    }
    return { configured: token !== '' }
  }

  ctx.effect(() => ctx.provide('living', livingService))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/living', handler: createHttpHandler({ runtime, store }) }))
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: `${ADMIN_CHANNEL}/${ADMIN_ENDPOINT}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createAdminFetch({
        runtime,
        store,
        home: cfg.home,
        layout,
        workspace,
        gemStoreDir,
        gemDataDir: layout.gemDataDir,
        gemCatalog,
        coreVersion,
        gems,
        gemHomes,
        gemLogin,
        session,
        setGemToken: persistGemToken,
        gemTokenStatus: () => livingService.gemTokenStatus(),
      }),
    })
    return () => {
      dispose().catch(() => {})
    }
  })

  let disposePreset = null
  try {
    disposePreset = await registerPreset(ctx, cfg.presetId, gems)
  } catch (error) {
    console.error(`living: preset 注册失败: ${error.message}`)
  }
  ctx.effect(() => () => disposePreset?.().catch(() => {}))

  let disposeLimiterPreset = null
  if (cfg.limiterEnabled) {
    try {
      disposeLimiterPreset = await registerLimiterPreset(ctx, limiterPresetId)
    } catch (error) {
      console.error(`living: 限制层 preset 注册失败，公网发言将保持待审: ${error.message}`)
    }
    ctx.effect(() => () => disposeLimiterPreset?.().catch(() => {}))
  }

  let disposeSelfPreset = null
  try {
    disposeSelfPreset = await registerSelfPreset(ctx, selfPresetId)
    selfPresetReady = true
  } catch (error) {
    console.error(`living: 人格演化 preset 注册失败，演化不可用: ${error.message}`)
  }
  ctx.effect(() => () => disposeSelfPreset?.().catch(() => {}))

  let disposeMemoryPreset = null
  try {
    disposeMemoryPreset = await registerMemoryPreset(ctx, memoryPresetId)
    memoryPresetReady = true
  } catch (error) {
    console.error(`living: 记忆整理 preset 注册失败，睡眠只做轻量整理: ${error.message}`)
  }
  ctx.effect(() => () => disposeMemoryPreset?.().catch(() => {}))

  let disposeRecollectPreset = null
  try {
    disposeRecollectPreset = await registerRecollectPreset(ctx, recollectPresetId)
    recollectPresetReady = true
  } catch (error) {
    console.error(`living: 回想 preset 注册失败，回想不可用: ${error.message}`)
  }
  ctx.effect(() => () => disposeRecollectPreset?.().catch(() => {}))

  try {
    channelSupervisor = createGemChannelSupervisor({
      gems,
      gemHomes,
      tokens: gemTokens,
      baseUrl: ctx.webServer.getOrigin(),
      onFailure: (id, code) => livingService.reportGemFailure(id, code),
      onSuccess: (id) => livingService.reportGemSuccess(id),
    })
    channelSupervisor.startAll()
  } catch (error) {
    console.error(`living: 宝石通道监督未启动: ${error.message}`)
  }
  ctx.effect(() => () => channelSupervisor?.dispose())

  const interrupted = await runtime.closeOrphans()
  if (interrupted.length > 0) console.warn(`living: 收尾 ${interrupted.length} 个孤儿轮次`)

  const tick = () => {
    runtime.tick().catch((error) => console.error(`living: tick 失败: ${error.message}`))
  }
  let timer = null
  let stopped = false
  // Recovery must start after this plugin's fiber is active: mounting the preset
  // from inside apply() waits on the host loader, which waits on apply(). The
  // short settle also lets other agent-scoped plugins finish registering tools
  // before the first startup round, which their own install hooks assume.
  const initial = setTimeout(async () => {
    try {
      const recovered = await runtime.recover()
      if (recovered) {
        const late = recovered.detail?.lateMinutes
        console.log(recovered.trigger === 'startup'
          ? `living: 启动激活一轮${recovered.detail?.downMinutes != null ? `（距上次醒来 ${recovered.detail.downMinutes} 分钟）` : ''}`
          : `living: 启动补跑一次（晚 ${late ?? 0} 分钟）`)
      }
    } catch (error) {
      console.error(`living: 启动补跑失败: ${error.message}`)
    }
    if (stopped) return
    tick()
    timer = setInterval(tick, Math.max(1000, Math.min(cfg.tickMs, cfg.autoWakeSampleSeconds * 1000)))
    timer.unref?.()
  }, 3000)
  initial.unref?.()
  ctx.effect(() => () => {
    stopped = true
    clearTimeout(initial)
    if (timer) clearInterval(timer)
  })

}

/** Volatile Config fields arrive as `{ get() }` references; plain values pass through. */
function normalizeConfig(config) {
  const value = (field, fallback) => (field && typeof field.get === 'function' ? field.get() : field ?? fallback)
  return {
    home: config.home,
    workspace: value(config.workspace, ''),
    gemStoreDir: value(config.gemStoreDir, ''),
    tickMs: value(config.tickMs, 60000),
    timeScale: value(config.timeScale, 1),
    nightAt: value(config.nightAt, '03:30'),
    nightWindowMinutes: value(config.nightWindowMinutes, 360),
    l0Tokens: value(config.l0Tokens, 3000),
    memoryParamsJson: value(config.memoryParamsJson, '{}'),
    dailyTokens: value(config.dailyTokens, 2000000),
    dailyRounds: value(config.dailyRounds, 96),
    roundTokens: value(config.roundTokens, 700000),
    selfWakeLimit: value(config.selfWakeLimit, 12),
    autoWakeGridMinutes: value(config.autoWakeGridMinutes, 10),
    autoWakeSampleSeconds: value(config.autoWakeSampleSeconds, 30),
    autoWakeNormalExpected: value(config.autoWakeNormalExpected, 0.1),
    autoWakeLowExpected: value(config.autoWakeLowExpected, 0.05),
    autoWakeHighExpected: value(config.autoWakeHighExpected, 0.2),
    autoWakeHotRanges: value(config.autoWakeHotRanges, '06:00-08:00;12:00-14:00;18:00-24:00'),
    autoWakeColdRanges: value(config.autoWakeColdRanges, '00:00-06:00'),
    startupRound: value(config.startupRound, true),
    personaMaxChars: value(config.personaMaxChars, 6000),
    roundTimeoutMs: value(config.roundTimeoutMs, 600000),
    presetId: value(config.presetId, 'living'),
    limiterEnabled: value(config.limiterEnabled, true),
    gemSilenceMinutes: value(config.gemSilenceMinutes, 10),
    gemDirs: value(config.gemDirs, []),
    gemHomesJson: value(config.gemHomesJson, '{}'),
    gemTokensJson: value(config.gemTokensJson, '{}'),
    whitelistJson: value(config.whitelistJson, '[]'),
    sessionRoot: value(config.sessionRoot, ''),
  }
}

/**
 * One live conversation per waking stretch (D-15/D-42): the agent stays mounted
 * across rounds and is replaced after each rest or night sleep. The session is
 * hidden from the sidebar by archive membership, toggled at runtime; while
 * archived the host's pre-step gate refuses turns, so unarchive always precedes
 * a round.
 */
export function createSessionRunner(ctx, { store, home, workspace = home, presetId, roundTokens, sessionTitle = null, logger = console }) {
  let handle = null
  let sessionId = null
  let startedAt = null
  let busy = false
  let pendingRotate = null
  let closed = false
  let registryMissing = false
  let titleServiceWarned = false
  let currentTitle = null

  function workspaceRegistry() {
    return ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
  }

  function titleService() {
    return ctx.get?.('sessionTitle') ?? ctx.sessionTitle
  }

  function applySessionTitle(agent, title) {
    if (typeof title !== 'string' || title === '') return
    const service = titleService()
    if (!service || typeof service.rename !== 'function') {
      if (!titleServiceWarned) {
        titleServiceWarned = true
        logger.warn?.('living: sessionTitle 服务未挂载，主会话标题未设置')
      }
      return
    }
    try {
      service.rename(agent.session, title)
      currentTitle = title
    } catch (error) {
      logger.warn?.(`living: 主会话标题设置失败: ${error.message}`)
    }
  }

  function rememberSessionTitle(agent) {
    try {
      currentTitle = titleService()?.get?.(agent.session)?.title ?? null
    } catch {
      currentTitle = null
    }
  }

  async function setArchived(id, archived) {
    const registry = workspaceRegistry()
    if (!registry || typeof registry.archiveSession !== 'function') {
      if (!registryMissing) {
        registryMissing = true
        logger.warn?.('living: workspaceRegistry 未挂载，主会话的侧栏可见性不可控')
      }
      return
    }
    if (archived) await registry.archiveSession(id)
    else await registry.unarchiveSession(id)
  }

  function storedSession() {
    return store.getState('session.current')
  }

  function isVisible() {
    return store.getState('session.visible') === true
  }

  function snapshot() {
    const stored = storedSession()
    return {
      id: sessionId ?? stored?.id ?? null,
      title: currentTitle,
      startedAt: startedAt ?? stored?.startedAt ?? null,
      visible: isVisible(),
      live: handle !== null,
      busy,
      rotating: pendingRotate !== null,
    }
  }

  function agentOptions() {
    const selection = ctx.agentDefaultModel.currentSelection()
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
  }

  async function setupAgent(agentCtx) {
    await ctx.agentPresets.mount(agentCtx, presetId)
    try {
      const tools = agentCtx.get?.('tools') ?? agentCtx.tools
      const scope = findScope(agentCtx)
      const names = scope === undefined || !tools ? [] : tools.definitions(scope).map((definition) => definition.name)
      logger.log?.(`[living] round tools: ${names.join(', ') || '(none)'}`)
    } catch (error) {
      logger.warn?.(`[living] round tools unavailable: ${error.message}`)
    }
  }

  async function createAgent(signal) {
    const id = `living_${randomUUID()}`
    const started = Date.now()
    try {
      handle = await ctx.agents.create({
        sessionId: id,
        meta: { cwd: workspace, agentPreset: presetId },
        agentOptions: agentOptions(),
        setup: setupAgent,
        signal,
      })
    } catch (error) {
      // A failed create may still leave stored session events; keep it out of the sidebar.
      setArchived(id, true).catch(() => {})
      throw error
    }
    sessionId = id
    startedAt = started
    applySessionTitle(handle.agent, typeof sessionTitle === 'function' ? await sessionTitle() : null)
    await store.setState('session.current', { id, startedAt })
    logger.log?.(`living: 主会话已创建 ${id}${currentTitle ? `（${currentTitle}）` : ''}`)
    return handle.agent
  }

  async function ensureAgent(signal) {
    if (handle) return handle.agent
    if (closed) throw new Error('living: 会话管理器已关闭')
    const stored = storedSession()
    if (stored?.id) {
      try {
        await setArchived(stored.id, false)
      } catch (error) {
        logger.warn?.(`living: 主会话解档失败 ${stored.id}: ${error.message}`)
      }
      const tryResume = async () => {
        handle = await ctx.agents.resume({
          resumeSessionId: stored.id,
          agentOptions: agentOptions(),
          setup: setupAgent,
          signal,
        })
        sessionId = stored.id
        startedAt = stored.startedAt ?? null
        rememberSessionTitle(handle.agent)
        logger.log?.(`living: 主会话已恢复 ${sessionId}${currentTitle ? `（${currentTitle}）` : ''}`)
        return handle.agent
      }
      try {
        return await tryResume()
      } catch (error) {
        if (signal?.aborted) throw error
        handle = null
        if (/active write handle/i.test(error.message)) {
          logger.warn?.(`living: 主会话被 UI/其他消费者占用（${stored.id}），归档后重试: ${error.message}`)
          try {
            await setArchived(stored.id, true)
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 800))
          try {
            const agent = await tryResume()
            await setArchived(stored.id, false)
            return agent
          } catch (retryError) {
            if (signal?.aborted) throw retryError
            logger.warn?.(`living: 主会话仍被占用（${stored.id}），改用新会话: ${retryError.message}`)
          }
        } else {
          logger.warn?.(`living: 主会话恢复失败（${stored.id}），改用新会话: ${error.message}`)
        }
      }
    }
    return createAgent(signal)
  }

  async function rotateNow(reason) {
    const id = sessionId ?? storedSession()?.id
    if (handle) {
      const current = handle
      handle = null
      try {
        await current.dispose()
      } catch (error) {
        logger.warn?.(`living: 主会话关闭失败: ${error.message}`)
      }
    }
    if (id) {
      try {
        await setArchived(id, true)
      } catch (error) {
        logger.warn?.(`living: 主会话归档失败 ${id}: ${error.message}`)
      }
    }
    sessionId = null
    startedAt = null
    currentTitle = null
    await store.setState('session.current', null)
    logger.log?.(`living: 主会话已轮换（${reason}）`)
  }

  async function rotate(reason = 'night') {
    if (busy) {
      pendingRotate = reason
      return snapshot()
    }
    await rotateNow(reason)
    return snapshot()
  }

  async function setVisible(visible) {
    const next = visible === true
    await store.setState('session.visible', next)
    const id = sessionId ?? storedSession()?.id
    if (id) {
      try {
        if (next) await setArchived(id, false)
        else if (!busy) await setArchived(id, true)
      } catch (error) {
        logger.warn?.(`living: 主会话可见性切换失败: ${error.message}`)
      }
    }
    logger.log?.(`living: 主会话侧栏${next ? '可见' : '隐藏'}`)
    return snapshot()
  }

  async function settle() {
    if (pendingRotate !== null) {
      const reason = pendingRotate
      pendingRotate = null
      await rotateNow(reason)
      return
    }
    if (!sessionId) return
    if (isVisible()) await setArchived(sessionId, false)
    else await setArchived(sessionId, true)
  }

  async function run({ prompt, signal, contextGuardTokens }) {
    if (busy) throw new Error('living: 主会话正忙')
    busy = true
    try {
      const agent = await ensureAgent(signal)
      if (!isVisible()) await setArchived(sessionId, false)
      // The signal only rejects waitForTurn; the live agent must be cancelled
      // explicitly, unlike the per-round handle that dispose() used to stop.
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('round_aborted')
      let onAbort = null
      try {
        // Subscribe before followup: a fast turn can start and end synchronously.
        const done = waitForTurn(agent, signal, { contextGuardTokens: contextGuardTokens ?? roundTokens })
        // Registered after waitForTurn so its abort rejection wins; cancel then
        // winds the live turn down before settle() asks the registry to archive.
        onAbort = () => agent.cancel({ kind: 'hook', reason: 'round_timeout' })
        signal?.addEventListener('abort', onAbort, { once: true })
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        })
        const result = await done
        await agent.whenIdle()
        return { ...result, sessionId }
      } catch (error) {
        await agent.whenIdle().catch(() => {})
        throw error
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
    } finally {
      try {
        await settle()
      } catch (error) {
        logger.warn?.(`living: 主会话收尾失败: ${error.message}`)
      }
      busy = false
    }
  }

  async function close() {
    if (closed) return
    closed = true
    const id = sessionId ?? storedSession()?.id
    if (handle) {
      const current = handle
      handle = null
      try {
        await current.dispose()
      } catch (error) {
        logger.warn?.(`living: 主会话关闭失败: ${error.message}`)
      }
    }
    if (id && !isVisible()) {
      try {
        await setArchived(id, true)
      } catch (error) {
        logger.warn?.(`living: 主会话归档失败 ${id}: ${error.message}`)
      }
    }
  }

  return { run, rotate, setVisible, snapshot, close }
}

async function archiveSession(ctx, sessionId) {
  const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
  if (!registry || typeof registry.archiveSession !== 'function') {
    console.warn('living: workspaceRegistry 未挂载，自治会话未归档')
    return
  }
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
  } catch (error) {
    console.warn(`living: 会话归档失败 ${sessionId}: ${error.message}`)
  }
}

async function registerLimiterPreset(ctx, presetId) {
  const dispose = await ctx.agentPresets.register({
    id: presetId,
    name: 'Living judge',
    description: 'Public outbound rule adjudication; no tools',
    order: 91,
    plugins: [...LIMITER_PRESET_PLUGINS],
  })
  console.log(`living: 限制层 preset 已注册（${presetId}）`)
  return dispose
}

async function registerSelfPreset(ctx, presetId) {
  const dispose = await ctx.agentPresets.register({
    id: presetId,
    name: 'Living self',
    description: 'Persona evolution; no tools',
    order: 92,
    plugins: [...SELF_PRESET_PLUGINS],
  })
  console.log(`living: 人格演化 preset 已注册（${presetId}）`)
  return dispose
}

async function registerMemoryPreset(ctx, presetId) {
  const dispose = await ctx.agentPresets.register({
    id: presetId,
    name: 'Living memory',
    description: 'Raw-to-memory normalization; no tools',
    order: 93,
    plugins: [...MEMORY_PRESET_PLUGINS],
  })
  console.log(`living: 记忆整理 preset 已注册（${presetId}）`)
  return dispose
}

async function registerRecollectPreset(ctx, presetId) {
  const dispose = await ctx.agentPresets.register({
    id: presetId,
    name: 'Living recollect',
    description: 'Read-only recollection subagent',
    order: 94,
    plugins: [...RECOLLECT_PRESET_PLUGINS],
  })
  console.log(`living: 回想 preset 已注册（${presetId}）`)
  return dispose
}


/** Structural guard: helper sessions must have an empty tool surface. */
function restrictAllTools(agentCtx, label = '限制层') {
  const tools = agentCtx.get?.('tools') ?? agentCtx.tools
  const scope = findScope(agentCtx)
  if (!tools || scope === undefined) throw new Error(`${label}拿不到工具面`)
  const before = tools.definitions(scope).map((definition) => definition.name)
  if (before.length > 0) tools.restrict({ deny: before })
  const after = tools.definitions(scope).map((definition) => definition.name)
  if (after.length > 0) throw new Error(`${label}仍可见工具: ${after.join(', ')}`)
  if (before.length > 0) console.log(`living: ${label}工具面已清空（${before.join(', ')}）`)
}

/** File/search/web tools the living agent may use; bash, subagent and workflow stay closed (ARCHITECTURE §10). */
export const LIVING_TOOL_PLUGINS = Object.freeze([
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
])

async function registerPreset(ctx, presetId, gems) {
  const dispose = await ctx.agentPresets.register({
    id: presetId,
    name: 'Living',
    description: '按设定活着的 agent：自己的作息、记忆与人格',
    order: 90,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: '你是一个按设定活着的 agent。你有自己的作息、记忆和人格。' },
      },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      ...LIVING_TOOL_PLUGINS,
      { id: 'living-agent', name: 'dsh-living/agent' },
      ...gemPresetPlugins(gems),
    ],
  })
  return dispose
}

function parseAutoRanges(text, field) {
  const raw = String(text ?? '').trim()
  if (raw === '') return []
  return raw.split(';').filter((part) => part.trim() !== '').map((part) => {
    const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part)
    if (!match) throw new Error(`living: ${field} 的区间格式不对: "${part}"（应如 06:00-08:00）`)
    const toMinutes = (hour, minute) => {
      const h = Number(hour)
      const m = Number(minute)
      if (h > 24 || m > 59 || (h === 24 && m !== 0)) throw new Error(`living: ${field} 的时间不合法: ${hour}:${minute}`)
      return h * 60 + m
    }
    const start = toMinutes(match[1], match[2])
    const end = toMinutes(match[3], match[4])
    if (start >= end) throw new Error(`living: ${field} 的区间必须 start < end: "${part}"`)
    return [start / 60, end / 60]
  })
}

function parseJsonObject(text, field) {
  let value
  try {
    value = JSON.parse(text ?? '{}')
  } catch (error) {
    throw new Error(`living: ${field} 不是合法 JSON: ${error.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`living: ${field} 必须是对象`)
  return value
}

function parseJsonArray(text, field) {
  let value
  try {
    value = JSON.parse(text ?? '[]')
  } catch (error) {
    throw new Error(`living: ${field} 不是合法 JSON: ${error.message}`)
  }
  if (!Array.isArray(value)) throw new Error(`living: ${field} 必须是数组`)
  return value
}
