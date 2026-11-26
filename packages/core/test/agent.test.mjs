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

test('living_note 工具：成功走 service、返回编号与余量、记一次 touch', async () => {
  const tools = []
  let touched = 0
  const ctx = {
    living: {
      prelude: () => '',
      touchNotes: () => {
        touched += 1
      },
      notesAdd: async () => ({ code: 'S1', stats: { persistent: 1, persistentMax: 50 } }),
      notesKeywords: () => ({ keywords: [{ tag: '猫粮', s: 1, a: 0, b: 0 }], stats: {} }),
    },
    tools: { register: (definition) => tools.push(definition), definitions: () => [] },
    systemPrompt: { section: () => () => {} },
    effect: (fn) => fn(),
  }
  agent.apply(ctx)
  const note = tools.find((tool) => tool.name === 'living_note')
  assert.ok(note, 'living_note 已注册')
  const result = await note.execute({ op: 'add', tier: 'persistent', tag: '猫粮', text: '先看粉料比例' })
  assert.match(result.text, /"ok":true/)
  assert.match(result.text, /"code":"S1"/)
  assert.match(result.text, /"persistent":1/)
  assert.equal(touched, 1)
  const table = await note.execute({ op: 'list' })
  assert.match(table.text, /"tag":"猫粮"/)
})
