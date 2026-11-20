/** Today's meal lookup and skip/restore guards; the weekly plan itself is read-only here. */

const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/u

export function parseClock(value) {
  const match = CLOCK_RE.exec(String(value ?? '').trim())
  if (!match) throw new RangeError(`时间必须是 HH:MM（24 小时制），收到 ${value}`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60
}

export function formatClock(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return '--:--'
  return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}`
}

export function findMeal(records, feedTime) {
  const items = (Array.isArray(records?.feed) ? records.feed : []).flatMap((group) => group.items ?? [])
  const id = `s${feedTime}`
  return items.find((item) => item.id === id)
    ?? items.find((item) => Number(item.src) === 1 && Number(item.time) === feedTime)
    ?? null
}

export function summarizeMeal(item) {
  return `${formatClock(item.time)}${item.name ? ` ${item.name}` : ''} ${item.amount ?? '?'}g（记录 ${item.id}）`
}

/** Returns the reason an action is not allowed, or null. */
export function mealActionIssue({ item, feedTime, nowSeconds, action }) {
  const status = Number(item.status ?? 0)
  if (action === 'skip') {
    if (status === 1) return 'already_skipped'
    if (item.state) return 'already_executed'
    if (feedTime <= nowSeconds) return 'time_passed'
    return null
  }
  if (status !== 1) return 'not_skipped'
  if (feedTime <= nowSeconds) return 'time_passed'
  return null
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForMealStatus({
  fetchRecords,
  feedTime,
  expectStatus,
  timeoutMs = 4000,
  intervalMs = 1000,
  sleep = defaultSleep,
  now = Date.now,
}) {
  const deadline = now() + timeoutMs
  let last = null
  for (;;) {
    const records = await fetchRecords()
    last = findMeal(records, feedTime)
    if (last !== null && Number(last.status ?? 0) === expectStatus) return { verified: true, item: last }
    if (now() >= deadline) return { verified: false, item: last }
    await sleep(intervalMs)
  }
}
