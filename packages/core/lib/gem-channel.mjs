/** Supervises each gem's declared channel process: spawn, restart with backoff, health. */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { gemHomeEnvName } from './gem-login.mjs'

const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000]
const STABLE_MS = 60_000
const NEEDS_LOGIN_EXIT = 2
const KILL_GRACE_MS = 3_000

export function createGemChannelSupervisor({
  gems = [],
  gemHomes = {},
  tokens = {},
  baseUrl,
  logger = console,
  spawnImpl = spawn,
  now = Date.now,
  backoffMs = BACKOFF_MS,
  stableMs = STABLE_MS,
  onFailure = () => {},
  onSuccess = () => {},
} = {}) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new RangeError('gem channel supervisor 需要 baseUrl')

  const runs = new Map()
  let stopping = false

  for (const gem of gems) {
    const declaration = gem.manifest.channel
    if (!declaration) continue
    const id = gem.manifest.id
    const token = typeof tokens[id] === 'string' ? tokens[id] : ''
    runs.set(id, {
      id,
      gem,
      declaration,
      token,
      state: token === '' ? 'unconfigured' : 'idle',
      child: null,
      timer: null,
      stableTimer: null,
      pid: null,
      since: null,
      failures: 0,
      restarts: 0,
      loginWarned: false,
      lastExit: null,
      lastError: null,
      retryAt: null,
      intentional: false,
      pendingStart: false,
    })
  }

  function log(message) {
    logger.log?.(`living: ${message}`)
  }

  function snapshot() {
    return [...runs.values()].map((run) => ({
      id: run.id,
      state: run.state,
      configured: run.token !== '',
      pid: run.pid,
      since: run.since,
      restarts: run.restarts,
      failures: run.failures,
      lastExit: run.lastExit,
      lastError: run.lastError,
      retryAt: run.retryAt,
    }))
  }

  function start(id) {
    const run = runs.get(id)
    if (!run || stopping || run.child) return
    if (run.token === '') return
    run.intentional = false

    let child
    try {
      child = spawnImpl(run.declaration.command, run.declaration.args ?? [], {
        cwd: run.gem.dir,
        env: {
          ...process.env,
          LIVING_BASE_URL: baseUrl,
          LIVING_GEM_ID: run.id,
          LIVING_GEM_TOKEN: run.token,
          [gemHomeEnvName(run.id)]: gemHomes[run.id] ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      run.state = 'backoff'
      run.lastError = error.message
      schedule(run, null)
      return
    }

    run.child = child
    run.state = 'running'
    run.pid = child.pid ?? null
    run.since = now()
    run.retryAt = null
    log(`宝石通道已启动: ${run.id}（pid ${run.pid ?? '?'}）`)

    for (const [stream, write] of [
      [child.stdout, (line) => logger.log?.(`[gem:${run.id}] ${line}`)],
      [child.stderr, (line) => logger.warn?.(`[gem:${run.id}] ${line}`)],
    ]) {
      if (!stream) continue
      createInterface({ input: stream }).on('line', write)
    }

    let settled = false
    const settle = (code, signal) => {
      if (settled) return
      settled = true
      run.child = null
      run.pid = null
      clearTimeout(run.stableTimer)
      run.stableTimer = null
      if (stopping) {
        run.state = 'stopped'
        return
      }
      if (run.intentional) {
        run.intentional = false
        if (run.pendingStart) {
          run.pendingStart = false
          run.failures = 0
          run.state = 'idle'
          start(run.id)
        } else {
          run.state = run.token === '' ? 'unconfigured' : 'idle'
        }
        return
      }
      run.lastExit = code ?? signal ?? null
      run.restarts += 1
      onFailure(run.id, 'gem_unavailable')
      run.state = 'backoff'
      schedule(run, code)
    }

    child.on('error', (error) => {
      run.lastError = error.message
      settle(null, null)
    })
    child.on('exit', (code, signal) => settle(code, signal))

    run.stableTimer = setTimeout(() => {
      run.stableTimer = null
      run.failures = 0
      run.loginWarned = false
      run.lastError = null
      onSuccess(run.id)
      log(`宝石通道稳定运行: ${run.id}`)
    }, stableMs)
    run.stableTimer.unref?.()
  }

  /** Replace one channel's token and restart it in place (settings write already landed). */
  function setToken(id, token) {
    const run = runs.get(id)
    if (!run) throw new RangeError(`未知宝石通道: ${id}`)
    const next = typeof token === 'string' ? token : ''
    if (run.token === next) return true
    run.token = next
    run.failures = 0
    run.restarts = 0
    run.retryAt = null
    run.lastError = null
    run.lastExit = null
    clearTimeout(run.timer)
    run.timer = null
    clearTimeout(run.stableTimer)
    run.stableTimer = null
    const child = run.child
    if (child === null) {
      run.pendingStart = false
      if (stopping) return true
      if (next === '') run.state = 'unconfigured'
      else {
        run.state = 'idle'
        start(id)
      }
      return true
    }
    run.intentional = true
    run.pendingStart = next !== ''
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, KILL_GRACE_MS)
    killer.unref?.()
    child.once('exit', () => clearTimeout(killer))
    try {
      child.kill('SIGTERM')
    } catch {}
    log(`宝石通道 token 已更新: ${id}${next === '' ? '（已清除）' : ''}`)
    return true
  }

  function schedule(run, code) {
    if (stopping) return
    clearTimeout(run.timer)
    const index = code === NEEDS_LOGIN_EXIT ? backoffMs.length - 1 : Math.min(run.failures, backoffMs.length - 1)
    run.failures = Math.min(run.failures + 1, backoffMs.length - 1)
    const delay = backoffMs[index]
    run.retryAt = now() + delay
    run.timer = setTimeout(() => start(run.id), delay)
    run.timer.unref?.()
    if (code === NEEDS_LOGIN_EXIT) {
      if (!run.loginWarned) {
        run.loginWarned = true
        log(`${run.id} 通道未登录（exit 2）；每 ${delay / 1000}s 重试，先运行 channel/login.mjs`)
      }
      return
    }
    const reason = run.lastError ? `: ${run.lastError}` : code === null ? '' : `（code=${code}）`
    log(`${run.id} 通道退出${reason}；${delay / 1000}s 后重启`)
  }

  function startAll() {
    for (const run of runs.values()) {
      if (run.state === 'unconfigured') {
        log(`宝石通道未配置 token，跳过: ${run.id}`)
        continue
      }
      start(run.id)
    }
  }

  async function dispose() {
    stopping = true
    const waits = []
    for (const run of runs.values()) {
      clearTimeout(run.timer)
      clearTimeout(run.stableTimer)
      run.state = 'stopped'
      const child = run.child
      if (!child) continue
      waits.push(
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {}
            resolve()
          }, KILL_GRACE_MS)
          timer.unref?.()
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
          try {
            child.kill('SIGTERM')
          } catch {
            clearTimeout(timer)
            resolve()
          }
        }),
      )
    }
    await Promise.all(waits)
  }

  return { startAll, snapshot, setToken, dispose }
}
