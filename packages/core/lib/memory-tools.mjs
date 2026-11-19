/** Shared read-only memory tools; only the recollect subagent registers them. */

import { findScope } from './host-scope.mjs'
import { MEMORY_TOOL_NAMES, RECOLLECT_SOURCES } from './recollect.mjs'

export function registerMemoryTools(ctx, living, { context = null, internal = false } = {}) {
  const scanNote = internal
    ? 'Read memory rows newest-first within a predicted segment. Pass from/to; use `before` only as an inner cursor. This is not semantic search.'
    : 'Read memory rows newest-first for evidence checks. Prefer living_recollect for answers; this is the direct path.'

  ctx.tools.register(tool({
    name: 'living_memory_segments',
    description: 'Predict up to three narrow time segments for a question key. Returns from/to/label/confidence; may return fewer or none when embedding is unavailable or confidence is too low.',
    parameters: objectSchema({
      key: { type: 'string', description: 'Question plus optional cue; natural language.' },
    }, ['key']),
    run: async (args) => JSON.stringify(await living.memorySegments(args ?? {}, context)),
  }))

  ctx.tools.register(tool({
    name: 'living_memory_overview',
    description: 'Read memory counts and time ranges. Use it to decide how far back to scan.',
    parameters: objectSchema({}),
    run: () => JSON.stringify(living.memoryOverview()),
  }))

  ctx.tools.register(tool({
    name: 'living_memory_scan',
    description: scanNote,
    parameters: objectSchema({
      sources: {
        type: 'array',
        description: 'Sources to scan. Defaults to all three.',
        items: { type: 'string', enum: [...RECOLLECT_SOURCES] },
      },
      from: { type: 'number', description: 'Epoch milliseconds lower bound, inclusive. Use a predicted segment from.' },
      to: { type: 'number', description: 'Epoch milliseconds upper bound, inclusive. Use a predicted segment to.' },
      before: { type: 'number', description: 'Epoch milliseconds cursor; returns rows with ts < before. Defaults to to + 1.' },
      limit: { type: 'number', description: 'Rows per scan; default 40, hard cap 100.' },
    }),
    run: (args) => JSON.stringify(living.memoryScan(args ?? {}, context)),
  }))

  ctx.tools.register(tool({
    name: 'living_memory_get',
    description: 'Expand one memory row with neighbors. raw=true expands rawRefs into user/assistant/event text only; no reasoning or tool output.',
    parameters: objectSchema({
      source: { type: 'string', enum: [...RECOLLECT_SOURCES] },
      id: { type: 'string' },
      raw: { type: 'boolean', description: 'Expand rawRefs. Only honored when the recollect detail is full (or by the main agent directly).' },
    }, ['source', 'id']),
    run: (args) => JSON.stringify(living.memoryGet(args ?? {}, context)),
  }))
}

/** Structural guard: the recollect subagent sees exactly the memory tools and nothing else. */
export function restrictToMemoryTools(agentCtx, label = '回想器') {
  const tools = agentCtx.get?.('tools') ?? agentCtx.tools
  const scope = findScope(agentCtx)
  if (!tools || scope === undefined) throw new Error(`${label}拿不到工具面`)
  const names = tools.definitions(scope).map((definition) => definition.name)
  const deny = names.filter((name) => !MEMORY_TOOL_NAMES.includes(name))
  if (deny.length > 0) tools.restrict({ deny })
  const after = tools.definitions(scope).map((definition) => definition.name)
  const missing = MEMORY_TOOL_NAMES.filter((name) => !after.includes(name))
  if (missing.length > 0) throw new Error(`${label}缺少记忆工具: ${missing.join(', ')}`)
  const extra = after.filter((name) => !MEMORY_TOOL_NAMES.includes(name))
  if (extra.length > 0) throw new Error(`${label}仍可见其他工具: ${extra.join(', ')}`)
  if (deny.length > 0) console.log(`living: ${label}工具面已收口（deny ${deny.length}）`)
  return after
}

function tool({ name, description, parameters = objectSchema({}), run }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      return { text: await run(args ?? {}) }
    },
  }
}

function objectSchema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }
}
