/** Supervises a gem's `channel/login-rpc.mjs` child and exposes its latest QR/status. */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

const LOGIN_TIMEOUT_MS = 6 * 60_000
const TERMINAL = new Set(['done', 'error', 'cancelled'])

/** Env name a gem child reads its home directory from. */
export function gemHomeEnvName(id) {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_GEM_HOME`
}

export function createGemLoginSupervisor({ gems = [], gemHomes = {}, logger = console, spawnImpl = spawn } = {}) {
  const byId = new Map(gems.map((gem) => [gem.manifest.id, gem]))
  const runs = new Map()
  const states = new Map()

  function envName(id) {
    return gemHomeEnvName(id)
  }

  function start(id) {
    const gem = byId.get(id)
    if (!gem) throw new RangeError(`未知宝石: ${id}`)
    if (runs.has(id)) cancel(id)

    const state = { gem: id, status: 'starting', startedAt: Date.now(), updatedAt: Date.now(), qr: null, account: null, error: null }
    states.set(id, state)
    const patch = (next) => {
      Object.assign(state, next, { updatedAt: Date.now() })
    }

    let child
    try {
      child = spawnImpl(process.execPath, [join(gem.dir, 'channel', 'login-rpc.mjs')], {
        cwd: gem.dir,
        env: { ...process.env, [envName(id)]: gemHomes[id] },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      patch({ status: 'error', error: error.message })
      return state
    }

    const run = { child, stderr: '', timer: null }
    runs.set(id, run)
    const cleanup = () => {
      if (run.timer) clearTimeout(run.timer)
      if (runs.get(id) === run) runs.delete(id)
    }

    createInterface({ input: child.stdout }).on('line', (line) => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type === 'qr') {
        patch({ status: 'wait', qr: { url: String(event.url ?? ''), svg: String(event.svg ?? '') }, error: null })
      } else if (event.type === 'status') {
        patch({ status: String(event.status ?? 'wait') })
      } else if (event.type === 'done') {
        patch({ status: 'done', qr: null, account: event.account ?? null })
      } else if (event.type === 'error') {
        patch({ status: 'error', qr: null, error: String(event.message ?? '登录失败') })
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      run.stderr = (run.stderr + chunk).slice(-4000)
    })
    child.on('error', (error) => {
      patch({ status: 'error', qr: null, error: error.message })
      cleanup()
    })
    child.on('exit', (code, signal) => {
      if (!TERMINAL.has(state.status)) {
        patch({ status: 'error', qr: null, error: run.stderr.trim() || `登录进程退出（code=${code ?? signal ?? '?'}）` })
      }
      cleanup()
    })
    run.timer = setTimeout(() => {
      patch({ status: 'error', qr: null, error: '登录超时' })
      try {
        child.kill()
      } catch (error) {
        logger.warn?.(`living: 结束登录进程失败: ${error.message}`)
      }
    }, LOGIN_TIMEOUT_MS)
    run.timer.unref?.()
    return state
  }

  function status(id) {
    return states.get(id) ?? { gem: id, status: 'idle', qr: null, account: null, error: null }
  }

  function cancel(id) {
    const run = runs.get(id)
    if (!run) {
      const current = status(id)
      if (TERMINAL.has(current.status) || current.status === 'idle') return current
      const next = { gem: id, status: 'cancelled', updatedAt: Date.now(), qr: null, account: null, error: null }
      states.set(id, next)
      return next
    }
    try {
      run.child.kill()
    } catch {}
    if (run.timer) clearTimeout(run.timer)
    runs.delete(id)
    const next = { gem: id, status: 'cancelled', updatedAt: Date.now(), qr: null, account: null, error: null }
    states.set(id, next)
    return next
  }

  function dispose() {
    for (const id of [...runs.keys()]) cancel(id)
  }

  return { start, status, cancel, dispose }
}
