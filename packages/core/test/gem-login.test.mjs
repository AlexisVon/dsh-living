import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGemLoginSupervisor } from '../lib/gem-login.mjs'

function setup(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'living-gem-login-'))
  mkdirSync(join(dir, 'channel'), { recursive: true })
  writeFileSync(join(dir, 'channel', 'login-rpc.mjs'), script)
  const gem = { manifest: { id: 'demo', name: 'Demo', version: '0.1.0' }, dir, skill: '' }
  const supervisor = createGemLoginSupervisor({ gems: [gem], gemHomes: { demo: join(dir, 'home') } })
  t.after(() => {
    supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return { supervisor, dir }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitStatus(supervisor, id, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let state = supervisor.status(id)
  while (!predicate(state) && Date.now() < deadline) {
    await sleep(20)
    state = supervisor.status(id)
  }
  return state
}

test('登录监督器：QR → status → done', async (t) => {
  const { supervisor } = setup(
    t,
    [
      "process.stdout.write(JSON.stringify({ type: 'qr', url: 'https://qr', svg: '<svg/>' }) + '\\n')",
      "setTimeout(() => {",
      "  process.stdout.write(JSON.stringify({ type: 'status', status: 'scaned' }) + '\\n')",
      "  process.stdout.write(JSON.stringify({ type: 'done', account: { name: 'n', id: '1' } }) + '\\n')",
      '}, 20)',
    ].join('\n'),
  )
  const first = supervisor.start('demo')
  assert.equal(first.status, 'starting')
  const state = await waitStatus(supervisor, 'demo', (value) => value.status === 'done')
  assert.equal(state.status, 'done')
  assert.equal(state.account.name, 'n')
  assert.equal(state.qr, null)
})

test('登录监督器：cancel 结束子进程', async (t) => {
  const { supervisor } = setup(t, "process.stdout.write(JSON.stringify({ type: 'qr', url: 'u', svg: '<svg/>' }) + '\\n'); setInterval(() => {}, 1000)\n")
  supervisor.start('demo')
  assert.equal((await waitStatus(supervisor, 'demo', (value) => value.status === 'wait')).status, 'wait')
  supervisor.cancel('demo')
  assert.equal(supervisor.status('demo').status, 'cancelled')
})

test('登录监督器：子进程异常退出 → error', async (t) => {
  const { supervisor } = setup(t, "process.stderr.write('boom'); process.exit(3)\n")
  supervisor.start('demo')
  const state = await waitStatus(supervisor, 'demo', (value) => value.status === 'error')
  assert.equal(state.status, 'error')
  assert.match(state.error, /boom|code=3/)
})
