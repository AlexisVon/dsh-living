import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as agent from '../agent.js'

test('agent 把会话静态前缀注册为系统提示词段（不是每轮用户消息）', () => {
  const sections = []
  const ctx = {
    living: { prelude: () => 'PRELUDE' },
    tools: { register: () => {} },
    systemPrompt: {
      section: (options) => {
        sections.push(options)
        return () => {}
      },
    },
    effect: (fn) => fn(),
  }

  assert.ok(agent.inject.includes('systemPrompt'))
  agent.apply(ctx)

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'living:prelude')
  assert.equal(sections[0].text, 'PRELUDE')
  assert.equal(sections[0].interpolate, false)
})
