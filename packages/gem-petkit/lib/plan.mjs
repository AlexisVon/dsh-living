/** Weekly plan formatting plus today's meal lookup and skip/restore guards. */

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

// PetKit repeats: 1=Sunday … 7=Saturday; display in ISO order (Monday first).
const oemWeekdayToIso = (value) => (value === 1 ? 7 : value - 1)

export function formatPlan(plan) {
  const days = Array.isArray(plan?.feedDailyList) ? plan.feedDailyList : []
  const schedule = (items) => (items ?? [])
    .slice()
    .sort((a, b) => Number(a.time) - Number(b.time))
    .map((item) => `${formatClock(item.time)} ${item.amount}g${item.name ? ` ${item.name}` : ''}`)
    .join(' / ')
  if (days.length === 0) {
    if (Array.isArray(plan?.items) && plan.items.length > 0) return `每周：${schedule(plan.items)}（suspended=${plan.suspended ?? 0}）`
    return '没有读到喂食计划。'
  }
  const signature = (day) => JSON.stringify({ suspended: day.suspended, items: day.items })
  const groups = []
  for (const day of days) {
    const key = signature(day)
    const found = groups.find((group) => group.key === key)
    if (found) found.days.push(Number(day.repeats))
    else groups.push({ key, days: [Number(day.repeats)], day })
  }
  const weekday = ['', '一', '二', '三', '四', '五', '六', '日']
  const lines = []
  for (const group of groups) {
    const isoDays = group.days.map(oemWeekdayToIso).sort((a, b) => a - b)
    const label = isoDays.length === 7
      ? '每天'
      : `周${isoDays.map((value) => weekday[value] ?? value).join('、')}`
    lines.push(`${label}${Number(group.day.suspended) === 1 ? '（已暂停）' : ''}：${schedule(group.day.items)}`)
  }
  lines.push('周计划不代表今天实际：一天的停喂与已出看 petkit_status。')
  return lines.join('\n')
}
