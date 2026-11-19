/**
 * Outbound gate: private messages to whitelisted targets skip the rule table;
 * otherwise rule table → limiter (public/group) → whitelist. Every outbound
 * gets a pending record; only whitelisted targets may send silently.
 */

export const AUDIT_RULES = Object.freeze([
  {
    id: 'R-01',
    name: '泄露隐私',
    reason: '包含手机号、身份证号或凭证类内容',
    pattern: /(?:\+?86)?1[3-9]\d{9}|\b\d{17}[\dXx]\b|(?:密码|密钥|token|api[_-]?key)\s*[:=]/i,
  },
  {
    id: 'R-02',
    name: '替人承诺',
    reason: '包含保证、承诺或代表主人表态的词句',
    pattern: /(我保证|一定做到|包在我身上|我承诺|我代表|主人说|他同意)/,
  },
  {
    id: 'R-03',
    name: '公开立场',
    reason: '公开发言中出现立场或政治表态',
    pattern: /(政治|选举|立场|站队|支持哪一方)/,
    visibility: ['public', 'group'],
  },
  {
    id: 'R-04',
    name: '攻击性内容',
    reason: '包含侮辱、辱骂或攻击性表达',
    pattern: /(傻[逼比]|蠢货|滚开|闭嘴|垃圾东西|去死)/,
  },
  {
    id: 'R-05',
    name: '引流广告',
    reason: '包含引流、扫码或促销表达',
    pattern: /(扫码|加我微信|点击链接|私信我|下单|优惠|返利)/,
    visibility: ['public', 'group'],
  },
])

export const PENDING_STATES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  SENT: 'sent',
  BLOCKED: 'blocked',
})

const TRANSITIONS = Object.freeze({
  pending: ['approved', 'rejected', 'expired', 'blocked'],
  approved: ['sent', 'expired'],
  rejected: [],
  expired: [],
  sent: [],
  blocked: [],
})

export function checkRules(text, { visibility = 'private', rules = AUDIT_RULES } = {}) {
  const body = String(text ?? '')
  const hits = []
  for (const rule of rules) {
    if (rule.visibility && !rule.visibility.includes(visibility)) continue
    if (rule.pattern.test(body)) hits.push({ id: rule.id, name: rule.name, reason: rule.reason })
  }
  return hits
}

export function isWhitelisted({ target, gem, visibility }, whitelist = []) {
  return whitelist.some((entry) => {
    if (entry === '*') return true
    if (typeof entry === 'string') {
      if (entry === target) return true
      return entry.endsWith('*') && String(target ?? '').startsWith(entry.slice(0, -1))
    }
    if (!entry || typeof entry !== 'object') return false
    if (entry.gem && entry.gem !== gem) return false
    if (entry.visibility && entry.visibility !== visibility) return false
    if (entry.target === '*') return true
    if (entry.target === target) return true
    return typeof entry.target === 'string' && entry.target.endsWith('*') && String(target ?? '').startsWith(entry.target.slice(0, -1))
  })
}

/**
 * limiter: { pass: boolean, rule_id?, reason? } from the sub-agent gate.
 * A missing limiter verdict for public/group means "review", never "send".
 */
export function decideOutbound({
  text,
  gem = null,
  target = null,
  visibility = 'private',
  whitelist = [],
  limiter = null,
  rules = AUDIT_RULES,
} = {}) {
  const trusted = isWhitelisted({ target, gem, visibility }, whitelist)
  if (visibility === 'private' && trusted) {
    return {
      decision: 'allow',
      silent: true,
      ruleId: null,
      reason: '白名单直通',
      verdictSource: 'whitelist',
      hits: [],
      requiresLimiter: false,
    }
  }

  const hits = checkRules(text, { visibility, rules })
  if (hits.length) {
    return {
      decision: 'block',
      silent: false,
      ruleId: hits[0].id,
      reason: hits[0].reason,
      verdictSource: 'rule',
      hits,
      requiresLimiter: false,
    }
  }

  const forced = visibility === 'public' || visibility === 'group'
  if (forced) {
    if (!limiter) {
      return {
        decision: 'review',
        silent: false,
        ruleId: null,
        reason: '公开发言必须过限制层',
        verdictSource: 'limiter',
        hits,
        requiresLimiter: true,
      }
    }
    if (limiter.pass !== true) {
      return {
        decision: 'block',
        silent: false,
        ruleId: limiter.rule_id ?? 'R-00',
        reason: limiter.reason ?? '限制层未放行',
        verdictSource: 'limiter',
        hits,
        requiresLimiter: false,
      }
    }
  }

  if (trusted) {
    return {
      decision: 'allow',
      silent: true,
      ruleId: null,
      reason: '白名单直通',
      verdictSource: 'whitelist',
      hits,
      requiresLimiter: false,
    }
  }
  return {
    decision: 'review',
    silent: false,
    ruleId: null,
    reason: '非白名单外发需确认',
    verdictSource: 'whitelist',
    hits,
    requiresLimiter: false,
  }
}

/** Every outbound — including blocked ones — gets a record so the ledger is complete. */
export function createOutboundRecord({ id, gem, target, text, visibility, decision, now }) {
  if (typeof id !== 'string' || id === '') throw new RangeError('outbound.id 必填')
  if (!Number.isFinite(now)) throw new RangeError('outbound.now 必须是数字')
  const state =
    decision.decision === 'allow' ? PENDING_STATES.APPROVED : decision.decision === 'block' ? PENDING_STATES.BLOCKED : PENDING_STATES.PENDING
  return {
    id,
    gem,
    target,
    text,
    visibility,
    state,
    silent: decision.silent === true,
    ruleId: decision.ruleId ?? null,
    reason: decision.reason ?? null,
    createdAt: now,
    decidedAt: state === PENDING_STATES.PENDING ? null : now,
    decidedBy: state === PENDING_STATES.PENDING ? null : 'system',
  }
}

export function applyDecision(record, { action, at, by = 'user', reason = null } = {}) {
  if (!record || !TRANSITIONS[record.state]) throw new RangeError(`未知的外发状态: ${record?.state}`)
  if (!TRANSITIONS[record.state].includes(action)) {
    throw new RangeError(`非法状态迁移: ${record.state} → ${action}`)
  }
  if (!Number.isFinite(at)) throw new RangeError('decision.at 必须是数字')
  return { ...record, state: action, decidedAt: at, decidedBy: by, reason: reason ?? record.reason }
}

export function expirePending(record, now, ttlMs = 24 * 3600 * 1000) {
  if (record.state !== PENDING_STATES.PENDING && record.state !== PENDING_STATES.APPROVED) return record
  if (now - record.createdAt < ttlMs) return record
  return applyDecision(record, { action: PENDING_STATES.EXPIRED, at: now, by: 'system', reason: '超时未处理' })
}
