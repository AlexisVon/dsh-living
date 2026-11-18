import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAdjudicator } from '../lib/adjudicator.mjs'

function fakeAgent({ reply = '', error = null } = {}) {
  const handlers = []
  const agent = {
    ctx: {
      on: (_name, handler) => {
        handlers.push(handler)
        return () => {}
      },
    },
    followup: () => {
      const emit = (type, data) => handlers.forEach((handler) => handler(null, { type, data }))
      if (error) {
        emit('turn/end', { turn: 1, reason: { kind: 'error', error: { code: error } } })
        return
      }
      if (reply) emit('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: reply }] } })
      emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    },
  }
  return agent
}

function fakeCtx({ agent, createError = null } = {}) {
  const created = []
  const context = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }) },
    agents: {
      create: async (args) => {
        created.push(args)
        if (createError) throw new Error(createError)
        return { agent, dispose: async () => {} }
      },
    },
  }
  return { context, created }
}

test('判决器：正常返回 pass 判定并归档会话', async () => {
  const agent = fakeAgent({ reply: '{"pass":true,"rule_id":null,"reason":""}' })
  const { context, created } = fakeCtx({ agent })
  const archived = []
  const setup = () => {}
  const adjudicate = createAdjudicator(context, {
    home: '/tmp/living',
    presetId: 'living-judge',
    logger: { warn: () => {} },
    archive: async (id) => archived.push(id),
    setup,
  })
  const verdict = await adjudicate({ text: '今天天气不错', gem: 'bili', target: 'reply:1:2:3', visibility: 'public' })

  assert.deepEqual(verdict, { pass: true, rule_id: null, reason: '' })
  assert.equal(created.length, 1)
  assert.equal(created[0].meta.agentPreset, 'living-judge')
  assert.equal(created[0].agentOptions.provider, 'p')
  assert.equal(created[0].agentOptions.reasoningEffort, 'low')
  assert.equal(created[0].setup, setup, '判决会话必须挂工具清空器')
  assert.equal(archived.length, 1)
  assert.ok(archived[0].startsWith('living_adjudicate_'))
})

test('判决器：模型不可用 → null（回退待审）且仍归档', async () => {
  const { context } = fakeCtx({ createError: 'provider_auth' })
  const archived = []
  const adjudicate = createAdjudicator(context, {
    home: '/tmp/living',
    presetId: 'living-judge',
    logger: { warn: () => {} },
    archive: async (id) => archived.push(id),
  })
  assert.equal(await adjudicate({ text: 'x', gem: 'wechat', visibility: 'public' }), null)
  assert.equal(archived.length, 1)
})

test('判决器：输出不合法 / 轮次失败 → null', async () => {
  for (const agent of [fakeAgent({ reply: '我觉得可以' }), fakeAgent({ error: 'provider_timeout' })]) {
    const { context } = fakeCtx({ agent })
    const adjudicate = createAdjudicator(context, {
      home: '/tmp/living',
      presetId: 'living-judge',
      logger: { warn: () => {} },
      archive: async () => {},
    })
    assert.equal(await adjudicate({ text: 'x', gem: 'bili', visibility: 'public' }), null)
  }
})
