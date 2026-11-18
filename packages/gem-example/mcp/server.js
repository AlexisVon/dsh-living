#!/usr/bin/env node
/**
 * Minimal MCP server over stdio: enough shape for a gem that ships no tools.
 * Copy this file and add tools/list + tools/call entries for a real gem.
 */

import { createInterface } from 'node:readline'

const NAME = 'dsh-gem-example'
const VERSION = '0.0.0'
const PROTOCOL = '2024-11-05'

function reply(id, result) {
  if (id === undefined) return
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail(id, code, message) {
  if (id === undefined) return
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return fail(undefined, -32700, 'parse error')
  }
  const { id, method, params } = message

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    })
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: [] })
  if (method === 'tools/call') return fail(id, -32601, '示例宝石没有工具')
  if (id !== undefined) fail(id, -32601, `unknown method: ${method}`)
})

rl.on('close', () => process.exit(0))
process.stderr.write(`${NAME} MCP ready (no tools)\n`)
