/** Authenticated admin channel carried by DSH Connection; the browser never hits raw REST. */

import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { buildLiveReport, listReports, readReport } from './observe.mjs'
import { buildTimeline } from './timeline.mjs'
import { defaultGemHome, gemSummaries, writeGemConfig } from './gem-admin.mjs'
import { MAX_IMPORT_BYTES, cancelPendingImport, createSnapshot, dataInfo, readPendingImport, stageImport } from './backup.mjs'
import { catalogStatus, installGem, uninstallGem } from './gem-store.mjs'

export const ADMIN_CHANNEL = '/api'
export const ADMIN_ENDPOINT = 'living-admin'

/** Authenticated exact route on the shared /api channel; envelopes mirror Connection RPC. */
export function createAdminFetch({
  runtime,
  store,
  home,
  layout,
  workspace = null,
  gemStoreDir = null,
  gemDataDir = null,
  gemCatalog = null,
  gems = [],
  gemHomes = {},
  gemLogin = null,
  session = null,
  setGemToken = null,
  gemTokenStatus = null,
}) {
  const handle = createAdminRpc({
    runtime,
    store,
    home,
    layout,
    workspace,
    gemStoreDir,
    gemDataDir,
    gemCatalog,
    gems,
    gemHomes,
    gemLogin,
    session,
    setGemToken,
    gemTokenStatus,
  })
  return async function fetch(request) {
    let envelope
    try {
      envelope = await request.json()
    } catch {
      return jsonResponse(400, null, fail('invalid_json', '请求体不是合法 JSON'))
    }
    if (!envelope || envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string') {
      return jsonResponse(400, null, fail('invalid_envelope', '不是 Connection RPC 请求'))
    }
    const payload = envelope.payload ?? {}
    if (payload.endpoint === undefined) {
      return jsonResponse(200, envelope.rpcId, fail('missing_endpoint', '缺少 endpoint'))
    }
    const result = await handle(String(payload.endpoint), payload.payload ?? {})
    return jsonResponse(200, envelope.rpcId, result)
  }
}

export function createAdminRpc({
  runtime,
  store,
  home,
  layout,
  workspace = null,
  gemStoreDir = null,
  gemDataDir = null,
  gemCatalog = null,
  gems = [],
  gemHomes = {},
  gemLogin = null,
  session = null,
  setGemToken = null,
  gemTokenStatus = null,
}) {
  if (!runtime || !store) throw new RangeError('admin rpc 需要 runtime 与 store')

  return async function handle(endpoint, payload = {}) {
    try {
      if (endpoint === 'state') return ok({ ...runtime.snapshot(), session: session?.snapshot?.() ?? null })
      if (endpoint === 'sessionVisibility') {
        if (!session) return fail('session_unavailable', '当前宿主没有主会话管理器')
        return ok(await session.setVisible(payload?.visible === true))
      }
      if (endpoint === 'unschedule') {
        const ids = Array.isArray(payload?.ids) ? payload.ids : (payload?.id ? [payload.id] : [])
        return ok(await runtime.service().unschedule(ids))
      }
      if (endpoint === 'budgetReset') {
        return ok(await runtime.service().resetBudget(String(payload?.reason ?? 'manual')))
      }
      if (endpoint === 'sleep') {
        const service = runtime.service()
        const state = service.manualSleepState()
        if (state.sleeping) return ok({ ok: false, error: 'already_sleeping' })
        if (state.busy) return ok({ ok: false, error: 'busy' })
        const unlimited = payload?.unlimited === true
        Promise.resolve(service.manualSleep('night', { unlimited }))
          .catch((error) => console.error(`living: 手动 sleep 失败: ${error.message}`))
        return ok({ ok: true, started: true, unlimited })
      }
      if (endpoint === 'dataInfo') {
        if (!layout) return fail('backup_unavailable', '数据目录不可用')
        return ok({ ...dataInfo({ layout, store }), workspace: workspace ?? layout.workspace })
      }
      if (endpoint === 'backup') {
        if (!layout) return fail('backup_unavailable', '数据目录不可用')
        const snapshot = await createSnapshot({ store, layout })
        if (snapshot.bytes > MAX_IMPORT_BYTES) {
          return fail('backup_too_large', `快照 ${snapshot.bytes} 字节，超过 ${MAX_IMPORT_BYTES}；可直接复制 ${snapshot.path}`)
        }
        return ok({
          ...snapshot,
          mediaType: 'application/x-sqlite3',
          schemaVersion: store.schemaVersion(),
          data: readFileSync(snapshot.path).toString('base64'),
        })
      }
      if (endpoint === 'importBackup') {
        if (!layout) return fail('backup_unavailable', '数据目录不可用')
        if (readPendingImport(layout)) return fail('import_pending', '已有待导入的记忆库；先取消或重启宿主应用')
        const name = String(payload?.name ?? 'life.db')
        const encoded = String(payload?.data ?? '').replaceAll(/\s+/gu, '')
        if (encoded === '' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return fail('invalid_import', '导入内容不是合法 base64')
        if (encoded.length > Math.ceil(MAX_IMPORT_BYTES * 4 / 3) + 8) return fail('import_too_large', `导入文件超过 ${MAX_IMPORT_BYTES} 字节`)
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.length === 0) return fail('invalid_import', '导入内容为空')
        if (bytes.length > MAX_IMPORT_BYTES) return fail('import_too_large', `导入文件超过 ${MAX_IMPORT_BYTES} 字节`)
        const pending = stageImport({ layout, bytes, name })
        return ok({ ...pending, restartRequired: true })
      }
      if (endpoint === 'importCancel') {
        if (!layout) return fail('backup_unavailable', '数据目录不可用')
        return ok(cancelPendingImport(layout))
      }
      if (endpoint === 'importStatus') {
        if (!layout) return fail('backup_unavailable', '数据目录不可用')
        return ok(readPendingImport(layout))
      }
      if (endpoint === 'personaState') return ok(runtime.service().personaState())
      if (endpoint === 'personaVersion') {
        return ok(runtime.service().personaVersion(String(payload?.id ?? payload?.hash ?? '')))
      }
      if (endpoint === 'personaCharterSet') {
        return ok(await runtime.service().personaCharterSet(String(payload?.text ?? '')))
      }
      if (endpoint === 'personaSelfSet') {
        return ok(await runtime.service().personaSelfSet(String(payload?.text ?? '')))
      }
      if (endpoint === 'personaReset') {
        return ok(await runtime.service().personaReset({
          to: String(payload?.to ?? 'empty'),
          version: payload?.version ? String(payload.version) : null,
        }))
      }
      if (endpoint === 'personaEvolveMode') {
        return ok(await runtime.service().setPersonaEvolveMode(String(payload?.mode ?? '')))
      }
      if (endpoint === 'personaEvolveNow') {
        return ok(await runtime.service().evolvePersonaNow())
      }
      if (endpoint === 'rounds') {
        return ok(store.listRounds({ since: payload?.since ?? null, limit: payload?.limit ?? 50 }))
      }
      if (endpoint === 'timeline') {
        return ok(buildTimeline({
          store,
          since: Number.isFinite(payload?.since) ? payload.since : null,
          until: Number.isFinite(payload?.until) ? payload.until : null,
          limit: payload?.limit ?? 500,
        }))
      }
      if (endpoint === 'memory') {
        return ok(runtime.service().recall(String(payload?.query ?? ''), { topK: payload?.topK ?? 8 }))
      }
      if (endpoint === 'memoryBrowse') {
        const layer = String(payload?.layer ?? 'items')
        const limit = payload?.limit ?? 100
        if (layer === 'raw') return ok(store.listRawSegments({ status: payload?.status ?? null, limit }))
        if (layer === 'edges') return ok(store.listAllMemoryEdges({ status: payload?.status ?? 'active', limit }))
        if (layer === 'cold') return ok(store.listCold({ limit }))
        return ok(store.listMemoryItems({ kind: payload?.kind ?? null, limit }))
      }
      if (endpoint === 'memoryItems') {
        return ok(store.listMemoryItems({ kind: payload?.kind ?? null, limit: payload?.limit ?? 100 }))
      }
      if (endpoint === 'memoryRaw') {
        return ok(store.listRawSegments({ status: payload?.status ?? null, limit: payload?.limit ?? 100 }))
      }
      if (endpoint === 'memoryEdges') {
        return ok(store.listAllMemoryEdges({ status: payload?.status ?? 'active', limit: payload?.limit ?? 100 }))
      }
      if (endpoint === 'memoryCold') {
        return ok(store.listCold({ limit: payload?.limit ?? 100 }))
      }
      if (endpoint === 'memoryDetail') {
        const item = store.getMemoryItem({ kind: String(payload?.kind ?? ''), id: String(payload?.id ?? '') })
        if (!item) return fail('not_found', '没有这条记忆')
        return ok({
          item,
          edges: store.listMemoryEdges({ kind: item.kind, id: item.id, limit: 50 }),
        })
      }
      if (endpoint === 'outbox') {
        return ok(store.listOutbox({ gem: payload?.gem ?? null, limit: payload?.limit ?? 50 }))
      }
      if (endpoint === 'stats') {
        return ok(runtime.service().stats({ days: payload?.days ?? 1 }))
      }
      if (endpoint === 'approve') {
        await store.approveOutbox(requiredId(payload), Date.now())
        return ok({ ok: true })
      }
      if (endpoint === 'reject') {
        await store.rejectOutbox(requiredId(payload), payload?.reason ?? 'rejected by user', Date.now())
        return ok({ ok: true })
      }
      if (endpoint === 'gems') {
        return ok(gemSummaries({
          gems,
          gemHomes,
          gemDataDir,
          health: runtime.snapshot().gems,
          tokens: typeof gemTokenStatus === 'function' ? gemTokenStatus() : {},
        }))
      }
      if (endpoint === 'gemCatalog') {
        if (!gemCatalog || !gemStoreDir || !gemDataDir) return fail('gem_store_unavailable', '宝石库不可用')
        return ok(catalogStatus(gemCatalog, { storeDir: gemStoreDir, gemDataDir }))
      }
      if (endpoint === 'gemInstall') {
        if (!gemCatalog || !gemStoreDir) return fail('gem_store_unavailable', '宝石库不可用')
        const id = String(payload?.id ?? '')
        const entry = gemCatalog.gems.find((candidate) => candidate.id === id)
        if (!entry) return fail('unknown_gem', `宝石目录没有 ${id || '(empty)'}`)
        const loaded = gems.find((candidate) => candidate.manifest.id === id)
        if (loaded && !loaded.dir.startsWith(join(gemStoreDir, 'node_modules') + sep)) {
          return fail('gem_duplicate', `宝石 ${id} 已从本地目录加载，先从 gemDirs 移除`)
        }
        const result = await installGem({ entry, storeDir: gemStoreDir, logger: console })
        const restartRequired = !loaded || loaded.dir !== result.dir || loaded.manifest.version !== result.version
        return ok({ ...result, restartRequired })
      }
      if (endpoint === 'gemUninstall') {
        if (!gemStoreDir || !gemDataDir) return fail('gem_store_unavailable', '宝石库不可用')
        const id = String(payload?.id ?? '')
        const loaded = gems.find((candidate) => candidate.manifest.id === id)
        const entry = gemCatalog?.gems.find((candidate) => candidate.id === id) ?? null
        const result = await uninstallGem({ id, package: entry?.package ?? null, storeDir: gemStoreDir, gemDataDir, logger: console })
        if (!result.removed) {
          if (loaded) return fail('gem_external', `宝石 ${id} 由 gemDirs 加载，不在宝石库；请手动移除目录 ${loaded.dir}`)
          return fail('unknown_gem', `宝石库没有 ${id || '(empty)'}`)
        }
        return ok({ ...result, restartRequired: loaded?.dir === result.dir })
      }
      if (endpoint === 'gemConfig') {
        const gem = requiredGem(payload, gems)
        if (!gemDataDir && !gemHomes[gem.manifest.id]) return fail('gem_store_unavailable', '宝石数据目录不可用')
        const config = writeGemConfig(
          gemHomes[gem.manifest.id] ?? defaultGemHome(gemDataDir, gem.manifest.id),
          payload?.config,
          gem.manifest.config?.fields ?? null,
        )
        return ok({ id: gem.manifest.id, config })
      }
      if (endpoint === 'gemSkill') {
        const gem = requiredGem(payload, gems)
        return ok({ id: gem.manifest.id, text: gem.skill ?? '' })
      }
      if (endpoint === 'gemTokenSet') {
        if (typeof setGemToken !== 'function') return fail('token_unavailable', '当前宿主没有 settings 服务，无法保存 token')
        const gem = requiredGem(payload, gems)
        const token = typeof payload?.token === 'string' ? payload.token.trim() : ''
        if (token !== '' && !/^[A-Za-z0-9._~-]{8,256}$/u.test(token)) {
          return fail('invalid_token', 'token 需为 8–256 位字母、数字或 . _ ~ -')
        }
        const result = await setGemToken(gem.manifest.id, token)
        return ok({ id: gem.manifest.id, ...result })
      }
      if (endpoint === 'gemLoginStart' || endpoint === 'gemLoginStatus' || endpoint === 'gemLoginCancel' || endpoint === 'gemLoginInput') {
        if (!gemLogin) return fail('login_unavailable', '当前宿主没有登录监督器')
        const gem = requiredGem(payload, gems)
        const id = gem.manifest.id
        if (endpoint === 'gemLoginStart') return ok(gemLogin.start(id))
        if (endpoint === 'gemLoginStatus') return ok(gemLogin.status(id))
        if (endpoint === 'gemLoginInput') {
          if (typeof gemLogin.input !== 'function') return fail('login_unavailable', '当前登录监督器不支持输入')
          const promptId = typeof payload?.promptId === 'string' ? payload.promptId : ''
          if (promptId === '') return fail('invalid_prompt', 'promptId 必填')
          if (typeof payload?.value !== 'string') return fail('invalid_value', 'value 必须是字符串')
          return ok(gemLogin.input(id, promptId, payload.value))
        }
        return ok(gemLogin.cancel(id))
      }
      if (endpoint === 'embedConfig') return ok(runtime.service().embedConfig())
      if (endpoint === 'embedConfigSave') return ok(await runtime.service().embedConfigSave(payload ?? {}))
      if (endpoint === 'embedModels') return ok(await runtime.service().embedModels(payload?.url))
      if (endpoint === 'embedTest') return ok(await runtime.service().embedTest(payload ?? {}))
      if (endpoint === 'embedReindex') return ok(await runtime.service().embedReindex({ limit: payload?.limit }))
      if (endpoint === 'recollect') return ok(await runtime.service().recollect(payload ?? {}))
      if (endpoint === 'reports') return ok(listReports(store))
      if (endpoint === 'report') {
        const date = String(payload?.date ?? '')
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('invalid_date', `日期不合法: ${date}`)
        let report = readReport(store, date)
        if (!report) {
          const snap = runtime.snapshot()
          report = buildLiveReport({
            home,
            store,
            date,
            tzOffsetMinutes: snap.timezoneOffsetMinutes ?? -new Date().getTimezoneOffset(),
            sessionRoot: snap.sessionRoot ?? null,
            now: Date.now(),
          })
          report.live = true
        }
        return ok(report)
      }
      return fail('unknown_endpoint', `未知管理端点: ${endpoint}`)
    } catch (error) {
      const code = error?.code ?? (Array.isArray(error?.errors) ? 'config_invalid' : 'living_admin_error')
      return fail(code, error?.message ?? String(error))
    }
  }
}

function requiredId(payload) {
  if (typeof payload?.id !== 'string' || payload.id === '') throw new RangeError('缺少 outbox id')
  return payload.id
}

function requiredGem(payload, gems) {
  const id = String(payload?.gem ?? '')
  const gem = gems.find((candidate) => candidate.manifest.id === id)
  if (!gem) throw new RangeError(`未知宝石: ${id || '(empty)'}`)
  return gem
}

function ok(value) {
  return { ok: true, value }
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

function jsonResponse(status, rpcId, result) {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
