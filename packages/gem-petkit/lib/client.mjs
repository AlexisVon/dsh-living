import { createHash } from 'node:crypto'
import { MANUAL_FEED_VALUES } from './config.mjs'
import { PetkitError } from './errors.mjs'

export const CHINA_GATEWAY = 'https://api.petkit.cn/6/'
export const FEEDER_TYPES = Object.freeze(new Set(['feeder', 'feedermini', 'd3', 'd4', 'd4s', 'd4h', 'd4sh']))
export const CAMERA_FEEDER_TYPES = Object.freeze(new Set(['d4h', 'd4sh']))
const API_VERSION = '13.2.1'
const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const DEFAULT_REGION = 'CN'

const BASE_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US;q=1, it-US;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'okhttp/3.14.9',
  'X-Img-Version': '1',
  'X-Locale': 'en-US',
  'X-Client': 'android(16.1;23127PN0CG)',
  'X-Hour': '24',
  'X-Api-Version': API_VERSION,
}

export function tzOffsetHours(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date())
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+0'
  const match = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!match) return '0.0'
  const hours = Number(match[1])
  const minutes = match[2] ? Number(match[2]) / 60 : 0
  const total = hours + (hours < 0 ? -minutes : minutes)
  return Number.isInteger(total) ? `${total}.0` : String(total)
}

export function todayIn(timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}${pick('month')}${pick('day')}`
}

function pyFloat(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

function pythonDictRepr(object) {
  const scalar = (value) => {
    if (value === null || value === undefined) return 'None'
    if (typeof value === 'boolean') return value ? 'True' : 'False'
    if (typeof value === 'number') return String(value)
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  return `{${Object.entries(object).map(([key, value]) => `${scalar(key)}: ${scalar(value)}`).join(', ')}}`
}

function clientInfo(timezone) {
  return pythonDictRepr({
    locale: 'en-US',
    name: '23127PN0CG',
    osVersion: '16.1',
    phoneBrand: 'Xiaomi',
    platform: 'android',
    source: 'app.petkit-android',
    version: API_VERSION,
    timezoneId: timezone,
    timezone: pyFloat(Number(tzOffsetHours(timezone))),
  })
}

export class PetkitClient {
  constructor({ credential = null, config = {}, fetchImpl = fetch, log = () => {} } = {}) {
    this.gateway = credential?.gateway || CHINA_GATEWAY
    this.region = String(credential?.region || DEFAULT_REGION).toUpperCase()
    this.timezone = credential?.timezone || config.timezone || DEFAULT_TIMEZONE
    this.sessionId = credential?.sessionId || ''
    this.userId = credential?.userId || ''
    this.username = credential?.username || ''
    this.fetchImpl = fetchImpl
    this.log = log
  }

  setSession(session) {
    this.sessionId = session?.sessionId || this.sessionId
    this.userId = session?.userId || this.userId
    this.username = session?.username || this.username
    if (session?.gateway) this.gateway = session.gateway
    if (session?.region) this.region = String(session.region).toUpperCase()
    if (session?.timezone) this.timezone = session.timezone
    return this
  }

  loginForm(extra) {
    return {
      client: clientInfo(this.timezone),
      encrypt: '1',
      region: this.region,
      oldVersion: API_VERSION,
      ...extra,
    }
  }

  async request({ method, path, params, form, auth = true, timeoutMs = 20000 }) {
    const url = new URL(path, this.gateway)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    const headers = {
      ...BASE_HEADERS,
      'X-TimezoneId': this.timezone,
      'X-Timezone': tzOffsetHours(this.timezone),
    }
    if (auth && this.sessionId) {
      headers['X-Session'] = this.sessionId
      headers['F-Session'] = this.sessionId
    }
    const body = form ? new URLSearchParams(form).toString() : undefined
    this.log(`${method} ${url.pathname}${url.search}`)
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${method} ${url.pathname}: ${text.slice(0, 200)}`)
    }
    if (payload && typeof payload === 'object' && payload.error) {
      throw new PetkitError(Number(payload.error.code ?? 0), String(payload.error.msg ?? 'unknown'), `${method} ${url.pathname}`)
    }
    return payload && typeof payload === 'object' && 'result' in payload ? payload.result : payload
  }

  async loginWithPassword(username, password) {
    const result = await this.request({
      method: 'POST',
      path: 'user/login',
      form: this.loginForm({
        username: String(username),
        password: createHash('md5').update(String(password)).digest('hex'),
      }),
      auth: false,
    })
    const session = result?.session
    if (!session?.id) throw new Error('登录响应里没有 session.id')
    const adopted = {
      sessionId: String(session.id),
      userId: String(session.userId ?? ''),
      createdAt: String(session.createdAt ?? ''),
      expiresIn: Number(session.expiresIn ?? 0),
      expiresAt: Date.now() + Number(session.expiresIn ?? 0) * 1000,
      region: String(session.region ?? this.region).toUpperCase(),
      gateway: this.gateway,
      timezone: this.timezone,
      username: String(username),
    }
    this.setSession(adopted)
    return adopted
  }

  async refresh() {
    if (!this.sessionId) throw new Error('没有会话，先登录')
    const result = await this.request({
      method: 'POST',
      path: 'user/refreshsession',
      form: { oldVersion: API_VERSION },
    })
    const session = result?.session
    if (!session?.id) throw new Error('刷新响应里没有 session.id')
    const next = {
      sessionId: String(session.id),
      userId: String(session.userId ?? this.userId),
      createdAt: String(session.createdAt ?? ''),
      expiresIn: Number(session.expiresIn ?? 0),
      expiresAt: Date.now() + Number(session.expiresIn ?? 0) * 1000,
      region: this.region,
      gateway: this.gateway,
      timezone: this.timezone,
      username: this.username,
    }
    this.setSession(next)
    return next
  }

  async listDevices() {
    const families = await this.request({ method: 'GET', path: 'group/family/list' })
    const accounts = Array.isArray(families) ? families : []
    const out = []
    for (const account of accounts) {
      const groupId = String(account.groupId ?? '')
      const owned = Array.isArray(account.deviceList) ? account.deviceList : []
      for (const device of owned) {
        out.push({
          id: String(device.deviceId ?? ''),
          deviceType: String(device.deviceType ?? '').toLowerCase(),
          name: String(device.deviceName ?? ''),
          typeCode: Number(device.typeCode ?? 0),
          typeId: Number(device.type ?? 0),
          groupId,
          shared: false,
        })
      }
      if (owned.length === 0 && groupId) out.push(...(await this.listSharedDevices(groupId)))
    }
    return out.filter((device) => device.id && device.deviceType)
  }

  async listSharedDevices(groupId) {
    const result = await this.request({
      method: 'POST',
      path: 'discovery/device_roster_v2',
      form: { day: todayIn(this.timezone), groupId },
    })
    const devices = Array.isArray(result?.devices) ? result.devices : []
    return devices
      .filter((device) => device.id !== undefined && device.id !== null)
      .map((device) => ({
        id: String(device.id),
        deviceType: String(device.type ?? '').toLowerCase(),
        name: String(device.deviceTypeAndId ?? device.type ?? ''),
        typeCode: Number(device.typeCode ?? 0),
        typeId: Number(device.deviceTypeId ?? 0),
        groupId: String(groupId),
        shared: true,
      }))
  }

  async detail(device) {
    return this.request({
      method: 'POST',
      path: `${device.deviceType}/device_detail`,
      form: { id: device.id },
    })
  }

  async records(device, day = todayIn(this.timezone)) {
    return this.request({
      method: 'POST',
      path: `${device.deviceType}/getDeviceRecord`,
      params: { days: day, deviceId: device.id },
    })
  }

  async feedPlan(device) {
    return this.request({
      method: 'POST',
      path: `${device.deviceType}/feed`,
      params: { deviceId: device.id },
    })
  }

  async manualFeed(device, amount) {
    if (!MANUAL_FEED_VALUES.includes(Number(amount))) {
      throw new RangeError(`D4H 手动出粮只能是 ${MANUAL_FEED_VALUES.join(' / ')}，收到 ${amount}`)
    }
    return this.request({
      method: 'POST',
      path: `${device.deviceType}/saveDailyFeed`,
      form: {
        day: todayIn(this.timezone),
        deviceId: device.id,
        name: '',
        time: '-1',
        amount: String(amount),
      },
    })
  }

  async removeDailyFeed(device, day, feedTime) {
    return this.dailyFeedChange(device, day, 'removeDailyFeed', feedTime)
  }

  async restoreDailyFeed(device, day, feedTime) {
    return this.dailyFeedChange(device, day, 'restoreDailyFeed', feedTime)
  }

  dailyFeedChange(device, day, action, feedTime) {
    const seconds = Number(feedTime)
    if (!Number.isInteger(seconds) || seconds < 0 || seconds >= 86400) {
      throw new RangeError(`停/恢复餐的时间必须是 0..86399 秒，收到 ${feedTime}`)
    }
    return this.request({
      method: 'POST',
      path: `${device.deviceType}/${action}`,
      form: { day, deviceId: device.id, id: `s${seconds}` },
    })
  }
}

export { API_VERSION, DEFAULT_REGION, DEFAULT_TIMEZONE }
