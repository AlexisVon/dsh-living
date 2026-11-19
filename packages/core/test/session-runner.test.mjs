import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSessionRunner } from '../index.js'

const silent = { log: () => {}, warn: () => {} }

/** Live agents + workspace archive set + life.db-shaped state, just enough for the runner. */
function createHost({ autoEnd = true } = {}) {
  const state = new Map()
  const store = {
    getState: (key) => (state.has(key) ? state.get(key) : null),
    setState: async (key, value) => {
      state.set(key, value)
      return value
    },
  }
  const known = new Set()
  const archive = new Set()
  const agents = new Map()
  const created = []
  const resumed = []
  const disposed = []
  let cancelled = 0

  function makeAgent(id) {
    const listeners = new Set()
    const agent = {
      id,
      status: 'idle',
      lastPrompt: null,
      followup(message) {
        this.lastPrompt = message.content?.[0]?.text ?? ''
        this.status = 'running'
        if (autoEnd) queueMicrotask(() => this.end())
      },
      end() {
        if (this.status !== 'running') return
        this.status = 'idle'
        for (const listener of [...listeners]) {
          listener(null, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        }
      },
      async whenIdle() {
        this.status = 'idle'
      },
      cancel(cause) {
        cancelled += 1
        this.cancelCause = cause
        this.end()
      },
      ctx: {
        on: (_name, callback) => {
          listeners.add(callback)
          return () => listeners.delete(callback)
        },
      },
    }
    return agent
  }

  function handle(id) {
    return {
      agent: agents.get(id),
      dispose: async () => {
        disposed.push(id)
        agents.delete(id)
      },
    }
  }

  const registry = {
    archiveSession: async (id) => {
      if (!known.has(id)) throw new Error(`unknown session ${id}`)
      if (agents.get(id)?.status === 'running') throw new Error(`active session ${id}`)
      archive.add(id)
    },
    unarchiveSession: async (id) => {
      archive.delete(id)
    },
  }

  const titles = []
  const sessionTitle = {
    rename: (_session, title) => {
      titles.push(title)
      return { title }
    },
    get: () => (titles.length > 0 ? { title: titles[titles.length - 1] } : undefined),
  }

  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'test' }) },
    agentPresets: { mount: async () => {} },
    agents: {
      create: async ({ sessionId }) => {
        known.add(sessionId)
        agents.set(sessionId, makeAgent(sessionId))
        created.push(sessionId)
        return handle(sessionId)
      },
      resume: async ({ resumeSessionId }) => {
        if (!known.has(resumeSessionId)) throw new Error('persistence miss')
        agents.set(resumeSessionId, makeAgent(resumeSessionId))
        resumed.push(resumeSessionId)
        return handle(resumeSessionId)
      },
    },
    get: (name) => (name === 'workspaceRegistry'
      ? registry
      : name === 'sessionTitle'
        ? sessionTitle
        : undefined),
  }

  return { ctx, store, known, archive, agents, created, resumed, disposed, titles, get cancelled() { return cancelled } }
}

function makeRunner(host, { title = 'living-2026-11-18-1' } = {}) {
  return createSessionRunner(host.ctx, {
    store: host.store,
    home: '/tmp/living-session-test',
    presetId: 'living',
    roundTokens: 1000,
    sessionTitle: () => title,
    logger: silent,
  })
}

test('同一白天复用同一个 agent；隐藏模式轮间归档', async () => {
  const host = createHost()
  const runner = makeRunner(host)
  await runner.run({ prompt: '第一条' })
  const id = host.created[0]
  assert.equal(host.created.length, 1)
  assert.equal(host.archive.has(id), true, '轮末隐藏')
  assert.equal(host.store.getState('session.current').id, id)

  await runner.run({ prompt: '第二条' })
  assert.equal(host.created.length, 1, '第二轮不再新建会话')
  assert.equal(host.agents.get(id).lastPrompt, '第二条')
  assert.equal(host.archive.has(id), true, '下一轮开始解档、轮末再归档')
})

test('会话标题：创建时设置', async () => {
  const host = createHost()
  const runner = makeRunner(host)
  await runner.run({ prompt: 'a' })
  assert.deepEqual(host.titles, ['living-2026-11-18-1'])
})

test('会话标题：每个新会话分配一次，恢复不占号', async () => {
  const host = createHost()
  let seq = 0
  const options = {
    store: host.store,
    home: '/tmp/living-session-test',
    presetId: 'living',
    roundTokens: 1000,
    sessionTitle: async () => {
      seq += 1
      await new Promise((resolve) => setImmediate(resolve))
      return `living-2026-11-19-${seq}`
    },
    logger: silent,
  }

  const runner = createSessionRunner(host.ctx, options)
  await runner.run({ prompt: 'a' })
  await runner.run({ prompt: 'b' })
  await runner.rotate('night')
  await runner.run({ prompt: 'c' })
  await runner.close()

  const resumedRunner = createSessionRunner(host.ctx, options)
  await resumedRunner.run({ prompt: 'd' })
  await resumedRunner.close()

  assert.deepEqual(host.titles, ['living-2026-11-19-1', 'living-2026-11-19-2'])
})

test('侧栏可见性即时切换，不换会话', async () => {
  const host = createHost()
  const runner = makeRunner(host)
  await runner.run({ prompt: 'a' })
  const id = host.created[0]
  assert.equal(host.archive.has(id), true)

  await runner.setVisible(true)
  assert.equal(host.store.getState('session.visible'), true)
  assert.equal(host.archive.has(id), false, '切换可见立即解档')
  await runner.run({ prompt: 'b' })
  assert.equal(host.archive.has(id), false, '可见模式轮末不归档')

  await runner.setVisible(false)
  assert.equal(host.archive.has(id), true, '切换隐藏立即归档')
  assert.equal(host.created.length, 1, '可见性切换不需要新会话')
})

test('睡眠轮换：拆掉常驻 agent，下一轮新建', async () => {
  const host = createHost()
  const runner = makeRunner(host)
  await runner.run({ prompt: 'a' })
  const first = host.created[0]

  await runner.rotate('night')
  assert.deepEqual(host.disposed, [first])
  assert.equal(host.archive.has(first), true)
  assert.equal(host.store.getState('session.current'), null)

  await runner.run({ prompt: 'after-night' })
  assert.equal(host.created.length, 2)
  assert.notEqual(host.created[1], first)
})

test('轮次进行中的轮换排到轮末，不拆正在跑的 agent', async () => {
  const host = createHost({ autoEnd: false })
  const runner = makeRunner(host)
  const pending = runner.run({ prompt: 'slow' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const id = host.created[0]
  assert.equal(host.agents.get(id).status, 'running')

  await runner.rotate('night')
  assert.deepEqual(host.disposed, [], '轮次未结束时不得 dispose')

  host.agents.get(id).end()
  await pending
  assert.deepEqual(host.disposed, [id], '轮末再轮换')
  assert.equal(host.archive.has(id), true)
})

test('宿主重启后按 life.db 里的会话 id 恢复同一条对话', async () => {
  const host = createHost()
  const first = makeRunner(host)
  await first.run({ prompt: 'before-restart' })
  const id = host.created[0]
  await first.close()
  assert.equal(host.archive.has(id), true, '隐藏模式关闭时归档')

  const second = makeRunner(host)
  await second.run({ prompt: 'after-restart' })
  assert.deepEqual(host.resumed, [id])
  assert.equal(host.created.length, 1, '恢复成功不应新建')
  assert.equal(host.agents.get(id).lastPrompt, 'after-restart')
})

test('轮次超时：取消当前 turn，agent 不留在 running', async () => {
  const host = createHost({ autoEnd: false })
  const runner = makeRunner(host)
  const controller = new AbortController()
  const pending = runner.run({ prompt: 'timeout', signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const id = host.created[0]

  controller.abort(new Error('round_timeout'))
  await assert.rejects(pending, /round_timeout/)
  assert.equal(host.cancelled, 1)
  assert.equal(host.agents.get(id).status, 'idle')
  assert.equal(host.archive.has(id), true)
})
