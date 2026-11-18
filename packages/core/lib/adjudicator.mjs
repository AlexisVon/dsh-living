/** One-shot, tool-free model call for public outbound adjudication. */

import { randomUUID } from 'node:crypto'
import { LIMITER_MAX_TOKENS, LIMITER_TIMEOUT_MS, buildLimiterPrompt, parseLimiterVerdict } from './limiter.mjs'
import { waitForTurn } from './round.mjs'

export function createAdjudicator(ctx, { home, workspace = home, presetId, logger = console, archive = async () => {}, setup = null } = {}) {
  return async function adjudicate({ text, gem, target, visibility }) {
    const selection = ctx.agentDefaultModel.currentSelection()
    const sessionId = `living_adjudicate_${randomUUID()}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('limiter_timeout')), LIMITER_TIMEOUT_MS)
    timer.unref?.()
    let handle = null
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: workspace, agentPreset: presetId },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        },
        signal: controller.signal,
        ...(setup ? { setup } : {}),
      })
      const done = waitForTurn(handle.agent, controller.signal, { contextGuardTokens: LIMITER_MAX_TOKENS })
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: buildLimiterPrompt({ text, gem, target, visibility }) }],
        source: { kind: 'user' },
      })
      const result = await done
      if (result.outcome !== 'ok') {
        logger.warn?.(`living: 限制层结果 ${result.outcome}（${result.errorCode ?? 'unknown'}），按待审处理`)
        return null
      }
      const verdict = parseLimiterVerdict(result.text)
      if (!verdict) logger.warn?.('living: 限制层输出无法解析，按待审处理')
      return verdict
    } catch (error) {
      logger.warn?.(`living: 限制层调用失败，按待审处理: ${error.message}`)
      return null
    } finally {
      clearTimeout(timer)
      try {
        await handle?.dispose()
      } finally {
        await archive(sessionId)
      }
    }
  }
}
