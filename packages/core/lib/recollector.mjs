/** One-shot recollect subagent: only the memory tools, hard timeout, no writes. */

import { randomUUID } from 'node:crypto'
import { waitForTurn } from './round.mjs'
import { registerMemoryTools, restrictToMemoryTools } from './memory-tools.mjs'

export function createRecollector(ctx, {
  workspace,
  presetId,
  living,
  timeoutMs = 120_000,
  logger = console,
  archive = async () => {},
} = {}) {
  return async function recollect({ prompt, context, timeoutMs: callTimeoutMs = timeoutMs }) {
    const selection = ctx.agentDefaultModel.currentSelection()
    const sessionId = `living_recollect_${randomUUID()}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('recollect_timeout')), callTimeoutMs)
    timer.unref?.()
    let handle = null
    let onAbort = null
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
        setup: async (agentCtx) => {
          await ctx.agentPresets.mount(agentCtx, presetId)
          registerMemoryTools(agentCtx, living, { context, internal: true })
          restrictToMemoryTools(agentCtx, '回想器')
        },
      })
      const done = waitForTurn(handle.agent, controller.signal, { contextGuardTokens: 0 })
      onAbort = () => handle.agent.cancel({ kind: 'hook', reason: 'recollect_timeout' })
      controller.signal.addEventListener('abort', onAbort, { once: true })
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
      const result = await done
      return { ...result, sessionId }
    } catch (error) {
      logger.warn?.(`living: 回想子 agent 失败: ${error.message}`)
      throw error
    } finally {
      clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      try {
        await handle?.dispose()
      } finally {
        await archive(sessionId)
      }
    }
  }
}
