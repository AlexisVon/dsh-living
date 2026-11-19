import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const server = fileURLToPath(new URL('../mcp/server.js', import.meta.url))

test('MCP server 能 initialize 并列出十二个工具', async (t) => {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()

  lines.on('line', (line) => {
    const message = JSON.parse(line)
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  })

  const call = (id, method, params) =>
    new Promise((resolve) => {
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const init = await call(1, 'initialize', { protocolVersion: '2024-11-05' })
  assert.equal(init.result.serverInfo.name, 'dsh-gem-bili')
  const list = await call(2, 'tools/list', {})
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name).sort(),
    [
      'bili_comment_tree',
      'bili_comments',
      'bili_dm_history',
      'bili_dm_sessions',
      'bili_dynamics',
      'bili_notifications',
      'bili_owner',
      'bili_replies',
      'bili_search',
      'bili_subtitle',
      'bili_user',
      'bili_video',
    ],
  )
})
