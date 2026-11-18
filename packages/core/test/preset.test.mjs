import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LIVING_TOOL_PLUGINS } from '../index.js'

test('living preset 打开 fs / fs-search / web 工具组', () => {
  const byName = new Map(LIVING_TOOL_PLUGINS.map((plugin) => [plugin.name, plugin]))
  assert.deepEqual([...byName.keys()], [
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-web',
  ])
  assert.equal(byName.get('@deepseek-ai/dsh-tool-fs').config.applyPatch, false)
  assert.equal(byName.get('@deepseek-ai/dsh-tool-web').config.fetch, true)
})

test('living preset 不打开 shell、子代理或工作流', () => {
  const names = LIVING_TOOL_PLUGINS.map((plugin) => plugin.name).join(' ')
  assert.ok(!/tool-bash|tool-pwsh|tool-subagent|workflow/.test(names))
})
