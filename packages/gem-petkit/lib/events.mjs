const GEM = 'petkit'

function from(device) {
  return { id: String(device.id), name: device.name || '喂食器' }
}

function parseCompletedAt(value) {
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (Number.isFinite(Number(value))) {
    const number = Number(value)
    return number < 1e12 ? number * 1000 : number
  }
  return null
}

function event(device, { kind, externalId, text, ts, silent, meta = {} }) {
  return {
    gem: GEM,
    kind: 'change',
    external_id: externalId,
    from: from(device),
    text,
    ts: ts ?? Date.now(),
    meta: { trusted: true, silent, alarm: kind, ...meta },
  }
}

/** Turn newly completed feed records into silent events; failures ring. */
export function feedEvents(device, records, seen = new Set()) {
  const events = []
  const next = new Set(seen)
  const groups = Array.isArray(records?.feed) ? records.feed : []
  for (const group of groups) {
    for (const item of group.items ?? []) {
      const key = item.eventId || item.id
      if (!key || next.has(key)) continue
      const state = item.state
      if (!state) continue
      const completed = state.completedAt !== undefined || state.realAmount !== undefined || state.errCode !== undefined
      if (!completed) continue
      next.add(key)
      const errCode = Number(state.errCode ?? 0)
      const result = Number(state.result ?? 0)
      const failed = errCode !== 0 || result !== 0
      const realAmount = Number.isFinite(Number(state.realAmount)) ? Number(state.realAmount) : Number(item.amount ?? 0)
      const label = Number(item.src) === 3 ? '手动' : `计划${item.name ? `·${item.name}` : ''}`
      const text = failed
        ? `喂食器出粮失败：${label} ${item.amount ?? '?'} 克（错误码 ${errCode || result}）`
        : `喂食器出粮 ${realAmount} 克（${label}）`
      events.push(event(device, {
        kind: failed ? 'feed_failed' : 'feed',
        externalId: `petkit_feed_${key}`,
        text,
        ts: parseCompletedAt(state.completedAt) ?? (Number(item.completedAt) ? Number(item.completedAt) * 1000 : Date.now()),
        silent: !failed,
        meta: {
          record_id: item.id ?? null,
          event_id: item.eventId ?? null,
          src: item.src ?? null,
          amount: item.amount ?? null,
          real_amount: state.realAmount ?? null,
          err_code: state.errCode ?? null,
        },
      }))
    }
  }
  return { events, seen: next }
}

/** Daily/transition alarms from one device detail snapshot. Mutates state.alarms. */
export function alarmEvents({ detail, config, state = {}, device, day, now = Date.now() }) {
  const events = []
  const snapshot = detail?.state ?? {}
  state.alarms ??= {}
  const alarms = state.alarms

  const errorCode = Number(snapshot.errorCode ?? 0)
  if (errorCode !== 0 && errorCode !== alarms.errorCode) {
    const message = snapshot.errorMsg || snapshot.errorDetail || `错误码 ${errorCode}`
    events.push(event(device, {
      kind: 'error',
      externalId: `petkit_alarm_error_${errorCode}_${now}`,
      text: `喂食器报错：${message}`,
      ts: now,
      silent: false,
      meta: { error_code: errorCode },
    }))
  } else if (errorCode === 0 && alarms.errorCode) {
    events.push(event(device, {
      kind: 'error_clear',
      externalId: `petkit_alarm_error_clear_${now}`,
      text: '喂食器故障已恢复',
      ts: now,
      silent: true,
    }))
  }
  alarms.errorCode = errorCode

  const food = Number(snapshot.food)
  if (Number.isFinite(food) && food <= Number(config.foodLowLevel) && alarms.foodLowDay !== day) {
    events.push(event(device, {
      kind: 'food_low',
      externalId: `petkit_alarm_food_low_${day}`,
      text: `喂食器粮量低（food=${food}）`,
      ts: now,
      silent: false,
      meta: { food },
    }))
    alarms.foodLowDay = day
  }

  const desiccant = Number(snapshot.desiccantLeftDays)
  if (Number.isFinite(desiccant) && desiccant <= Number(config.desiccantWarnDays) && alarms.desiccantDay !== day) {
    events.push(event(device, {
      kind: 'desiccant',
      externalId: `petkit_alarm_desiccant_${day}`,
      text: `喂食器干燥剂剩余 ${desiccant} 天`,
      ts: now,
      silent: true,
      meta: { desiccant_left_days: desiccant },
    }))
    alarms.desiccantDay = day
  }

  const batteryPercent = Number(snapshot.pim) === 2 ? Number(snapshot.batteryPower) * 25 : null
  if (batteryPercent !== null && Number.isFinite(batteryPercent) && batteryPercent <= Number(config.batteryLowPercent) && alarms.batteryDay !== day) {
    events.push(event(device, {
      kind: 'battery_low',
      externalId: `petkit_alarm_battery_${day}`,
      text: `喂食器电量低（${batteryPercent}%）`,
      ts: now,
      silent: true,
      meta: { battery_percent: batteryPercent },
    }))
    alarms.batteryDay = day
  }

  return events
}

export function offlineAlarm(device, now = Date.now()) {
  return event(device, {
    kind: 'offline',
    externalId: `petkit_alarm_offline_${now}`,
    text: '喂食器连续不可达，可能离线',
    ts: now,
    silent: false,
  })
}

export function onlineRecovery(device, now = Date.now()) {
  return event(device, {
    kind: 'online',
    externalId: `petkit_alarm_online_${now}`,
    text: '喂食器恢复在线',
    ts: now,
    silent: true,
  })
}
