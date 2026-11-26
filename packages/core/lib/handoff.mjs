/** One-shot external handoff compression for unexpected session rotation. */

import { randomUUID } from 'node:crypto'
import { waitForTurn } from './round.mjs'

export const HANDOFF_PRESET_PLUGINS = Object.freeze([
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix: '你是交接压缩器。只输出交接正文，不调用工具，不写记忆，不编造。' },
  },
])

const MAX_PROMPT_CHARS = 60_000
const MAX_MESSAGES = 120
const MAX_HANDOFF_CHARS = 2_000

export function buildHandoffPrompt({ raw = null, notes = '', reason = null } = {}) {
  const messages = raw?.payload?.messages ?? []
  const lines = []
  for (const message of messages.slice(-MAX_MESSAGES)) {
    const text = String(message?.text ?? '').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const who = message.role === 'user'
      ? '主人/用户'
      : message.role === 'assistant'
        ? '我'
        : message.role === 'event'
          ? '事件'
          : message.role === 'tool_call'
            ? `工具调用 ${message.name ?? ''}`
            : '工具结果'
    lines.push(`[${who}] ${text}`)
  }
  let tail = lines.join('\n')
  if (tail.length > MAX_PROMPT_CHARS) tail = tail.slice(-MAX_PROMPT_CHARS)
  return [
    '你是交接压缩器。把下面的会话尾部压缩成给「下一个自己」的交接，最多 800 字。只写：',
    '- 正在做什么（当前任务/话题）',
    '- 已经决定了什么',
    '- 哪些没完成、下一步是什么',
    '- 必须记住的主人约束/纠正，特别是与当前任务相关的持久/临时笔记',
    '不要写人格、记忆、流水账；不要编造；不要调用工具；只输出交接正文。',
    reason ? `\n触发原因：${reason}` : '',
    notes ? `\n## 当前笔记\n\n${notes}` : '',
    `\n## 会话尾部\n\n${tail}`,
  ].filter(Boolean).join('\n')
}

export function tailFromRaw(raw, { maxMessages = 8, maxChars = 2_000 } = {}) {
  const messages = (raw?.payload?.messages ?? [])
    .filter((message) => ['user', 'assistant', 'event'].includes(message?.role) && String(message?.text ?? '').trim() !== '')
  const lines = messages.slice(-maxMessages).map((message) => {
    const who = message.role === 'user' ? '主人/用户' : message.role === 'assistant' ? '我' : '事件'
    return `${who}：${String(message.text).replace(/\s+/g, ' ').trim()}`
  })
  const text = lines.join('\n')
  return text.length > maxChars ? text.slice(-maxChars) : text
}

export function clipHandoffText(text) {
  return String(text ?? '').trim().slice(0, MAX_HANDOFF_CHARS)
}

export function createHandoffCompressor(ctx, { workspace, presetId, setup = null, logger = console, archive = async () => {}, timeoutMs = 60_000 } = {}) {
  return async function compressHandoff({ prompt }) {
    const selection = ctx.agentDefaultModel.currentSelection()
    const sessionId = `living_handoff_${randomUUID()}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('handoff_timeout')), timeoutMs)
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
      const done = waitForTurn(handle.agent, controller.signal, { contextGuardTokens: 0 })
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
      const result = await done
      const text = String(result.text ?? '').trim()
      if (result.outcome !== 'ok' || text === '') {
        return { ok: false, error: result.errorCode ?? 'empty', tokens: result.tokens ?? 0 }
      }
      return { ok: true, text: clipHandoffText(text), tokens: result.tokens ?? 0, contextTokens: result.contextTokens ?? 0, sessionId }
    } catch (error) {
      logger.warn?.(`living: 交接压缩失败: ${error.message}`)
      return { ok: false, error: error.message, tokens: 0 }
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
