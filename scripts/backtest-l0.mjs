#!/usr/bin/env node
/**
 * L0 backtest diagnostic. Usage: node scripts/backtest-l0.mjs <life.db> [days]
 *
 * The real "injection hit rate" needs access logs (inject/cite). Until the
 * runtime records them, this prints channel distribution and token usage per day.
 */

import { createStore } from '../packages/core/lib/store.mjs'
import { collectMemoryItems, selectL0 } from '../packages/core/lib/memory.mjs'

const [dbPath, daysArg] = process.argv.slice(2)
if (!dbPath) {
  console.error('usage: node scripts/backtest-l0.mjs <life.db> [days]')
  process.exit(2)
}

const days = Number(daysArg) > 0 ? Number(daysArg) : 7
const DAY = 86400000
const now = Date.now()
const store = createStore({ path: dbPath })

try {
  const since = now - days * DAY
  const events = store.listEvents({ since, limit: 100000 })
  const items = collectMemoryItems(store, { now, since: since - 30 * DAY, limit: 100000 })
  const byDay = new Map()
  for (const event of events) {
    const day = new Date(event.ts).toISOString().slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(event)
  }

  const rows = []
  for (const [day, dayEvents] of [...byDay.entries()].sort()) {
    const dayEnd = dayEvents[dayEvents.length - 1].ts
    const visible = items.filter((item) => (item.ts ?? 0) <= dayEnd)
    const cue = { text: dayEvents.slice(0, 3).map((event) => event.payload?.text ?? '').join(' ') }
    const l0 = selectL0({ items: visible, cue, budgetTokens: 3000, now: dayEnd })
    const channels = {}
    for (const entry of l0.recall.recalled) {
      for (const why of entry.why) {
        const id = why.split(':')[0]
        channels[id] = (channels[id] ?? 0) + 1
      }
    }
    rows.push({
      day,
      events: dayEvents.length,
      candidates: visible.length,
      injected: l0.entries.length,
      tokens: l0.tokens,
      cold: l0.coldCount,
      channels,
    })
  }

  console.log(JSON.stringify({ days, rows }, null, 2))
} finally {
  await store.close()
}
