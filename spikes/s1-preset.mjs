/**
 * S1 probe: does mounting a preset in the agent's setup scope pin its tool surface?
 *
 * `meta.agentPreset` alone only records the header; the agent's setup callback
 * must call `agentPresets.mount(agentCtx, id)`.
 *
 * Load this module as a plugin in a throwaway profile, then read the [S1] lines.
 *
 * GO  : the scoped tools service does not expose bash/pwsh/fs tools.
 * NO-GO: global tools leak into the preset → fall back to one subprocess per round.
 */

export const name = 's1-probe'
export const inject = ['agents', 'agentPresets']

export async function apply(ctx) {
  const dispose = await ctx.agentPresets.register({
    id: 's1-probe',
    name: 'S1 probe',
    description: 'Throwaway preset with no tools',
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'S1 probe agent.' } },
    ],
  })

  const handle = await ctx.agents.create({
    sessionId: `s1_${Date.now().toString(36)}`,
    meta: { cwd: process.cwd(), agentPreset: 's1-probe' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 's1-probe')
    },
  })

  try {
    const tools = ctx.agentPresets.serviceFor(handle.agent, 'tools')
    const names = tools ? tools.schemas(handle.agent).map((schema) => schema.name) : []
    const dangerous = names.filter((tool) => ['bash', 'pwsh', 'fs_write', 'apply_patch'].includes(tool))
    console.log(`[S1] visible tools: ${names.join(', ') || '(none)'}`)
    console.log(`[S1] dangerous: ${dangerous.join(', ') || '(none)'}`)
    console.log(dangerous.length === 0 ? '[S1] GO: preset 钉死了工具面' : '[S1] NO-GO: 全局工具泄漏进 preset')
  } finally {
    await handle.dispose()
    await dispose()
  }
}
