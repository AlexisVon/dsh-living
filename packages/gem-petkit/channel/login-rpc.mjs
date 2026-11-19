#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { gemHome, loadConfig } from '../lib/config.mjs'
import { runLogin } from '../lib/login.mjs'

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const rl = createInterface({ input: process.stdin })
const pending = new Map()

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.type !== 'input' || !pending.has(message.id)) return
  const resolve = pending.get(message.id)
  pending.delete(message.id)
  resolve(String(message.value ?? ''))
})

const prompt = (id) => new Promise((resolve) => pending.set(id, resolve))

try {
  await runLogin({ prompt, emit, home: gemHome(), config: loadConfig() })
  setTimeout(() => process.exit(0), 50)
} catch (error) {
  emit({ type: 'error', message: error.message })
  setTimeout(() => process.exit(1), 50)
}
