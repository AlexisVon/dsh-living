/**
 * Token and round budget. The day boundary is local time; time is injected.
 */

import { FAILURE_CODES } from 'dsh-living-protocol'
import { dayKey } from './clock.mjs'

export const BUDGET_DEFAULTS = Object.freeze({
  dailyTokens: 2_000_000,
  roundTokens: 700_000,
  dailyRounds: 96,
  tzOffsetMinutes: null,
})

export function createBudgetState(now, config = {}) {
  const cfg = resolveConfig(config)
  return { day: dayKey(now, cfg.tzOffsetMinutes), tokensUsed: 0, rounds: 0 }
}

export function rollDay(state, now, config = {}) {
  const cfg = resolveConfig(config)
  const day = dayKey(now, cfg.tzOffsetMinutes)
  if (state.day === day) return { ...state }
  return { day, tokensUsed: 0, rounds: 0 }
}

export function check(state, now, config = {}) {
  const cfg = resolveConfig(config)
  const s = rollDay(state, now, cfg)
  const tokensLeft = Math.max(0, cfg.dailyTokens - s.tokensUsed)
  const roundsLeft = Math.max(0, cfg.dailyRounds - s.rounds)
  if (s.tokensUsed >= cfg.dailyTokens) {
    return { ok: false, reason: FAILURE_CODES.BUDGET_EXHAUSTED, which: 'tokens', tokensLeft, roundsLeft, state: s }
  }
  if (s.rounds >= cfg.dailyRounds) {
    return { ok: false, reason: FAILURE_CODES.BUDGET_EXHAUSTED, which: 'rounds', tokensLeft, roundsLeft, state: s }
  }
  return { ok: true, reason: null, which: null, tokensLeft, roundsLeft, state: s }
}

export function startRound(state, now, config = {}) {
  const s = rollDay(state, now, config)
  s.rounds += 1
  return s
}

export function consume(state, now, tokens, config = {}) {
  if (!Number.isFinite(tokens) || tokens < 0) throw new RangeError(`tokens 必须是非负数: ${tokens}`)
  const s = rollDay(state, now, config)
  s.tokensUsed += tokens
  return s
}

function resolveConfig(config = {}) {
  const cfg = { ...BUDGET_DEFAULTS }
  for (const [k, v] of Object.entries(config)) if (v !== undefined) cfg[k] = v
  if (cfg.tzOffsetMinutes == null) cfg.tzOffsetMinutes = -new Date().getTimezoneOffset()
  if (!Number.isFinite(cfg.tzOffsetMinutes) || Math.abs(cfg.tzOffsetMinutes) > 840) {
    throw new RangeError(`tzOffsetMinutes 超出范围: ${cfg.tzOffsetMinutes}`)
  }
  if (!Number.isFinite(cfg.dailyTokens) || cfg.dailyTokens <= 0) throw new RangeError('dailyTokens 必须为正数')
  if (!Number.isFinite(cfg.roundTokens) || cfg.roundTokens <= 0) throw new RangeError('roundTokens 必须为正数')
  if (!Number.isInteger(cfg.dailyRounds) || cfg.dailyRounds < 0) throw new RangeError('dailyRounds 必须是非负整数')
  return cfg
}
