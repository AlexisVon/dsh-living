/**
 * dsh-living-protocol —— WorldGem 的契约层
 *
 * 这里只有"能算什么、不能算什么"的规则，没有任何宿主依赖。
 * 宝石作者依赖本包即可，不需要依赖核心。
 */

export const PROTOCOL_VERSION = '0.1.0'

/** 可见性决定审计强度：public/group 强制过限制层（见 ARCHITECTURE §9.2） */
export const VISIBILITY = Object.freeze({
  PRIVATE: 'private',
  PUBLIC: 'public',
  GROUP: 'group',
})

/** 码表在核心，宝石只提供文案 —— 这样跨宝石可聚合、可统一决定是否重试 */
export const FAILURE_CODES = Object.freeze({
  PROVIDER_AUTH: 'provider_auth',
  PROVIDER_QUOTA: 'provider_quota',
  PROVIDER_RATE: 'provider_rate',
  PROVIDER_TIMEOUT: 'provider_timeout',
  GEM_UNAVAILABLE: 'gem_unavailable',
  GEM_COOKIE_EXPIRED: 'gem_cookie_expired',
  BROWSER_LAUNCH_FAILED: 'browser_launch_failed',
  DB_LOCKED: 'db_locked',
  DB_CORRUPT: 'db_corrupt',
  CONFIG_INVALID: 'config_invalid',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  CONTEXT_GUARD: 'context_guard',
  WINDOW_CLOSED: 'window_closed',
  INTERRUPTED: 'interrupted',
  UNKNOWN: 'unknown',
})

/** 认证/配额/配置类失败重试无益，只会白烧额度（DECISIONS D-25） */
const NON_RETRYABLE = new Set([
  FAILURE_CODES.PROVIDER_AUTH,
  FAILURE_CODES.PROVIDER_QUOTA,
  FAILURE_CODES.GEM_COOKIE_EXPIRED,
  FAILURE_CODES.CONFIG_INVALID,
  FAILURE_CODES.BUDGET_EXHAUSTED,
  FAILURE_CODES.WINDOW_CLOSED,
  FAILURE_CODES.DB_CORRUPT,
  FAILURE_CODES.INTERRUPTED,
])

export const CHANNEL_OPS = Object.freeze(['ingest', 'outbox', 'ack'])

/** Gem config UI field types: a finite set so the renderer never grows case-by-case. */
export const CONFIG_FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'boolean', 'select', 'list'])
export const CONFIG_ITEM_TYPES = Object.freeze(['string', 'number'])
const CONFIG_FIELD_KEYS = new Set([
  'key', 'label', 'type', 'default', 'help', 'placeholder', 'unit',
  'min', 'max', 'step', 'required', 'group', 'options', 'itemType',
])
const CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const INGEST_KINDS = Object.freeze(['message', 'notice', 'change'])

/** ring=收到就立即 wake 一轮；silent=只落事件，等下一轮顺带处理（手机通知模型） */
export const NOTIFY_MODES = Object.freeze(['ring', 'silent'])

export const ENDPOINTS = Object.freeze({
  ingest: '/living/ingest',
  outbox: '/living/outbox',
  ack: (id) => `/living/outbox/${encodeURIComponent(id)}/ack`,
})

/** 判断一个失败码是否值得重试；未知码按可重试处理（宁可试一次，不可静默放弃） */
export function isRetryable(code) {
  return !NON_RETRYABLE.has(code)
}

/** 类型化错误：调用方按 code 分支，不解析文案 */
export class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.details = details ?? {}
  }
}

export const ERR = Object.freeze({
  MANIFEST_INVALID: 'manifest_invalid',
  INGEST_INVALID: 'ingest_invalid',
  ACK_INVALID: 'ack_invalid',
})

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i

function push(errors, path, message) {
  errors.push({ path, message })
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0
}

function validateNotifyPolicy(policy, path, errors) {
  if (!isPlainObject(policy)) {
    push(errors, path, '通知策略必须是对象')
    return
  }
  for (const key of Object.keys(policy)) {
    if (key !== 'mode' && key !== 'budget') {
      push(errors, `${path}.${key}`, '未知字段（允许 mode / budget）')
    }
  }
  if (policy.mode !== undefined && !NOTIFY_MODES.includes(policy.mode)) {
    push(errors, `${path}.mode`, `mode 必须是 ${NOTIFY_MODES.join(' / ')}`)
  }
  if (policy.budget === undefined) return
  if (!isPlainObject(policy.budget)) {
    push(errors, `${path}.budget`, 'budget 必须是对象')
    return
  }
  for (const key of Object.keys(policy.budget)) {
    if (key !== 'limit' && key !== 'count') {
      push(errors, `${path}.budget.${key}`, '未知字段（允许 limit / count）')
    }
  }
  for (const key of ['limit', 'count']) {
    if (policy.budget[key] !== undefined && typeof policy.budget[key] !== 'boolean') {
      push(errors, `${path}.budget.${key}`, '必须是布尔值')
    }
  }
}

/**
 * 校验一份 worldgem.json。
 * 返回 { ok, errors } 而不是抛错 —— 加载器要在设置页列出所有问题，而不是只报第一个。
 */
export function validateWorldGem(manifest) {
  const errors = []

  if (!isPlainObject(manifest)) {
    push(errors, '', 'manifest 必须是对象')
    return { ok: false, errors }
  }

  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) {
    push(errors, 'id', 'id 必须是小写字母开头、只含 a-z0-9-、长度 2–32')
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    push(errors, 'name', 'name 不能为空')
  }
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    push(errors, 'version', 'version 必须是 semver（如 0.1.0）')
  }

  const hasMcp = manifest.mcp !== undefined
  const hasEvent = manifest.event !== undefined
  const hasSkill = manifest.skill !== undefined
  if (!hasMcp && !hasEvent && !hasSkill) {
    push(errors, '', '至少要有 mcp / event / skill 中的一件')
  }

  if (hasMcp) {
    if (!isPlainObject(manifest.mcp)) {
      push(errors, 'mcp', 'mcp 必须是对象')
    } else {
      if (typeof manifest.mcp.command !== 'string' || manifest.mcp.command === '') {
        push(errors, 'mcp.command', 'mcp.command 不能为空')
      }
      if (manifest.mcp.args !== undefined && !Array.isArray(manifest.mcp.args)) {
        push(errors, 'mcp.args', 'mcp.args 必须是数组')
      }
      if (manifest.mcp.tools !== undefined && !Array.isArray(manifest.mcp.tools)) {
        push(errors, 'mcp.tools', 'mcp.tools 必须是数组')
      }
    }
  }

  if (manifest.channel !== undefined) {
    const ch = manifest.channel
    if (!isPlainObject(ch)) {
      push(errors, 'channel', 'channel 必须是对象')
    } else {
      if (typeof ch.command !== 'string' || ch.command === '') {
        push(errors, 'channel.command', 'channel.command 不能为空')
      }
      if (ch.args !== undefined && (!Array.isArray(ch.args) || ch.args.some((arg) => typeof arg !== 'string'))) {
        push(errors, 'channel.args', 'channel.args 必须是字符串数组')
      }
    }
    if (!hasEvent) push(errors, 'channel', 'channel 需要同时声明 event（它就是事件通道进程）')
  }

  if (hasEvent) {
    const ev = manifest.event
    if (!isPlainObject(ev)) {
      push(errors, 'event', 'event 必须是对象')
    } else {
      const ops = ev.protocol
      if (!Array.isArray(ops) || ops.length === 0) {
        push(errors, 'event.protocol', 'event.protocol 必须是非空数组')
      } else {
        for (const op of ops) {
          if (!CHANNEL_OPS.includes(op)) {
            push(errors, 'event.protocol', `未知操作 ${String(op)}（允许 ${CHANNEL_OPS.join(' / ')}）`)
          }
        }
        if (!ops.includes('ingest')) {
          push(errors, 'event.protocol', '声明了 event 就必须支持 ingest')
        }
      }
      if (!Object.values(VISIBILITY).includes(ev.visibility)) {
        push(errors, 'event.visibility', `visibility 必须是 ${Object.values(VISIBILITY).join(' / ')}`)
      }
    }
  }

  if (hasSkill) {
    if (typeof manifest.skill !== 'string' || manifest.skill === '') {
      push(errors, 'skill', 'skill 必须是文件相对路径')
    }
  }

  if (manifest.notify !== undefined) {
    if (!hasEvent) push(errors, 'notify', 'notify 需要同时声明 event（没有推送就没有通知）')
    if (!isPlainObject(manifest.notify)) {
      push(errors, 'notify', 'notify 必须是对象')
    } else {
      for (const key of Object.keys(manifest.notify)) {
        if (key !== 'push' && key !== 'trusted') {
          push(errors, `notify.${key}`, '未知通知对象（允许 push / trusted）')
        }
      }
      for (const [key, policy] of Object.entries(manifest.notify)) {
        validateNotifyPolicy(policy, `notify.${key}`, errors)
      }
    }
  }

  if (manifest.capabilities !== undefined) {
    if (!isPlainObject(manifest.capabilities)) {
      push(errors, 'capabilities', 'capabilities 必须是对象')
    } else {
      for (const [k, v] of Object.entries(manifest.capabilities)) {
        if (typeof v !== 'boolean') push(errors, `capabilities.${k}`, '能力开关必须是布尔值')
      }
    }
  }

  if (manifest.limits !== undefined) {
    if (!isPlainObject(manifest.limits)) {
      push(errors, 'limits', 'limits 必须是对象')
    } else {
      for (const [k, v] of Object.entries(manifest.limits)) {
        if (!isPositiveInt(v)) push(errors, `limits.${k}`, '限制值必须是正整数')
      }
    }
  }

  if (manifest.etiquette !== undefined) {
    if (!Array.isArray(manifest.etiquette) || manifest.etiquette.some((s) => typeof s !== 'string')) {
      push(errors, 'etiquette', 'etiquette 必须是字符串数组')
    }
  }

  if (manifest.failure_hints !== undefined) {
    if (!isPlainObject(manifest.failure_hints)) {
      push(errors, 'failure_hints', 'failure_hints 必须是对象')
    } else {
      for (const k of Object.keys(manifest.failure_hints)) {
        if (!Object.values(FAILURE_CODES).includes(k)) {
          push(errors, `failure_hints.${k}`, `未知失败码 ${k}`)
        }
      }
    }
  }

  if (manifest.config !== undefined) validateConfigDeclaration(manifest.config, errors)

  return { ok: errors.length === 0, errors }
}

/** Validate the gem-declared config UI (the renderer's only source of field metadata). */
function validateConfigDeclaration(config, errors) {
  if (!isPlainObject(config)) {
    push(errors, 'config', 'config 必须是对象')
    return
  }
  for (const key of Object.keys(config)) {
    if (key !== 'fields') push(errors, `config.${key}`, '未知字段（只允许 fields）')
  }
  if (!Array.isArray(config.fields)) {
    push(errors, 'config.fields', 'config.fields 必须是数组')
    return
  }
  const seen = new Set()
  config.fields.forEach((field, index) => validateConfigField(field, `config.fields[${index}]`, seen, errors))
}

function validateConfigField(field, path, seen, errors) {
  if (!isPlainObject(field)) {
    push(errors, path, '配置字段必须是对象')
    return
  }
  for (const key of Object.keys(field)) {
    if (!CONFIG_FIELD_KEYS.has(key)) push(errors, `${path}.${key}`, '未知字段属性')
  }
  if (typeof field.key !== 'string' || !CONFIG_KEY_RE.test(field.key)) {
    push(errors, `${path}.key`, 'key 必须是标识符（字母/数字/下划线，不以数字开头）')
  } else if (seen.has(field.key)) {
    push(errors, `${path}.key`, `重复的 key: ${field.key}`)
  } else {
    seen.add(field.key)
  }
  if (typeof field.label !== 'string' || field.label.trim() === '') push(errors, `${path}.label`, 'label 不能为空')
  if (!CONFIG_FIELD_TYPES.includes(field.type)) {
    push(errors, `${path}.type`, `type 必须是 ${CONFIG_FIELD_TYPES.join(' / ')}`)
    return
  }
  for (const key of ['help', 'placeholder', 'unit', 'group']) {
    if (field[key] !== undefined && typeof field[key] !== 'string') push(errors, `${path}.${key}`, `${key} 必须是字符串`)
  }
  if (field.required !== undefined && typeof field.required !== 'boolean') {
    push(errors, `${path}.required`, 'required 必须是布尔值')
  }

  if (field.type === 'number') {
    for (const key of ['min', 'max', 'step']) {
      if (field[key] !== undefined && !Number.isFinite(field[key])) push(errors, `${path}.${key}`, `${key} 必须是数字`)
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      push(errors, `${path}.min`, 'min 不能大于 max')
    }
    if (field.step !== undefined && field.step <= 0) push(errors, `${path}.step`, 'step 必须大于 0')
    if (field.default !== undefined && !Number.isFinite(field.default)) {
      push(errors, `${path}.default`, 'number 字段的 default 必须是数字')
    }
  } else if (field.type === 'boolean') {
    if (field.default !== undefined && typeof field.default !== 'boolean') {
      push(errors, `${path}.default`, 'boolean 字段的 default 必须是布尔值')
    }
  } else if (field.type === 'select') {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      push(errors, `${path}.options`, 'select 字段必须提供非空 options')
    } else {
      const values = []
      field.options.forEach((option, index) => {
        if (!isPlainObject(option)) {
          push(errors, `${path}.options[${index}]`, 'option 必须是对象')
          return
        }
        if (typeof option.value !== 'string' || option.value === '') push(errors, `${path}.options[${index}].value`, 'value 不能为空')
        if (typeof option.label !== 'string' || option.label === '') push(errors, `${path}.options[${index}].label`, 'label 不能为空')
        values.push(option.value)
      })
      if (field.default !== undefined && !values.includes(field.default)) {
        push(errors, `${path}.default`, 'select 字段的 default 必须是某个 option.value')
      }
    }
  } else if (field.type === 'list') {
    if (field.itemType !== undefined && !CONFIG_ITEM_TYPES.includes(field.itemType)) {
      push(errors, `${path}.itemType`, `itemType 必须是 ${CONFIG_ITEM_TYPES.join(' / ')}`)
    }
    if (field.default !== undefined) {
      const itemType = field.itemType ?? 'string'
      const bad = !Array.isArray(field.default)
        || field.default.some((item) => (itemType === 'number' ? !Number.isFinite(item) : typeof item !== 'string'))
      if (bad) push(errors, `${path}.default`, `list 字段的 default 必须是 ${itemType} 数组`)
    }
  } else if (field.default !== undefined && typeof field.default !== 'string') {
    push(errors, `${path}.default`, `${field.type} 字段的 default 必须是字符串`)
  }
}

/**
 * Validate user-submitted values against the declared fields. Unknown keys are
 * allowed (preserved by the writer) so gem configs may carry private extras.
 */
export function validateGemConfigValues(fields, config) {
  const errors = []
  if (!Array.isArray(fields)) return { ok: true, errors }
  if (!isPlainObject(config)) {
    push(errors, 'config', '配置必须是对象')
    return { ok: false, errors }
  }
  for (const field of fields) {
    const value = config[field.key]
    const path = `config.${field.key}`
    if (value === undefined || value === null) {
      if (field.required === true) push(errors, path, '必填')
      continue
    }
    if (field.type === 'text' || field.type === 'textarea') {
      if (typeof value !== 'string') push(errors, path, '必须是字符串')
      else if (field.required === true && value.trim() === '') push(errors, path, '必填')
    } else if (field.type === 'number') {
      if (!Number.isFinite(value)) push(errors, path, '必须是数字')
      else if (field.min !== undefined && value < field.min) push(errors, path, `不能小于 ${field.min}`)
      else if (field.max !== undefined && value > field.max) push(errors, path, `不能大于 ${field.max}`)
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') push(errors, path, '必须是布尔值')
    } else if (field.type === 'select') {
      if (typeof value !== 'string') push(errors, path, '必须是字符串')
      else if (!(field.options ?? []).some((option) => option.value === value)) push(errors, path, '不是合法的选项值')
    } else if (field.type === 'list') {
      const itemType = field.itemType ?? 'string'
      if (!Array.isArray(value)) push(errors, path, '必须是数组')
      else if (value.some((item) => (itemType === 'number' ? !Number.isFinite(item) : typeof item !== 'string'))) {
        push(errors, path, `数组元素必须是 ${itemType}`)
      } else if (field.required === true && value.length === 0) push(errors, path, '至少一项')
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 规范化一条入站事件。
 *
 * external_id 必填且去重 —— 长轮询会重投，没有去重就会把同一句话处理两遍。
 */
export function normalizeIngest(payload) {
  const e = []
  if (!isPlainObject(payload)) {
    throw new ProtocolError(ERR.INGEST_INVALID, 'payload 必须是对象')
  }
  if (typeof payload.gem !== 'string' || payload.gem === '') push(e, 'gem', 'gem 不能为空')
  if (!INGEST_KINDS.includes(payload.kind)) push(e, 'kind', `kind 必须是 ${INGEST_KINDS.join(' / ')}`)
  if (typeof payload.external_id !== 'string' || payload.external_id === '') {
    push(e, 'external_id', 'external_id 必填（去重键）')
  }
  if (!isPlainObject(payload.from) || typeof payload.from.id !== 'string' || payload.from.id === '') {
    push(e, 'from.id', 'from.id 不能为空')
  }
  if (payload.kind === 'message' && (typeof payload.text !== 'string' || payload.text === '')) {
    push(e, 'text', 'kind=message 时 text 不能为空')
  }
  if (payload.ts !== undefined && !Number.isFinite(payload.ts)) {
    push(e, 'ts', 'ts 必须是数字（秒或毫秒均可，由调用方统一）')
  }
  if (e.length > 0) {
    throw new ProtocolError(ERR.INGEST_INVALID, `入站事件不合法：${e.map((x) => x.path).join(', ')}`, {
      errors: e,
    })
  }

  return {
    gem: payload.gem,
    kind: payload.kind,
    external_id: payload.external_id,
    from: { id: payload.from.id, name: payload.from.name ?? '' },
    text: payload.text ?? '',
    ts: payload.ts ?? null,
    meta: isPlainObject(payload.meta) ? payload.meta : {},
  }
}

/** 校验出站回执；ack 前不删、超时重投，所以回执必须明确成败 */
export function validateAck(body) {
  if (!isPlainObject(body)) {
    throw new ProtocolError(ERR.ACK_INVALID, '回执必须是对象')
  }
  if (typeof body.ok !== 'boolean') {
    throw new ProtocolError(ERR.ACK_INVALID, 'ack.ok 必须是布尔值', { path: 'ok' })
  }
  if (body.ok === false && body.code !== undefined && !Object.values(FAILURE_CODES).includes(body.code)) {
    throw new ProtocolError(ERR.ACK_INVALID, `unknown failure code: ${body.code}`, { path: 'code' })
  }
  let quota = null
  if (body.quota !== undefined) {
    if (!isPlainObject(body.quota)) {
      throw new ProtocolError(ERR.ACK_INVALID, 'ack.quota 必须是对象', { path: 'quota' })
    }
    const { day, cap, sent } = body.quota
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new ProtocolError(ERR.ACK_INVALID, 'ack.quota.day 必须是 YYYY-MM-DD', { path: 'quota.day' })
    }
    if (!Number.isFinite(cap) || cap < 0 || !Number.isFinite(sent) || sent < 0) {
      throw new ProtocolError(ERR.ACK_INVALID, 'ack.quota.cap/sent 必须是非负数', { path: 'quota' })
    }
    quota = { day, cap: Math.trunc(cap), sent: Math.trunc(sent) }
  }
  return { ok: body.ok, code: body.code ?? null, external_id: body.external_id ?? null, quota }
}
