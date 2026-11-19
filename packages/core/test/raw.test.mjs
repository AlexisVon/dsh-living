import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRawSegment, sessionMessages } from '../lib/raw.mjs'

test('raw：从 session 事件提取 user/assistant/tool，跳过 time-context', () => {
  const messages = sessionMessages([
    { type: 'user/message', time: 10, data: { content: [{ type: 'text', text: '在吗' }] } },
    { type: 'user/message', time: 11, data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'time' }] } },
    { type: 'assistant/message', time: 12, data: { message: { content: [{ type: 'text', text: '在' }, { type: 'reasoning', text: '想一想' }] } } },
    { type: 'tool/call', time: 13, data: { name: 'living_state', arguments: '{}' } },
    { type: 'tool/result', time: 14, data: { message: { content: [{ type: 'text', text: '状态' }] } } },
  ])
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'tool_call', 'tool_result'])
  assert.equal(messages[1].reasoning, '想一想')
  assert.equal(messages[2].name, 'living_state')
})

test('raw：journal / mark 工具调用不重复进 session raw', () => {
  const messages = sessionMessages([
    { type: 'tool/call', time: 1, data: { name: 'living_journal', callId: 'c1', arguments: '{"text":"日记"}' } },
    { type: 'tool/result', time: 2, data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: '已写入日记' }] } } },
    { type: 'tool/call', time: 3, data: { name: 'living_mark', callId: 'c2', arguments: '{"text":"标记"}' } },
    { type: 'tool/call', time: 4, data: { name: 'living_state', callId: 'c3', arguments: '{}' } },
  ])
  assert.deepEqual(messages.map((message) => (message.role === 'tool_call' ? message.name : message.role)), ['living_state'])
})

test('raw：从轮次 prompt 里只取新事件，丢掉 L0/情境/交接', () => {
  const messages = sessionMessages([{
    type: 'user/message',
    time: 10,
    data: {
      content: [{
        type: 'text',
        text: '## 你记得的事\n\n- 旧记忆\n\n## 上一段会话交接\n\n旧交接\n\n## 现在\n\n时间\n\n## 新事件\n\n- [wechat] [主人] 主人: 在吗 [回复目标: me]\n\n## 本轮\n\n有 1 条新事件。',
      }],
    },
  }])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'event')
  assert.match(messages[0].text, /在吗/)
  assert.doesNotMatch(messages[0].text, /旧记忆|旧交接|时间/)
})

test('raw：没有 session 文件时退化为事件账本', () => {
  const segment = buildRawSegment({
    sessionId: 's1',
    sessionRoot: null,
    kind: 'rest',
    nowMs: 100,
    events: [{ ts: 10, kind: 'message', source: 'wechat', payload: { text: '在吗' } }],
  })
  assert.equal(segment.id, 'raw_s1')
  assert.equal(segment.payload.source, 'events')
  assert.equal(segment.payload.messages[0].text, '在吗')
  assert.equal(segment.tsStart, 10)
})

test('raw：没有任何材料时不生成段', () => {
  const segment = buildRawSegment({ sessionId: null, sessionRoot: null, kind: 'night', nowMs: 100, events: [] })
  assert.equal(segment, null)
})
