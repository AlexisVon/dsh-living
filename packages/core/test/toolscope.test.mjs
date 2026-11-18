import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DENY_RULES, parseDenyRules, softBanNotice } from '../lib/toolscope.mjs'

test('规则解析：前缀与精确，非法项跳过', () => {
  assert.deepEqual(parseDenyRules(['mnemon_*', 'working_directory', '', '  ', 42, '*']), [
    { kind: 'prefix', value: 'mnemon_' },
    { kind: 'exact', value: 'working_directory' },
  ])
  assert.deepEqual(parseDenyRules(null), [])
  assert.deepEqual(parseDenyRules(undefined), [])
})

test('软屏蔽文案列出全部规则并说明原因', () => {
  const notice = softBanNotice(parseDenyRules(DEFAULT_DENY_RULES))
  assert.match(notice, /本轮不要使用的工具/)
  assert.match(notice, /mnemon_\*/)
  assert.match(notice, /working_directory/)
  assert.match(notice, /记忆只由 living_\* 管理/)
  assert.doesNotMatch(notice, /mcp__alxrun__\*/)
})

test('没有规则时不产生提示段（不做无谓的注入）', () => {
  assert.equal(softBanNotice([]), '')
  assert.equal(softBanNotice(parseDenyRules([])), '')
  assert.equal(softBanNotice(parseDenyRules([]).concat()), '')
})

test('默认规则覆盖 G-1 现场那几族', () => {
  const joined = DEFAULT_DENY_RULES.join(',')
  for (const need of ['mnemon_*', 'mcp__codebase__*', 'sidebar_open']) {
    assert.ok(joined.includes(need), need)
  }
  assert.equal(DEFAULT_DENY_RULES.length, 7)
})
