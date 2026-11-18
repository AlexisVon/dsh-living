import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { createGemChannelSupervisor } from '../lib/gem-channel.mjs'

function gem(id = 'demo', channel = { command: 'node', args: ['channel/run.mjs'] }) {
  return { dir: `/gems/${id}`, manifest: { id, channel }, skill: '' }
}

function fakeSpawn(spawned) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 1000 + spawned.length
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = (signal) => {
      child.emit('exit', null, signal)
      return true
    }
    spawned.push({ command, args, options, child })
    return child
  }
}

const silentLogger = { log: () => {}, warn: () => {} }

test('只拉起声明了 channel 且配置了 token 的宝石', () => {
  const spawned = []
  const supervisor = createGemChannelSupervisor({
    gems: [gem('with-token'), gem('no-token'), { dir: '/gems/skill-only', manifest: { id: 'skill-only' }, skill: '' }],
    tokens: { 'with-token': 't1' },
    baseUrl: 'http://127.0.0.1:3080',
    gemHomes: { 'with-token': '/home/one' },
    spawnImpl: fakeSpawn(spawned),
    logger: silentLogger,
  })
  supervisor.startAll()

  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, 'node')
  assert.deepEqual(spawned[0].args, ['channel/run.mjs'])
  assert.equal(spawned[0].options.cwd, '/gems/with-token')
  assert.equal(spawned[0].options.env.LIVING_BASE_URL, 'http://127.0.0.1:3080')
  assert.equal(spawned[0].options.env.LIVING_GEM_ID, 'with-token')
  assert.equal(spawned[0].options.env.LIVING_GEM_TOKEN, 't1')
  assert.equal(spawned[0].options.env.WITH_TOKEN_GEM_HOME, '/home/one')

  const states = Object.fromEntries(supervisor.snapshot().map((entry) => [entry.id, entry.state]))
  assert.equal(states['with-token'], 'running')
  assert.equal(states['no-token'], 'unconfigured')
  assert.equal(states['skill-only'], undefined)
})

test('退出后按退避重启，稳定运行后回调 onSuccess', async (t) => {
  const spawned = []
  const failures = []
  const successes = []
  const supervisor = createGemChannelSupervisor({
    gems: [gem()],
    tokens: { demo: 't1' },
    baseUrl: 'http://127.0.0.1:3080',
    spawnImpl: fakeSpawn(spawned),
    backoffMs: [5],
    stableMs: 10,
    logger: silentLogger,
    onFailure: (id) => failures.push(id),
    onSuccess: (id) => successes.push(id),
  })
  t.after(() => supervisor.dispose())
  supervisor.startAll()

  spawned[0].child.emit('exit', 1, null)
  assert.deepEqual(failures, ['demo'])
  assert.equal(supervisor.snapshot()[0].state, 'backoff')

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(spawned.length, 2)
  assert.equal(supervisor.snapshot()[0].state, 'running')

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(successes, ['demo'])
})

test('dispose 停掉子进程且不再重启', async () => {
  const spawned = []
  const supervisor = createGemChannelSupervisor({
    gems: [gem()],
    tokens: { demo: 't1' },
    baseUrl: 'http://127.0.0.1:3080',
    spawnImpl: fakeSpawn(spawned),
    backoffMs: [5],
    logger: silentLogger,
  })
  supervisor.startAll()
  await supervisor.dispose()

  assert.equal(spawned.length, 1)
  assert.equal(supervisor.snapshot()[0].state, 'stopped')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(spawned.length, 1)
})

test('未登录退出（code=2）按最长退避重试，且只提示一次', async (t) => {
  const spawned = []
  const logs = []
  const supervisor = createGemChannelSupervisor({
    gems: [gem()],
    tokens: { demo: 't1' },
    baseUrl: 'http://127.0.0.1:3080',
    spawnImpl: fakeSpawn(spawned),
    backoffMs: [1, 5],
    logger: { log: (message) => logs.push(message), warn: () => {} },
  })
  t.after(() => supervisor.dispose())
  supervisor.startAll()

  spawned[0].child.emit('exit', 2, null)
  const entry = supervisor.snapshot()[0]
  assert.equal(entry.state, 'backoff')
  assert.equal(entry.lastExit, 2)

  await new Promise((resolve) => setTimeout(resolve, 12))
  assert.equal(spawned.length, 2)
  spawned[1].child.emit('exit', 2, null)
  assert.equal(logs.filter((line) => line.includes('未登录')).length, 1)
})

test('setToken：换 token 立即重启，清除 token 停在 unconfigured', async (t) => {
  const spawned = []
  const supervisor = createGemChannelSupervisor({
    gems: [gem()],
    tokens: { demo: 't1' },
    baseUrl: 'http://127.0.0.1:3080',
    spawnImpl: fakeSpawn(spawned),
    logger: silentLogger,
  })
  t.after(() => supervisor.dispose())
  supervisor.startAll()
  assert.equal(spawned.length, 1)

  assert.equal(supervisor.setToken('demo', 't2'), true)
  assert.equal(spawned.length, 2)
  assert.equal(spawned[1].options.env.LIVING_GEM_TOKEN, 't2')
  assert.equal(supervisor.snapshot()[0].state, 'running')
  assert.equal(supervisor.snapshot()[0].configured, true)

  supervisor.setToken('demo', '')
  assert.equal(spawned.length, 2, '清除 token 不再拉起')
  assert.equal(supervisor.snapshot()[0].state, 'unconfigured')
  assert.equal(supervisor.snapshot()[0].configured, false)
  assert.throws(() => supervisor.setToken('nope', 'x'), /未知宝石通道/)
})
