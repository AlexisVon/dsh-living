import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIT_RULES,
  PENDING_STATES,
  checkRules,
  isWhitelisted,
  decideOutbound,
  createOutboundRecord,
  applyDecision,
  expirePending,
} from '../lib/audit.mjs'

const NOW = Date.UTC(2026, 10, 17, 12)

test('规则表可枚举：R-01…R-05', () => {
  assert.deepEqual(AUDIT_RULES.map((r) => r.id), ['R-01', 'R-02', 'R-03', 'R-04', 'R-05'])
})

test('R-01/R-02 对非白名单私聊生效；白名单私聊整表跳过', () => {
  const phone = '我的手机 13800138000'
  const promise = '我保证明天给你'
  assert.equal(checkRules(phone, { visibility: 'private' })[0].id, 'R-01')
  assert.equal(checkRules(promise, { visibility: 'private' })[0].id, 'R-02')

  const blocked = decideOutbound({ text: phone, target: 'uid_9', visibility: 'private', whitelist: [] })
  assert.equal(blocked.decision, 'block')
  assert.equal(blocked.ruleId, 'R-01')

  const direct = decideOutbound({ text: phone, target: 'uid_9', visibility: 'private', whitelist: ['uid_9'] })
  assert.equal(direct.decision, 'allow')
  assert.equal(direct.silent, true)
})

test('白名单只对私聊跳过规则表；公开/群仍按规则表', () => {
  const pub = decideOutbound({ text: '我的手机 13800138000', target: 'uid_9', visibility: 'public', whitelist: ['uid_9'] })
  assert.equal(pub.decision, 'block')
  assert.equal(pub.ruleId, 'R-01')

  const group = decideOutbound({ text: '扫码加我微信', target: 'uid_9', visibility: 'group', whitelist: ['uid_9'] })
  assert.equal(group.decision, 'block')
  assert.equal(group.ruleId, 'R-05')
})

test('R-03/R-05 只拦公开发言', () => {
  assert.equal(checkRules('我的立场是支持', { visibility: 'private' }).length, 0)
  assert.equal(checkRules('我的立场是支持', { visibility: 'public' })[0].id, 'R-03')
  assert.equal(checkRules('扫码加我微信', { visibility: 'group' })[0].id, 'R-05')
})

test('白名单：精确、通配、对象形式', () => {
  assert.equal(isWhitelisted({ target: 'uid_9' }, ['uid_9']), true)
  assert.equal(isWhitelisted({ target: 'uid_9' }, ['uid_*']), true)
  assert.equal(isWhitelisted({ target: 'uid_9', gem: 'bili' }, [{ gem: 'bili', target: 'uid_9' }]), true)
  assert.equal(isWhitelisted({ target: 'uid_9', gem: 'wechat' }, [{ gem: 'bili', target: 'uid_9' }]), false)
  assert.equal(isWhitelisted({ target: 'x' }, ['*']), true)
})

test('私聊非白名单 → 待确认；白名单 → 静默放行', () => {
  const review = decideOutbound({ text: '在吗', target: 'uid_9', visibility: 'private', whitelist: [] })
  assert.equal(review.decision, 'review')

  const allow = decideOutbound({ text: '在吗', target: 'uid_9', visibility: 'private', whitelist: ['uid_9'] })
  assert.equal(allow.decision, 'allow')
  assert.equal(allow.silent, true)
})

test('公开发言必须过限制层，缺失即待确认（不得直发）', () => {
  const noLimiter = decideOutbound({ text: '今天天气不错', visibility: 'public', whitelist: ['uid_9'] })
  assert.equal(noLimiter.decision, 'review')
  assert.equal(noLimiter.requiresLimiter, true)
  assert.equal(noLimiter.verdictSource, 'limiter')

  const passed = decideOutbound({
    text: '今天天气不错',
    visibility: 'public',
    target: 'uid_9',
    whitelist: ['uid_9'],
    limiter: { pass: true },
  })
  assert.equal(passed.decision, 'allow')
  assert.equal(passed.verdictSource, 'whitelist')

  const failed = decideOutbound({
    text: '今天天气不错',
    visibility: 'public',
    limiter: { pass: false, rule_id: 'R-06', reason: '不合适' },
  })
  assert.equal(failed.decision, 'block')
  assert.equal(failed.ruleId, 'R-06')
  assert.equal(failed.verdictSource, 'limiter')

  const rule = decideOutbound({ text: '扫码领优惠', visibility: 'public' })
  assert.equal(rule.verdictSource, 'rule')
})

test('规则命中零成本直接拒', () => {
  const r = decideOutbound({ text: '扫码领优惠', visibility: 'public' })
  assert.equal(r.decision, 'block')
  assert.equal(r.ruleId, 'R-05')
})

test('每次外发都有记录：allow→approved，review→pending，block→blocked', () => {
  const base = { id: 'o1', gem: 'bili', target: 'u', text: 'x', visibility: 'private', now: NOW }
  assert.equal(createOutboundRecord({ ...base, decision: { decision: 'allow', silent: true } }).state, PENDING_STATES.APPROVED)
  assert.equal(createOutboundRecord({ ...base, decision: { decision: 'review' } }).state, PENDING_STATES.PENDING)
  const blocked = createOutboundRecord({ ...base, decision: { decision: 'block', ruleId: 'R-01', reason: '隐私' } })
  assert.equal(blocked.state, PENDING_STATES.BLOCKED)
  assert.equal(blocked.ruleId, 'R-01')
})

test('状态机只允许合法迁移，非法迁移大声失败', () => {
  let record = { id: 'o1', state: 'pending', createdAt: NOW, reason: null }
  record = applyDecision(record, { action: 'approved', at: NOW })
  record = applyDecision(record, { action: 'sent', at: NOW + 1 })
  assert.equal(record.state, 'sent')
  assert.throws(() => applyDecision(record, { action: 'approved', at: NOW }), RangeError)
  assert.throws(() => applyDecision({ state: 'pending' }, { action: 'sent', at: NOW }), RangeError)
})

test('待确认超时自动过期', () => {
  const record = { id: 'o1', state: 'pending', createdAt: NOW }
  assert.equal(expirePending(record, NOW + 1000).state, 'pending')
  assert.equal(expirePending(record, NOW + 25 * 3600 * 1000).state, 'expired')
})
