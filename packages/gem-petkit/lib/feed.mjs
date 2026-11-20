import { MANUAL_FEED_VALUES } from './config.mjs'
import { todayIn } from './client.mjs'
import { PetkitError, isAuthError } from './errors.mjs'
import { errorCodeKey } from './events.mjs'

const PENDING_MS = 60_000
const POLL_MS = 2000
const MAX_FEED_LOG = 200

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function failed(code, message) {
  return { status: 'failed', code, message }
}

function rejected(message) {
  return { status: 'rejected', message }
}

function totals(detail) {
  const feed = detail?.state?.feedState ?? {}
  return {
    manual: Number(feed.addAmountTotal ?? 0),
    real: Number(feed.realAmountTotal ?? 0),
    errorCode: errorCodeKey(detail?.state?.errorCode),
    feeding: Number(detail?.state?.feeding ?? 0),
  }
}

/** Submit a manual feed, then verify it physically completed. Never retries after submission. */
export async function feedWithVerification({
  client,
  device,
  amount,
  config = {},
  state = {},
  day: dayParam,
  onSubmitted,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const grams = Number(amount)
  if (!MANUAL_FEED_VALUES.includes(grams)) {
    return rejected(`出粮量只能是 ${MANUAL_FEED_VALUES.join(' / ')}，收到 ${amount}`)
  }
  const maxPortion = Number(config.maxPortion ?? 50)
  if (grams > maxPortion) return rejected(`超过单次上限 ${maxPortion} 克`)

  const pendingAt = Number(state.pendingFeedAt ?? 0)
  if (pendingAt > 0 && now() - pendingAt < PENDING_MS) {
    return rejected('上一次出粮尚未确认，60 秒内不重复出粮')
  }

  const day = dayParam ?? todayIn(config.timezone)
  const gemFeeds = Array.isArray(state.gemFeeds) ? state.gemFeeds : (state.gemFeeds = [])
  const gemToday = gemFeeds
    .filter((entry) => entry.day === day)
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0)
  const dailyCap = Number(config.dailyFeedCap ?? 200)
  if (gemToday + grams > dailyCap) {
    return rejected(`宝石今日已出 ${gemToday} 克，手动日上限 ${dailyCap} 克`)
  }

  let before
  try {
    before = totals(await client.detail(device))
  } catch (error) {
    if (isAuthError(error)) return failed('gem_cookie_expired', '小佩登录态失效，先重新登录')
    return failed('unknown', `读取状态失败：${error.message}`)
  }

  function track(status, recordId) {
    const entry = { day, at: now(), amount: grams, recordId: recordId ?? null, status }
    gemFeeds.push(entry)
    if (gemFeeds.length > MAX_FEED_LOG) gemFeeds.splice(0, gemFeeds.length - MAX_FEED_LOG)
    onSubmitted?.(entry)
    return entry
  }

  let submission
  const submitAt = now()
  try {
    submission = await client.manualFeed(device, grams)
  } catch (error) {
    if (isAuthError(error)) return failed('gem_cookie_expired', '小佩登录态失效，未确认是否已出粮；不要重试')
    if (error instanceof PetkitError) return failed('provider_rejected', `小佩拒绝了出粮请求：${error.message}`)
    track('unknown', null)
    state.pendingFeedAt = now()
    return {
      status: 'unknown',
      amount: grams,
      submitMs: now() - submitAt,
      message: `出粮请求结果未知（${error.message}）；不要重试`,
    }
  }
  const submitMs = now() - submitAt
  const entry = track('submitted', submission?.id ?? null)

  const verifyMs = Math.max(0, Number(config.feedVerifySeconds ?? 15)) * 1000
  if (verifyMs === 0) {
    entry.status = 'unknown'
    state.pendingFeedAt = now()
    return {
      status: 'unknown',
      amount: grams,
      submitMs,
      recordId: submission?.id ?? null,
      message: '出粮请求已提交，未等待确认；不要重试，稍后用 petkit_history 查',
    }
  }

  const deadline = now() + verifyMs
  let last = null
  let manualAfter = before.manual
  let realAfter = before.real
  while (now() < deadline) {
    const wait = Math.min(POLL_MS, Math.max(0, deadline - now()))
    await sleep(wait)
    try {
      last = totals(await client.detail(device))
    } catch (error) {
      if (isAuthError(error)) {
        entry.status = 'unknown'
        state.pendingFeedAt = now()
        return {
          status: 'unknown',
          amount: grams,
          submitMs,
          recordId: submission?.id ?? null,
          message: '确认过程中登录态失效，无法判断是否已出粮；不要重试',
        }
      }
      continue
    }
    manualAfter = last.manual
    realAfter = last.real
    if (last.errorCode !== '0') {
      entry.status = 'failed'
      state.pendingFeedAt = 0
      return {
        status: 'failed',
        amount: grams,
        code: 'device_error',
        message: `设备报错（错误码 ${last.errorCode}）`,
        evidence: { manualBefore: before.manual, manualAfter, realBefore: before.real, realAfter },
      }
    }
    if (realAfter - before.real >= grams) {
      entry.status = 'dispensed'
      state.pendingFeedAt = 0
      return {
        status: 'dispensed',
        amount: grams,
        verified: true,
        submitMs,
        recordId: submission?.id ?? null,
        evidence: { manualBefore: before.manual, manualAfter, realBefore: before.real, realAfter },
      }
    }
  }

  entry.status = 'unknown'
  state.pendingFeedAt = now()
  return {
    status: 'unknown',
    amount: grams,
    submitMs,
    recordId: submission?.id ?? null,
    message: `出粮请求已提交，${verifyMs / 1000} 秒内未确认；不要重试，稍后用 petkit_history 查`,
    evidence: { manualBefore: before.manual, manualAfter, realBefore: before.real, realAfter },
  }
}
