#!/usr/bin/env node
/**
 * Reference outbox poller. A gem runs this wherever it lives and pulls work
 * from the core; the core never needs to reach the gem.
 *
 * Env: LIVING_BASE_URL, LIVING_GEM_ID, LIVING_GEM_TOKEN
 */

const base = process.env.LIVING_BASE_URL ?? 'http://127.0.0.1:3000'
const gem = process.env.LIVING_GEM_ID ?? 'example'
const token = process.env.LIVING_GEM_TOKEN
const intervalMs = Number(process.env.LIVING_POLL_MS) || 5000

if (!token) {
  console.error('LIVING_GEM_TOKEN is required')
  process.exit(2)
}

const headers = { 'x-living-token': token }

async function ack(id, body) {
  await fetch(`${base}/living/outbox/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function once() {
  const response = await fetch(`${base}/living/outbox?gem=${encodeURIComponent(gem)}&limit=20`, { headers })
  if (!response.ok) throw new Error(`outbox ${response.status}`)
  const items = await response.json()
  for (const item of items) {
    try {
      console.log(`[example] would send to ${item.to}: ${item.text}`)
      await ack(item.id, { ok: true, external_id: `example_${item.id}` })
    } catch (error) {
      await ack(item.id, { ok: false, code: 'provider_timeout' })
      console.error(`ack failed: ${error.message}`)
    }
  }
}

for (;;) {
  try {
    await once()
  } catch (error) {
    console.error(`poll failed: ${error.message}`)
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
}
