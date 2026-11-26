import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildHandoffPrompt, clipHandoffText, tailFromRaw } from '../lib/handoff.mjs'

const raw = {
  payload: {
    messages: [
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在', reasoning: '不该进 tail' },
      { role: 'tool_call', name: 'living_state', text: '{}' },
      { role: 'event', text: '猫在敲碗' },
    ],
  },
}

test('handoff：prompt 带会话尾部、笔记与触发原因', () => {
  const prompt = buildHandoffPrompt({
    raw,
    notes: '- [持久] [猫粮] 先看粉料比例',
    reason: 'resume_failed',
  })
  assert.match(prompt, /最多 800 字/)
  assert.match(prompt, /resume_failed/)
  assert.match(prompt, /先看粉料比例/)
  assert.match(prompt, /在吗/)
  assert.match(prompt, /猫在敲碗/)
  assert.doesNotMatch(prompt, /不该进 tail/)
})

test('handoff：tail 只取 user/assistant/event 的最后几条', () => {
  const tail = tailFromRaw(raw, { maxMessages: 2 })
  assert.match(tail, /猫在敲碗/)
  assert.match(tail, /我：在/)
  assert.doesNotMatch(tail, /在吗/, '只取最后 2 条')
  assert.doesNotMatch(tail, /living_state/)
  assert.equal(tailFromRaw(null), '')
})

test('handoff：文本硬截断', () => {
  assert.equal(clipHandoffText(' x '), 'x')
  assert.equal(clipHandoffText('字'.repeat(5000)).length, 2000)
})
