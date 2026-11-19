#!/usr/bin/env node
import { PetkitClient } from './client.mjs'

const amount = Number(process.argv[2])
if (!process.argv.includes('--yes')) {
  console.log('出粮是物理动作：确认后加 --yes')
  process.exit(1)
}
if (![10, 20, 30, 40, 50].includes(amount)) {
  console.log('D4H 只接受 10/20/30/40/50')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const client = new PetkitClient({ log: process.env.PETKIT_DEBUG === '1' ? (line) => console.error(line) : () => {} })
const device = client.loadDevices().find((item) => item.id === client.loadSelected())
if (!device) {
  console.log('没有选中设备；先运行 devices')
  process.exit(1)
}

function snapshot(detail) {
  const state = detail?.state ?? {}
  const feed = state.feedState ?? {}
  return {
    feeding: state.feeding,
    errorCode: state.errorCode,
    overall: state.overall,
    food: state.food,
    desiccantLeftDays: state.desiccantLeftDays,
    addAmountTotal: feed.addAmountTotal,
    realAmountTotal: feed.realAmountTotal,
    planRealAmountTotal: feed.planRealAmountTotal,
    times: feed.times,
  }
}

const t0 = Date.now()
const before = snapshot(await client.detail(device))
console.log('baseline', JSON.stringify(before))

const sendAt = Date.now()
const response = await client.manualFeed(device, amount)
console.log(`submit: ${Date.now() - sendAt}ms`, JSON.stringify(response))

let confirmed = false
for (let i = 0; i < 12; i += 1) {
  await sleep(2500)
  let detail
  try {
    detail = await client.detail(device)
  } catch (error) {
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s poll error: ${error.message}`)
    continue
  }
  const now = snapshot(detail)
  console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(now))
  const delta = (now.addAmountTotal ?? 0) - (before.addAmountTotal ?? 0)
  if (delta >= amount) {
    confirmed = true
    console.log(`CONFIRMED manual delta=${delta}`)
    break
  }
  if (now.errorCode) {
    console.log(`DEVICE_ERROR ${now.errorCode}`)
    break
  }
}

const final = snapshot(await client.detail(device))
console.log('final', JSON.stringify(final))
const records = await client.records(device)
const feedItems = (records.feed ?? []).flatMap((group) => group.items ?? [])
const manual = feedItems
  .filter((item) => item.src === 3)
  .map((item) => ({
    id: item.id,
    time: item.time,
    amount: item.amount,
    eventId: item.eventId,
    completedAt: item.completedAt,
    state: item.state,
  }))
console.log('manual feed records:', JSON.stringify(manual, null, 2))
console.log(confirmed ? 'RESULT=confirmed' : 'RESULT=unknown')
