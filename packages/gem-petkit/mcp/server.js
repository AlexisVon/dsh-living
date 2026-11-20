#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { PetkitClient, FEEDER_TYPES, todayIn } from '../lib/client.mjs'
import { gemHome, loadConfig, loadCredential, saveCredential, loadDevices, loadSelected, loadFeedState, saveFeedState } from '../lib/config.mjs'
import { feedWithVerification } from '../lib/feed.mjs'
import { errorCodeKey } from '../lib/events.mjs'
import { findMeal, formatClock, mealActionIssue, parseClock, summarizeMeal, waitForMealStatus } from '../lib/plan.mjs'
import { downloadPetkitImage } from '../lib/media.mjs'
import { isAuthError, isRateLimit } from '../lib/errors.mjs'

const NAME = 'dsh-gem-petkit'
const VERSION = '0.1.1'
const PROTOCOL = '2024-11-05'

const TOOLS = [
  {
    name: 'petkit_status',
    description: "Read the feeder's current state: food level, desiccant, power, today's planned/dispensed totals, today's meal status (including one-day skips) and the latest eating event. Read-only.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'petkit_history',
    description: 'Read feeding and eating records for recent days. Returns a compact summary by default; set includeItems for item-level detail and preview URLs. This D4H has no pet identity, so records do not say which cat ate.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many recent days to read, 1-30. Default 1 (today).' },
        date: { type: 'string', description: 'One specific day in YYYYMMDD; overrides days.' },
        includeItems: { type: 'boolean', description: 'Include item detail and fresh preview URLs. Default false.' },
      },
    },
  },
  {
    name: 'petkit_media',
    description: 'Download and decrypt one PetKit camera preview image (eating or feeding), save it locally, and return the path. Use read_image on that path to look at the cat. Previews are on-demand; the signed URL expires in about an hour, so fetch when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event id from petkit_history(includeItems=true). Omit for the latest image.' },
        kind: { type: 'string', enum: ['eat', 'feed'], description: 'Record type when picking the latest image. Default eat.' },
        day: { type: 'string', description: 'YYYYMMDD; default today.' },
      },
    },
  },
  {
    name: 'petkit_plan',
    description: 'Read the recurring weekly feeding plan. This is the weekly schedule; today’s one-day skips and actual dispensing are shown by petkit_status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'petkit_skip_meal',
    description: "Skip one of today's scheduled meals without changing the weekly plan. Use before the meal time; refuses if it already dispensed or its time has passed. Verifies the record becomes status=1. Reversible with petkit_restore_meal.",
    inputSchema: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'Meal time today in HH:MM (24-hour), e.g. "12:00".' },
      },
      required: ['time'],
    },
  },
  {
    name: 'petkit_restore_meal',
    description: "Restore one of today's skipped meals. Refuses if the meal is not skipped or its time has passed, because restoring a past meal may dispense immediately.",
    inputSchema: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'Meal time today in HH:MM (24-hour), e.g. "12:00".' },
      },
      required: ['time'],
    },
  },
  {
    name: 'petkit_feed',
    description: 'Dispense 10/20/30/40/50 grams now, then wait up to feedVerifySeconds for physical confirmation. Returns dispensed, unknown, failed or rejected. On unknown, never retry; check petkit_history later.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', enum: [10, 20, 30, 40, 50], description: 'Grams to dispense.' },
        reason: { type: 'string', description: 'Optional note for the operator log.' },
      },
      required: ['amount'],
    },
  },
]

function reply(id, result) {
  if (id === undefined) return
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail(id, code, message) {
  if (id === undefined) return
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] }
}

function toolError(error) {
  return { content: [{ type: 'text', text: `错误：${error.message}` }], isError: true }
}

function currentDevice(home = gemHome()) {
  const devices = loadDevices(home)
  const selected = loadSelected(home)
  const found = devices.find((device) => device.id === selected)
  if (found) return found
  const feeders = devices.filter((device) => FEEDER_TYPES.has(device.deviceType))
  if (feeders.length === 1) return feeders[0]
  throw new Error('没有选中的喂食器：先在宝石页登录')
}

async function withClient(fn) {
  const home = gemHome()
  const config = loadConfig(home)
  const credential = loadCredential(home)
  if (!credential) throw new Error('未登录：在宝石页输入小佩账号密码')
  const client = new PetkitClient({ credential, config })
  try {
    return await fn(client, config, credential)
  } catch (error) {
    if (!isAuthError(error)) throw error
    let next
    try {
      next = await client.refresh()
    } catch {
      throw new Error('小佩登录态失效：在宝石页重新登录')
    }
    saveCredential({ ...credential, ...next }, home)
    return fn(client, config, { ...credential, ...next })
  }
}

function eatDuration(item) {
  const start = Number(item?.eatStartTime)
  const end = Number(item?.eatEndTime)
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : null
}

function clockFromSeconds(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return '--:--'
  return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}`
}

function localClock(epochSeconds, timezone) {
  const value = Number(epochSeconds)
  if (!Number.isFinite(value)) return '--:--'
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(value * 1000))
}

function daysBack(day, offset) {
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(4, 6))
  const date = Number(day.slice(6, 8))
  const shifted = new Date(Date.UTC(year, month - 1, date - offset))
  const pick = (value) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}${pick(shifted.getUTCMonth() + 1)}${pick(shifted.getUTCDate())}`
}

function feedGroups(records) {
  return Array.isArray(records?.feed) ? records.feed : []
}

function allFeedItems(records) {
  return feedGroups(records).flatMap((group) => group.items ?? [])
}

function allEatItems(records) {
  return (Array.isArray(records?.eat) ? records.eat : []).flatMap((group) => group.items ?? [])
}

function currentLocalSeconds(timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return pick('hour') * 3600 + pick('minute') * 60 + pick('second')
}

function mealLine(planItem, record, day, timezone) {
  const clock = clockFromSeconds(planItem.time)
  const label = planItem.name ? `${planItem.name} ` : ''
  const base = `${clock} ${label}${planItem.amount}g`
  if (record?.state) {
    const failed = Number(record.state.errCode ?? 0) !== 0 || Number(record.state.result ?? 0) !== 0
    const real = record.state.realAmount ?? record.amount
    return `${base} → ${failed ? `失败（错误码 ${record.state.errCode || record.state.result}）` : `已出 ${real}g`}`
  }
  if (Number(record?.status) === 1) return `${base} → 已停`
  const today = day === todayIn(timezone)
  if (today && Number(planItem.time) > currentLocalSeconds(timezone)) return `${base} → 待出`
  return `${base} → 未执行`
}

function formatStatus(detail, records, config, device, gemState = {}) {
  const state = detail?.state ?? {}
  const feed = state.feedState ?? {}
  const name = detail?.name || device.name || '喂食器'
  const lines = []
  lines.push(`设备：${name}（${device.deviceType}，typeCode=${device.typeCode ?? '?'}）`)
  lines.push(`连接：云接口可达；粮量 food=${state.food ?? '?'}；干燥剂 ${state.desiccantLeftDays ?? '?'} 天；电源 ${Number(state.pim) === 2 ? `电池 ${Number(state.batteryPower ?? 0) * 25}%` : '市电'}`)
  lines.push(`今日：计划 ${feed.planAmountTotal ?? '?'}g，已出 ${feed.realAmountTotal ?? '?'}g（计划 ${feed.planRealAmountTotal ?? '?'}g + 手动 ${feed.addAmountTotal ?? '?'}g），次数 ${feed.times ?? '?'}`)
  if (errorCodeKey(state.errorCode) !== '0') lines.push(`故障：${state.errorMsg || state.errorDetail || `错误码 ${state.errorCode}`}`)

  const day = todayIn(config.timezone)
  const planRecords = allFeedItems(records)
    .filter((item) => Number(item.src) !== 3)
    .slice()
    .sort((a, b) => Number(a.time) - Number(b.time))
  const fallbackPlan = detail?.multiFeedItem?.feedDailyList?.[0]?.items ?? []
  const todayMeals = planRecords.length > 0
    ? planRecords.map((item) => mealLine(item, item, day, config.timezone))
    : fallbackPlan.map((item) => mealLine(item, null, day, config.timezone))
  if (planRecords.length === 0 && fallbackPlan.length > 0 && records == null) {
    lines.push('今日记录读取失败，餐次按周计划首日显示')
  }
  if (todayMeals.length > 0) lines.push(`今日餐次：${todayMeals.join('；')}`)

  const manual = allFeedItems(records).filter((item) => Number(item.src) === 3 && item.state)
  const gemFeedIds = new Set(
    (gemState.gemFeeds ?? []).filter((entry) => entry.day === day && entry.recordId).map((entry) => entry.recordId),
  )
  const gemManual = manual.filter((item) => gemFeedIds.has(item.id))
  const appManual = manual.filter((item) => !gemFeedIds.has(item.id))
  const gemPending = (gemState.gemFeeds ?? [])
    .filter((entry) => entry.day === day && !entry.recordId)
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0)
  const gemAmount = gemManual.reduce((sum, item) => sum + Number(item.state?.realAmount ?? item.amount ?? 0), 0) + gemPending
  const appAmount = appManual.reduce((sum, item) => sum + Number(item.state?.realAmount ?? item.amount ?? 0), 0)
  if (manual.length > 0 || gemPending > 0) {
    lines.push(`今日手动：全部 ${gemAmount + appAmount}g（宝石 ${gemAmount}g / App ${appAmount}g${gemPending > 0 ? `，含未确认 ${gemPending}g` : ''}）`)
    if (manual.length > 0) {
      lines.push(`今日手动明细：${manual.map((item) => `${clockFromSeconds(item.time)} ${item.state?.realAmount ?? item.amount}g（${gemFeedIds.has(item.id) ? '宝石' : 'App/其他'}）`).join('；')}`)
    }
  } else if (records != null) {
    lines.push('今日手动：没有记录')
  }

  if (records == null) {
    lines.push('今日进食：记录读取失败')
  } else {
    const eats = allEatItems(records).slice().sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
    if (eats.length === 0) {
      lines.push('今日进食：还没有记录')
    } else {
      const latest = eats[0]
      const duration = eatDuration(latest)
      const latestKind = duration == null ? '进食中' : Number(latest.empty) === 1 ? '空碗' : '有粮'
      lines.push(`最近进食：${localClock(latest.timestamp, config.timezone)}，${duration == null ? '进行中' : `${duration} 秒`}，${latestKind}${latest.desc ? `（${latest.desc}）` : ''}`)
      const ongoing = eats.filter((item) => eatDuration(item) == null).length
      lines.push(`今日进食：${eats.filter((item) => Number(item.empty) === 0).length} 次进食 / ${eats.filter((item) => Number(item.empty) === 1).length} 次空碗${ongoing > 0 ? ` / ${ongoing} 条进行中` : ''}；猫出现 ${(records.pet ?? []).flatMap((group) => group.items ?? []).length} 次`)
    }
  }
  lines.push('注意：这台 D4H 没有宠物身份识别，记录不区分是哪只猫。')
  return lines.join('\n')
}

function formatHistoryDay(records, day, timezone, includeItems, gemFeedIds = new Set()) {
  const lines = [`${day}：`]
  const planItems = allFeedItems(records).filter((item) => Number(item.src) !== 3)
  const manual = allFeedItems(records).filter((item) => Number(item.src) === 3)
  if (planItems.length === 0 && manual.length === 0) {
    lines.push('- 出粮：没有记录')
  } else {
    for (const item of planItems) {
      if (item.state && (Number(item.state.errCode ?? 0) !== 0 || Number(item.state.result ?? 0) !== 0)) {
        lines.push(`- ${clockFromSeconds(item.time)} 计划${item.name ? `·${item.name}` : ''} ${item.amount}g → 失败（错误码 ${item.state.errCode || item.state.result}）`)
      } else if (item.state) {
        lines.push(`- ${clockFromSeconds(item.time)} 计划${item.name ? `·${item.name}` : ''} ${item.amount}g → 已出 ${item.state.realAmount ?? item.amount}g`)
      } else if (Number(item.status) === 1) {
        lines.push(`- ${clockFromSeconds(item.time)} 计划${item.name ? `·${item.name}` : ''} ${item.amount}g → 已停`)
      } else if (day === todayIn(timezone) && Number(item.time) > currentLocalSeconds(timezone)) {
        lines.push(`- ${clockFromSeconds(item.time)} 计划${item.name ? `·${item.name}` : ''} ${item.amount}g → 待出`)
      } else {
        lines.push(`- ${clockFromSeconds(item.time)} 计划${item.name ? `·${item.name}` : ''} ${item.amount}g → 未执行`)
      }
    }
    const completedManual = manual.filter((item) => item.state)
    if (completedManual.length > 0) {
      const manualTotal = completedManual.reduce((sum, item) => sum + Number(item.state.realAmount ?? item.amount ?? 0), 0)
      const gemTotal = completedManual
        .filter((item) => gemFeedIds.has(item.id))
        .reduce((sum, item) => sum + Number(item.state.realAmount ?? item.amount ?? 0), 0)
      lines.push(`- 手动合计：全部 ${manualTotal}g（宝石 ${gemTotal}g / App ${manualTotal - gemTotal}g）`)
    }
    for (const item of manual) {
      if (!item.state) continue
      const who = gemFeedIds.has(item.id) ? '宝石' : 'App/其他'
      lines.push(`- ${clockFromSeconds(item.time)} 手动 ${item.state.realAmount ?? item.amount}g（${who}）${Number(item.state.errCode ?? 0) ? `（错误码 ${item.state.errCode}）` : ''}`)
    }
  }

  const eats = allEatItems(records).slice().sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
  if (eats.length === 0) {
    lines.push('- 进食：没有记录')
  } else {
    const eating = eats.filter((item) => Number(item.empty) === 0).length
    const empty = eats.filter((item) => Number(item.empty) === 1).length
    const ongoing = eats.filter((item) => eatDuration(item) == null).length
    const total = eats.reduce((sum, item) => sum + (eatDuration(item) ?? 0), 0)
    lines.push(`- 进食：${eating} 次进食 / ${empty} 次空碗${ongoing > 0 ? ` / ${ongoing} 条进行中` : ''}，总时长 ${total} 秒；猫出现 ${(records?.pet ?? []).flatMap((group) => group.items ?? []).length} 次`)
    const shown = includeItems ? eats.slice(0, 20) : eats.slice(0, 3)
    for (const item of shown) {
      const duration = eatDuration(item)
      const kind = duration == null ? '进食中' : Number(item.empty) === 1 ? '空碗' : '有粮'
      const media = includeItems && item.preview ? `；预览 ${item.preview}` : ''
      const event = includeItems && item.eventId ? `；事件 ${item.eventId}` : ''
      lines.push(`  - ${clockFromSeconds(item.startTime)} ${duration == null ? '进行中' : `${duration} 秒`}，${kind}${item.desc ? `：${item.desc}` : ''}${media}${event}`)
    }
  }
  return lines.join('\n')
}

function formatPlan(plan) {
  const days = Array.isArray(plan?.feedDailyList) ? plan.feedDailyList : []
  const schedule = (items) => (items ?? [])
    .slice()
    .sort((a, b) => Number(a.time) - Number(b.time))
    .map((item) => `${clockFromSeconds(item.time)} ${item.amount}g${item.name ? ` ${item.name}` : ''}`)
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
  // PetKit repeats: 1–7 = Monday–Sunday (app convention; verify on per-day plans).
  const weekday = ['', '一', '二', '三', '四', '五', '六', '日']
  const lines = []
  for (const group of groups) {
    const label = group.days.length === 7
      ? '每天'
      : `周${group.days.map((value) => weekday[value] ?? value).join('、')}`
    lines.push(`${label}${Number(group.day.suspended) === 1 ? '（已暂停）' : ''}：${schedule(group.day.items)}`)
  }
  lines.push('周计划不代表今天实际：一天的停喂与已出看 petkit_status。')
  return lines.join('\n')
}

function formatFeedResult(result) {
  if (result.status === 'dispensed') {
    const evidence = result.evidence ?? {}
    return `已出粮 ${result.amount} 克（已确认：手动总量 ${evidence.manualBefore ?? '?'}→${evidence.manualAfter ?? '?'}，总量 ${evidence.realBefore ?? '?'}→${evidence.realAfter ?? '?'}）`
  }
  if (result.status === 'unknown') {
    return `出粮未确认：${result.message}${result.recordId ? `（记录 ${result.recordId}）` : ''}`
  }
  if (result.status === 'failed') {
    return `出粮失败：${result.message}${result.code === 'gem_cookie_expired' ? '；请在宝石页重新登录' : ''}`
  }
  return `出粮被拒绝：${result.message}`
}

async function callTool(name, args = {}) {
  if (name === 'petkit_status') {
    return withClient(async (client, config) => {
      const device = currentDevice()
      const detail = await client.detail(device)
      let records = null
      try {
        records = await client.records(device, todayIn(config.timezone))
      } catch {}
      return text(formatStatus(detail, records, config, device, loadFeedState(gemHome())))
    })
  }

  if (name === 'petkit_history') {
    return withClient(async (client, config) => {
      const device = currentDevice()
      const date = typeof args.date === 'string' && /^\d{8}$/.test(args.date) ? args.date : null
      const days = date ? 1 : Math.min(config.historyDays, Math.max(1, Math.trunc(Number(args.days ?? 1))))
      const state = loadFeedState(gemHome())
      const gemFeedIdsFor = (day) => new Set(
        (state.gemFeeds ?? []).filter((entry) => entry.day === day && entry.recordId).map((entry) => entry.recordId),
      )
      const sections = []
      for (let index = 0; index < days; index += 1) {
        const day = date ?? daysBack(todayIn(config.timezone), index)
        const records = await client.records(device, day)
        sections.push(formatHistoryDay(records, day, config.timezone, args.includeItems === true, gemFeedIdsFor(day)))
      }
      return text(sections.join('\n\n'))
    })
  }

  if (name === 'petkit_media') {
    return withClient(async (client, config) => {
      const device = currentDevice()
      const day = typeof args.day === 'string' && /^\d{8}$/.test(args.day) ? args.day : todayIn(config.timezone)
      const records = await client.records(device, day)
      const wanted = typeof args.eventId === 'string' && args.eventId !== '' ? args.eventId : null
      const kind = args.kind === 'feed' ? 'feed' : 'eat'
      const groups = wanted
        ? [...(Array.isArray(records.eat) ? records.eat : []), ...(Array.isArray(records.feed) ? records.feed : [])]
        : (kind === 'feed' ? records.feed : records.eat)
      const items = (Array.isArray(groups) ? groups : []).flatMap((group) => group.items ?? [])
      const candidates = items.filter((item) => item.preview && (item.aesKey || item.aesKey1))
      const item = wanted
        ? candidates.find((entry) => entry.eventId === wanted || entry.event === wanted)
        : candidates.slice().sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0]
      if (!item) throw new Error(wanted ? `没有找到事件 ${wanted} 的预览图` : '最近的记录没有预览图')
      const media = await downloadPetkitImage({
        url: item.preview,
        aesKey: item.aesKey || item.aesKey1,
        home: gemHome(),
        eventId: item.eventId || item.id || `${day}_${item.timestamp}`,
      })
      const isEat = item.eatStartTime !== undefined || Number(item.eventType) === 6
      const detail = isEat
        ? `${eatDuration(item) == null ? '进行中' : `${eatDuration(item)} 秒`}${Number(item.empty) === 1 ? '，空碗' : '，有粮'}${item.desc ? `；${item.desc}` : ''}`
        : `${clockFromSeconds(item.time)} 出粮 ${item.amount ?? '?'}g`
      return text(`预览图：${media.path}\n${detail}\n用 read_image 打开这个路径。`)
    })
  }

  if (name === 'petkit_plan') {
    return withClient(async (client) => {
      const plan = await client.feedPlan(currentDevice())
      return text(formatPlan(plan))
    })
  }

  if (name === 'petkit_skip_meal' || name === 'petkit_restore_meal') {
    const action = name === 'petkit_skip_meal' ? 'skip' : 'restore'
    return withClient(async (client, config) => {
      const feedTime = parseClock(args.time)
      const day = todayIn(config.timezone)
      const device = currentDevice()
      const records = await client.records(device, day)
      const item = findMeal(records, feedTime)
      if (!item) throw new Error(`今天没有 ${formatClock(feedTime)} 的计划餐；先用 petkit_status 看今日餐次`)
      const label = summarizeMeal(item)
      const issue = mealActionIssue({ item, feedTime, nowSeconds: currentLocalSeconds(config.timezone), action })
      if (issue === 'already_skipped') return text(`今天 ${label} 已经是停用状态，没有改动。`)
      if (issue === 'not_skipped') return text(`今天 ${label} 当前不是停用状态，无需恢复。`)
      if (issue === 'already_executed') return text(`今天 ${label} 已有执行记录，不能再停。`)
      if (issue === 'time_passed') {
        throw new Error(action === 'skip'
          ? `今天 ${label} 的时间已过，停喂没有意义，没有改动。`
          : `今天 ${label} 的时间已过，恢复可能立即出粮；拒绝恢复，请直接手动喂或等下一顿。`)
      }
      try {
        if (action === 'skip') await client.removeDailyFeed(device, day, feedTime)
        else await client.restoreDailyFeed(device, day, feedTime)
      } catch (error) {
        if (isRateLimit(error)) throw new Error('小佩限流（1514）：停/恢复操作太频繁，等一会儿再用 petkit_status 确认，不要连续重试')
        throw error
      }
      const check = await waitForMealStatus({
        fetchRecords: () => client.records(device, day),
        feedTime,
        expectStatus: action === 'skip' ? 1 : 0,
      })
      if (check.verified) {
        return text(action === 'skip'
          ? `已停掉今天 ${label}，记录 status=1。只影响今天，不改周计划；可用 petkit_restore_meal 恢复。`
          : `已恢复今天 ${label}，记录 status=0。会按周计划正常出粮。`)
      }
      return text(`${action === 'skip' ? '已提交停喂' : '已提交恢复'}：今天 ${label}，但今日记录还没反映（当前 status=${check.item?.status ?? '缺失'}）。不要重复调用；稍后用 petkit_status 确认。`)
    })
  }

  if (name === 'petkit_feed') {
    const home = gemHome()
    const config = loadConfig(home)
    const credential = loadCredential(home)
    if (!credential) throw new Error('未登录：在宝石页输入小佩账号密码')
    const client = new PetkitClient({ credential, config })
    if (!credential.expiresAt || credential.expiresAt - Date.now() < 5 * 60_000) {
      try {
        const next = await client.refresh()
        saveCredential({ ...credential, ...next }, home)
      } catch {
        return { content: [{ type: 'text', text: '出粮失败：小佩登录态失效，未提交出粮；请在宝石页重新登录' }], isError: true }
      }
    }
    if (typeof args.reason === 'string' && args.reason.trim() !== '') {
      process.stderr.write(`[petkit] feed reason: ${args.reason.trim()}\n`)
    }
    const state = loadFeedState(home)
    const result = await feedWithVerification({
      client,
      device: currentDevice(home),
      amount: args.amount,
      config,
      state,
      day: todayIn(config.timezone),
      onSubmitted: () => saveFeedState(state, home),
    })
    saveFeedState(state, home)
    return { content: [{ type: 'text', text: formatFeedResult(result) }], isError: result.status !== 'dispensed' }
  }

  return toolError(new Error(`未知工具: ${name}`))
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
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
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try {
      return reply(id, await callTool(params?.name, params?.arguments ?? {}))
    } catch (error) {
      return reply(id, toolError(error))
    }
  }
  if (id !== undefined) fail(id, -32601, `unknown method: ${method}`)
})

rl.on('close', () => process.exit(0))
process.stderr.write(`${NAME} MCP ready\n`)
