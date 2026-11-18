/**
 * Pure clock: schedule, night sleep, and the grid-based auto-wake process.
 * Time and RNG are injected so every branch is reproducible in tests.
 */

const DAY_MS = 86400000
const MIN = 60000

/** Fixed auto-wake presets: five peak widths, equal weight, then 60/40 normal/shuffled. */
export const AUTO_SIGMA_RATIOS = Object.freeze([1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 2])
export const AUTO_NORMAL_SHARE = 0.6
export const AUTO_GRID_MINUTES = Object.freeze([10, 20, 30, 40, 60])
export const AUTO_SAMPLE_SECONDS = Object.freeze([30, 60])

export const CLOCK_DEFAULTS = Object.freeze({
  nightAtMinutes: 3 * 60 + 30,
  nightWindowMinutes: 360,
  nightDurationMinutes: 90,
  scheduleGraceMinutes: 30,
  tzOffsetMinutes: null,
  autoWake: Object.freeze({
    gridMinutes: 10,
    sampleSeconds: 30,
    normalExpected: 0.1,
    lowExpected: 0.05,
    highExpected: 0.2,
    hotRanges: Object.freeze([[6, 8], [12, 14], [18, 24]]),
    coldRanges: Object.freeze([[0, 6]]),
  }),
})

export function createClockState(now) {
  return {
    createdAt: now,
    lastWakeAt: null,
    lastWakeKind: null,
    nextWakeAt: null,
    sleepingUntil: 0,
    sleepKind: null,
    nightDay: null,
    lastConsolidationAt: 0,
    schedule: [],
    auto: null,
  }
}

export function dayKey(now, tzOffsetMinutes = defaultTzOffset()) {
  return new Date(now + tzOffsetMinutes * 60000).toISOString().slice(0, 10)
}

/** Affine real→simulated clock: 1 real ms becomes `timeScale` simulated ms. */
export function scaledNow(realNow, baseReal, baseSim, timeScale) {
  if (!Number.isFinite(timeScale) || timeScale <= 0) throw new RangeError(`timeScale 必须为正数: ${timeScale}`)
  return Math.round(baseSim + (realNow - baseReal) * timeScale)
}

export function addSchedule(state, item) {
  if (!item || typeof item.id !== 'string' || item.id === '') throw new RangeError('schedule.id 必须是非空字符串')
  if (!Number.isFinite(item.at)) throw new RangeError('schedule.at 必须是 epoch 毫秒')
  const s = cloneState(state)
  if (s.schedule.some((x) => x.id === item.id)) throw new RangeError(`重复的日程 id: ${item.id}`)
  s.schedule.push({ id: item.id, at: item.at, intent: item.intent ?? '', done: false, missed: false })
  return s
}

export function completeSchedule(state, id) {
  const s = cloneState(state)
  const item = s.schedule.find((x) => x.id === id)
  if (!item) throw new RangeError(`未知的日程 id: ${id}`)
  item.done = true
  return s
}

export function endSleep(state, now) {
  return { ...cloneState(state), sleepingUntil: 0, sleepKind: null, lastWakeAt: now, lastWakeKind: 'sleep_end' }
}

export function nextDeadline(state, now, config = {}) {
  const cfg = resolveConfig(config)
  const tz = cfg.tzOffsetMinutes
  const day = dayKey(now, tz)
  const candidates = []

  for (const item of state.schedule ?? []) if (!item.done && !item.missed) candidates.push(item.at)
  if (state.sleepingUntil > now) candidates.push(state.sleepingUntil)

  const night = state.nightDay === day
    ? localMinuteEpoch(now, tz, cfg.nightAtMinutes) + DAY_MS
    : nextDailyOccurrence(now, tz, cfg.nightAtMinutes)
  candidates.push(night)

  return candidates.length ? Math.min(...candidates) : null
}

/** At-most-once catch-up decision after a restart; the caller runs one round. */
export function recoveryDue(state, now) {
  if (state.sleepingUntil > now) return null
  if (state.nextWakeAt == null || now < state.nextWakeAt) return null
  return { action: 'wake', trigger: 'recovery', detail: { lateMinutes: Math.round((now - state.nextWakeAt) / MIN) } }
}

/**
 * Daily expected summary for the config UI. It also validates that every class
 * has at least one eligible sigma; otherwise the config would be impossible.
 */
export function autoWakeEstimate(now, config = {}) {
  const cfg = resolveConfig(config)
  const tz = cfg.tzOffsetMinutes
  const gridMs = cfg.autoWake.gridMinutes * MIN
  const dayStart = localDayStart(now, tz)
  const grids = Math.round(DAY_MS / gridMs)
  const counts = { normal: 0, low: 0, high: 0 }
  const caps = sigmaCaps(cfg)
  const maxCap = Math.max(...caps.map((cap) => cap.lambdaMax))
  for (const [className, value] of [
    ['normal', cfg.autoWake.normalExpected],
    ['low', cfg.autoWake.lowExpected],
    ['high', cfg.autoWake.highExpected],
  ]) {
    if (value > maxCap + 1e-9) {
      throw new RangeError(`autoWake.${className} 的期望 ${value} 超过所有 σ 的上限 ${maxCap.toFixed(3)}；请降低期望或加宽 σ`)
    }
  }
  let eDay = 0
  for (let index = 0; index < grids; index += 1) {
    const start = dayStart + index * gridMs
    const className = classifyGrid(start, dayStart, cfg)
    counts[className] += 1
    eDay += lambdaFor(className, cfg)
  }
  return { grids, counts, eDay, eMax: maxCap * grids, maxCap }
}

/**
 * One tick. Returns the next state plus what the host should do.
 * `env.pendingEvents` is the number of ringing external events.
 */
export function tick(state, now, env = {}, config = {}, rng = Math.random) {
  const cfg = resolveConfig(config)
  const tz = cfg.tzOffsetMinutes
  const s = cloneState(state)
  const missed = []
  const day = dayKey(now, tz)
  const auto = ensureAutoPlan(s, now, cfg, rng)

  const voidPoint = () => {
    if (auto.plan) auto.plan.pointIndex = Math.max(auto.plan.pointIndex, auto.pointIndex)
  }

  // External events bypass the auto-wake process and interrupt sleep.
  if ((env.pendingEvents ?? 0) > 0) {
    const interrupted = s.sleepingUntil > now
    voidPoint()
    s.lastWakeAt = now
    s.lastWakeKind = 'event'
    s.sleepingUntil = 0
    s.sleepKind = null
    s.nextWakeAt = nextDeadline(s, now, cfg)
    return {
      state: s,
      decision: {
        action: 'wake',
        trigger: 'event',
        detail: { pendingEvents: env.pendingEvents, interruptedSleep: interrupted },
      },
      missed,
    }
  }

  if (s.sleepingUntil > now) {
    voidPoint()
    s.nextWakeAt = nextDeadline(s, now, cfg)
    return { state: s, decision: sleep('sleeping', { until: s.sleepingUntil }), missed }
  }
  if (s.sleepingUntil) {
    s.sleepingUntil = 0
    s.sleepKind = null
  }

  const nightAt = localMinuteEpoch(now, tz, cfg.nightAtMinutes)
  if (s.nightDay !== day) {
    if (now >= nightAt && now < nightAt + cfg.nightWindowMinutes * MIN) {
      voidPoint()
      s.nightDay = day
      s.lastWakeAt = now
      s.lastWakeKind = 'night'
      s.sleepingUntil = now + cfg.nightDurationMinutes * MIN
      s.sleepKind = 'night'
      s.nextWakeAt = nextDeadline(s, now, cfg)
      return {
        state: s,
        decision: { action: 'night', trigger: 'night', detail: { durationMinutes: cfg.nightDurationMinutes } },
        missed,
      }
    }
    if (now >= nightAt + cfg.nightWindowMinutes * MIN) s.nightDay = day
  }

  const { due, missed: missedIds } = scanSchedule(s, now, cfg)
  missed.push(...missedIds)
  if (due) {
    voidPoint()
    s.lastWakeAt = now
    s.lastWakeKind = 'schedule'
    s.nextWakeAt = nextDeadline(s, now, cfg)
    return {
      state: s,
      decision: {
        action: 'wake',
        trigger: 'schedule',
        detail: {
          scheduleId: due.id,
          intent: due.intent,
          lateMinutes: Math.round((now - due.at) / MIN),
        },
      },
      missed,
    }
  }

  const plan = auto.plan
  if (!plan) {
    s.nextWakeAt = nextDeadline(s, now, cfg)
    return { state: s, decision: sleep('auto_wait', {}), missed }
  }

  if (auto.pointIndex > plan.pointIndex) {
    plan.pointIndex = auto.pointIndex
    const p = plan.points[auto.pointIndex] ?? 0
    if (rng() < p) {
      s.lastWakeAt = now
      s.lastWakeKind = 'auto'
      s.nextWakeAt = nextDeadline(s, now, cfg)
      return {
        state: s,
        decision: {
          action: 'wake',
          trigger: 'auto',
          detail: {
            gridIndex: plan.gridIndex,
            gridStart: plan.start,
            gridEnd: plan.end,
            window: plan.window,
            className: plan.className,
            lambda: plan.lambda,
            sigmaRatio: plan.sigmaRatio,
            mode: plan.mode,
            pointIndex: auto.pointIndex,
            p,
          },
        },
        missed,
      }
    }
    s.nextWakeAt = nextDeadline(s, now, cfg)
    return {
      state: s,
      decision: sleep('auto_miss', { pointIndex: auto.pointIndex, p, lambda: plan.lambda, className: plan.className }),
      missed,
    }
  }

  s.nextWakeAt = nextDeadline(s, now, cfg)
  return {
    state: s,
    decision: sleep('auto_wait', { pointIndex: auto.pointIndex, lambda: plan.lambda, className: plan.className }),
    missed,
  }
}

function ensureAutoPlan(state, now, cfg, rng) {
  const tz = cfg.tzOffsetMinutes
  const day = dayKey(now, tz)
  const dayStart = localDayStart(now, tz)
  const gridMs = cfg.autoWake.gridMinutes * MIN
  const gridIndex = Math.min(Math.round((DAY_MS - 1) / gridMs), Math.floor((now - dayStart) / gridMs))
  const start = dayStart + gridIndex * gridMs
  const end = start + gridMs
  const sampleMs = cfg.autoWake.sampleSeconds * 1000
  const n = Math.round(gridMs / sampleMs)
  const pointIndex = Math.min(n - 1, Math.max(0, Math.floor((now - start) / sampleMs)))

  if (state.auto?.day === day && state.auto.gridIndex === gridIndex) {
    return { plan: state.auto, pointIndex }
  }

  const className = classifyGrid(start, dayStart, cfg)
  const lambda = lambdaFor(className, cfg)
  const caps = sigmaCaps(cfg)
  const eligible = lambda > 0
    ? caps.filter((cap) => lambda <= cap.lambdaMax + 1e-9)
    : caps
  if (eligible.length === 0) {
    throw new RangeError(`autoWake.${className} 的期望 ${lambda} 超过所有 σ 的上限；请降低系数或加宽 σ`)
  }
  const sigma = eligible[Math.min(eligible.length - 1, Math.floor(rng() * eligible.length))]
  const points = probabilityPoints({ start, gridMs, sampleMs, n, sigmaRatio: sigma.ratio, lambda })
  const mode = rng() < AUTO_NORMAL_SHARE ? 'normal' : 'shuffled'
  if (mode === 'shuffled') shuffle(points, rng)

  const plan = {
    day,
    gridIndex,
    start,
    end,
    window: `${clockTime(start, tz)}-${clockTime(end, tz)}`,
    className,
    lambda,
    sigmaRatio: sigma.ratio,
    mode,
    points,
    // The current point is eligible on the tick that creates the plan.
    pointIndex: pointIndex - 1,
  }
  state.auto = plan
  return { plan, pointIndex }
}

function probabilityPoints({ start, gridMs, sampleMs, n, sigmaRatio, lambda }) {
  const mu = start + gridMs / 2
  const sigma = gridMs * sigmaRatio
  const weights = []
  let sum = 0
  let max = 0
  for (let k = 0; k < n; k += 1) {
    const t = start + (k + 0.5) * sampleMs
    const w = Math.exp(-((t - mu) ** 2) / (2 * sigma * sigma))
    weights.push(w)
    sum += w
    if (w > max) max = w
  }
  if (sum <= 0) throw new RangeError('autoWake 正态权重全为 0')
  const lambdaMax = sum / max
  if (lambda > lambdaMax + 1e-9) {
    throw new RangeError(`autoWake 期望 ${lambda} 超过 σ=${sigmaRatio} 的上限 ${lambdaMax.toFixed(3)}`)
  }
  return weights.map((w) => (lambda * w) / sum)
}

function sigmaCaps(cfg) {
  const gridMs = cfg.autoWake.gridMinutes * MIN
  const sampleMs = cfg.autoWake.sampleSeconds * 1000
  const n = Math.round(gridMs / sampleMs)
  if (n * sampleMs !== gridMs) throw new RangeError('autoWake 网格长度必须是采样间隔的整数倍')
  return AUTO_SIGMA_RATIOS.map((ratio) => {
    const mu = gridMs / 2
    const sigma = gridMs * ratio
    let sum = 0
    let max = 0
    for (let k = 0; k < n; k += 1) {
      const t = (k + 0.5) * sampleMs
      const w = Math.exp(-((t - mu) ** 2) / (2 * sigma * sigma))
      sum += w
      if (w > max) max = w
    }
    return { ratio, lambdaMax: sum / max }
  })
}

function classifyGrid(start, dayStart, cfg) {
  const startMin = Math.round((start - dayStart) / MIN)
  const endMin = startMin + cfg.autoWake.gridMinutes
  const overlaps = (ranges) => ranges.some(([from, to]) => startMin < to * 60 && endMin > from * 60)
  if (overlaps(cfg.autoWake.hotRanges)) return 'high'
  if (overlaps(cfg.autoWake.coldRanges)) return 'low'
  return 'normal'
}

function lambdaFor(className, cfg) {
  if (className === 'high') return cfg.autoWake.highExpected
  if (className === 'low') return cfg.autoWake.lowExpected
  return cfg.autoWake.normalExpected
}

function resolveConfig(config = {}) {
  const cfg = { ...CLOCK_DEFAULTS, ...config }
  cfg.autoWake = { ...CLOCK_DEFAULTS.autoWake, ...(config.autoWake ?? {}) }
  if (cfg.tzOffsetMinutes == null) cfg.tzOffsetMinutes = defaultTzOffset()

  requireRange('tzOffsetMinutes', cfg.tzOffsetMinutes, -840, 840)
  requireRange('nightAtMinutes', cfg.nightAtMinutes, 0, 1439)
  requireRange('nightWindowMinutes', cfg.nightWindowMinutes, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER)
  requireRange('nightDurationMinutes', cfg.nightDurationMinutes, 0, Number.MAX_SAFE_INTEGER)
  requireRange('scheduleGraceMinutes', cfg.scheduleGraceMinutes, 0, Number.MAX_SAFE_INTEGER)

  const auto = cfg.autoWake
  if (!AUTO_GRID_MINUTES.includes(auto.gridMinutes)) {
    throw new RangeError(`autoWake.gridMinutes 只能是 ${AUTO_GRID_MINUTES.join(', ')}`)
  }
  if (!AUTO_SAMPLE_SECONDS.includes(auto.sampleSeconds)) {
    throw new RangeError(`autoWake.sampleSeconds 只能是 ${AUTO_SAMPLE_SECONDS.join(', ')}`)
  }
  if ((auto.gridMinutes * 60) % auto.sampleSeconds !== 0) {
    throw new RangeError('autoWake 网格长度必须是采样间隔的整数倍')
  }
  for (const key of ['normalExpected', 'lowExpected', 'highExpected']) {
    requireRange(`autoWake.${key}`, auto[key], 0, Number.MAX_SAFE_INTEGER)
  }
  validateRanges('autoWake.hotRanges', auto.hotRanges)
  validateRanges('autoWake.coldRanges', auto.coldRanges)
  return cfg
}

function validateRanges(name, ranges) {
  if (!Array.isArray(ranges)) throw new RangeError(`${name} 必须是数组`)
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) throw new RangeError(`${name} 的每一项必须是 [start, end]`)
    const [from, to] = range
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 24 || from >= to) {
      throw new RangeError(`${name} 的区间必须在 [0,24] 且 start < end: ${JSON.stringify(range)}`)
    }
  }
}

function requireRange(name, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} 超出范围 [${min}, ${max}]: ${value}`)
  }
}

function defaultTzOffset() {
  return -new Date().getTimezoneOffset()
}

function localDayStart(now, tzOffsetMinutes) {
  const shifted = now + tzOffsetMinutes * 60000
  return Math.floor(shifted / DAY_MS) * DAY_MS - tzOffsetMinutes * 60000
}

function localMinuteEpoch(now, tzOffsetMinutes, minuteOfDay) {
  return localDayStart(now, tzOffsetMinutes) + minuteOfDay * 60000
}

function nextDailyOccurrence(now, tzOffsetMinutes, minuteOfDay) {
  const today = localMinuteEpoch(now, tzOffsetMinutes, minuteOfDay)
  return today > now ? today : today + DAY_MS
}

function clockTime(epoch, tzOffsetMinutes) {
  return new Date(epoch + tzOffsetMinutes * 60000).toISOString().slice(11, 16)
}

function scanSchedule(state, now, cfg) {
  const missed = []
  let due = null
  for (const item of state.schedule) {
    if (item.done || item.missed || item.at > now) continue
    if (now - item.at <= cfg.scheduleGraceMinutes * MIN) {
      if (!due || item.at < due.at) due = item
    } else {
      item.missed = true
      missed.push(item.id)
    }
  }
  return { due, missed }
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)))
    const tmp = list[i]
    list[i] = list[j]
    list[j] = tmp
  }
}

function cloneState(state) {
  return {
    ...createClockState(state?.createdAt ?? 0),
    ...state,
    schedule: (state?.schedule ?? []).map((item) => ({ ...item })),
    auto: state?.auto
      ? { ...state.auto, points: Array.isArray(state.auto.points) ? state.auto.points.slice() : [] }
      : null,
  }
}

function sleep(reason, detail = {}) {
  return { action: 'sleep', trigger: null, reason, detail }
}
