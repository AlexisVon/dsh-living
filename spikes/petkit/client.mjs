import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const CHINA_GATEWAY = 'https://api.petkit.cn/6/'
const API_VERSION = '13.2.1'
const DEFAULT_TZ = 'Asia/Shanghai'
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

const ERROR_HINTS = {
  3: '请求参数不完整',
  5: '会话已失效，需要重新登录',
  97: 'App 版本过旧',
  99: '服务端拒绝该请求（可能端点或区域不对）',
  105: '手机号格式不合法',
  106: '邮箱格式不合法',
  122: '认证失败',
  123: '验证码不正确或已过期',
  125: '账号未注册',
  703: '设备不存在',
}

export class PetkitError extends Error {
  constructor(code, message, context = '') {
    const hint = ERROR_HINTS[code] ? `（${ERROR_HINTS[code]}）` : ''
    super(`PetKit ${code}${hint}: ${message}${context ? ` [${context}]` : ''}`)
    this.name = 'PetkitError'
    this.code = code
  }
}

function tzOffsetHours(timezone) {
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
  const body = Object.entries(object).map(([key, value]) => `${scalar(key)}: ${scalar(value)}`)
  return `{${body.join(', ')}}`
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

function todayIn(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}${pick('month')}${pick('day')}`
}

function writePrivate(path, value) {
  const dir = join(path, '..')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

function readJson(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function maskPhone(value) {
  const text = String(value ?? '')
  if (text.length < 7) return text
  return `${text.slice(0, 3)}****${text.slice(-4)}`
}

export class PetkitClient {
  constructor({
    stateDir = join(import.meta.dirname, '.state'),
    timezone = DEFAULT_TZ,
    region = DEFAULT_REGION,
    gateway = CHINA_GATEWAY,
    log = () => {},
  } = {}) {
    this.stateDir = stateDir
    this.timezone = timezone
    this.region = region
    this.gateway = gateway
    this.log = log
    this.sessionPath = join(stateDir, 'session.json')
    this.devicesPath = join(stateDir, 'devices.json')
    this.selectedPath = join(stateDir, 'selected.json')
    this.session = readJson(this.sessionPath)
  }

  saveSession(session) {
    this.session = session
    writePrivate(this.sessionPath, session)
  }

  clearSession() {
    this.session = null
    writePrivate(this.sessionPath, {})
  }

  loadDevices() {
    return readJson(this.devicesPath) ?? []
  }

  saveDevices(devices) {
    writePrivate(this.devicesPath, devices)
  }

  loadSelected() {
    return readJson(this.selectedPath)?.id ?? null
  }

  saveSelected(id) {
    writePrivate(this.selectedPath, { id: String(id) })
  }

  async request({ base = this.gateway, method, path, params, form, auth = true, timeoutMs = 20000 }) {
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    const headers = {
      ...BASE_HEADERS,
      'X-TimezoneId': this.timezone,
      'X-Timezone': tzOffsetHours(this.timezone),
    }
    if (auth && this.session?.sessionId) {
      headers['X-Session'] = this.session.sessionId
      headers['F-Session'] = this.session.sessionId
    }
    const body = form ? new URLSearchParams(form).toString() : undefined
    this.log(`${method} ${url.pathname}${url.search}`)
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let payload
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

  loginForm(extra) {
    return {
      client: clientInfo(this.timezone),
      encrypt: '1',
      region: this.region,
      oldVersion: API_VERSION,
      ...extra,
    }
  }

  async requestCode(username) {
    return this.request({
      method: 'POST',
      path: 'user/sendcodeforquicklogin',
      form: this.loginForm({ username: String(username) }),
      auth: false,
    })
  }

  async loginWithCode(username, code) {
    const result = await this.request({
      method: 'POST',
      path: 'user/login',
      form: this.loginForm({ username: String(username), validCode: String(code) }),
      auth: false,
    })
    return this.adoptSession(result, username)
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
    return this.adoptSession(result, username)
  }

  adoptSession(result, username) {
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
    this.saveSession(adopted)
    return adopted
  }

  async refresh() {
    if (!this.session?.sessionId) throw new Error('没有会话，先登录')
    const result = await this.request({
      method: 'POST',
      path: 'user/refreshsession',
      form: { oldVersion: API_VERSION },
    })
    const session = result?.session
    if (!session?.id) throw new Error('刷新响应里没有 session.id')
    const next = {
      ...this.session,
      sessionId: String(session.id),
      expiresIn: Number(session.expiresIn ?? 0),
      expiresAt: Date.now() + Number(session.expiresIn ?? 0) * 1000,
      createdAt: String(session.createdAt ?? this.session.createdAt),
    }
    this.saveSession(next)
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
          raw: device,
        })
      }
      if (owned.length === 0 && groupId) {
        out.push(...(await this.listSharedDevices(groupId)))
      }
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
        raw: device,
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
    const allowed = [10, 20, 30, 40, 50]
    if (!allowed.includes(Number(amount))) {
      throw new RangeError(`D4H 手动出粮只能是 ${allowed.join(' / ')}，收到 ${amount}`)
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
}

export { CHINA_GATEWAY, DEFAULT_REGION, DEFAULT_TZ, todayIn }
