import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sanitizeText, splitText } from './text.mjs'
import { classifyMedia, sanitizeFileName, uploadMedia } from './media.mjs'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const CHANNEL_VERSION = '1.0.2'
const SESSION_EXPIRED = -14

const MESSAGE_TYPE = { NONE: 0, USER: 1, BOT: 2 }
const MESSAGE_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 }
const ITEM_TYPE = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }
const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }

export class IlinkError extends Error {
  constructor(endpoint, ret, errcode, errmsg) {
    const status = ret !== undefined ? `ret=${ret}` : `errcode=${errcode}`
    super(`${endpoint}: ${status}${errmsg ? ` ${errmsg}` : ''}`)
    this.name = 'IlinkError'
    this.endpoint = endpoint
    this.ret = ret
    this.errcode = errcode
    this.errmsg = errmsg
  }
}

export class SessionTimeoutError extends Error {
  constructor(message = 'session timeout') {
    super(message)
    this.name = 'SessionTimeoutError'
  }
}

export function isSessionTimeout(error) {
  return error instanceof SessionTimeoutError
}

export function isMessageLimit(error) {
  return (
    error instanceof IlinkError &&
    (error.ret === -2 || error.errcode === -2) &&
    String(error.errmsg ?? '').toLowerCase() === 'prepare failed'
  )
}

export function isWindowClosed(error) {
  return error instanceof IlinkError && /window|24\s*hour|互动窗口|窗口/i.test(String(error.errmsg ?? ''))
}

function randomUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

function headers(token) {
  const value = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
  }
  if (token?.trim()) value.Authorization = `Bearer ${token.trim()}`
  return value
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION }
}

function isNetworkError(error) {
  return error?.name !== 'IlinkError' && error?.name !== 'SessionTimeoutError'
}

async function apiPost({
  baseUrl,
  endpoint,
  body,
  token,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  retries = 2,
  allowTimeout = false,
}) {
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ ...body, base_info: baseInfo() }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      const parsed = text.trim() ? JSON.parse(text) : {}
      if (parsed.errcode === SESSION_EXPIRED || parsed.ret === SESSION_EXPIRED) {
        throw new SessionTimeoutError(parsed.errmsg || 'session timeout')
      }
      return parsed
    } catch (error) {
      if ((error.name === 'TimeoutError' || error.name === 'AbortError') && allowTimeout) return { ret: 0, msgs: [] }
      lastError = error
      if (error instanceof SessionTimeoutError || !isNetworkError(error) || attempt === retries) break
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
    }
  }
  throw lastError
}

async function apiGet({ baseUrl, path, token, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${path}`, {
    method: 'GET',
    headers: headers(token),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  return text.trim() ? JSON.parse(text) : {}
}

export async function getUpdates({ baseUrl = DEFAULT_BASE_URL, token, buf = '', fetchImpl = fetch, timeoutMs = 38_000 } = {}) {
  const response = await apiPost({
    baseUrl,
    endpoint: 'ilink/bot/getupdates',
    body: { get_updates_buf: buf },
    token,
    fetchImpl,
    timeoutMs,
    retries: 0,
    allowTimeout: true,
  })
  if ((typeof response.ret === 'number' && response.ret !== 0) || (typeof response.errcode === 'number' && response.errcode !== 0)) {
    throw new IlinkError('ilink/bot/getupdates', response.ret, response.errcode, response.errmsg)
  }
  return response
}

export async function notifyStart({ baseUrl = DEFAULT_BASE_URL, token, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  return apiPost({ baseUrl, endpoint: 'ilink/bot/msg/notifystart', body: {}, token, fetchImpl, timeoutMs, retries: 0 })
}

export async function notifyStop({ baseUrl = DEFAULT_BASE_URL, token, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  return apiPost({ baseUrl, endpoint: 'ilink/bot/msg/notifystop', body: {}, token, fetchImpl, timeoutMs, retries: 0 })
}

export async function sendText({ baseUrl = DEFAULT_BASE_URL, token, to, text, contextToken = null, fetchImpl = fetch } = {}) {
  const clientId = `living-wechat-${randomUUID()}`
  const response = await apiPost({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    token,
    fetchImpl,
    retries: 2,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: MESSAGE_TYPE.BOT,
        message_state: MESSAGE_STATE.FINISH,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: sanitizeText(text) } }],
      },
    },
  })
  const rejected = (typeof response.ret === 'number' && response.ret !== 0) || (typeof response.errcode === 'number' && response.errcode !== 0)
  if (rejected) throw new IlinkError('ilink/bot/sendmessage', response.ret, response.errcode, response.errmsg)
  return { externalId: String(response.message_id ?? clientId) }
}

export async function getUploadUrl({ baseUrl = DEFAULT_BASE_URL, token, body, fetchImpl = fetch } = {}) {
  return apiPost({
    baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    token,
    fetchImpl,
    retries: 2,
    body,
  })
}

/** Encrypt, upload to CDN, then send one image/file bubble. */
export async function sendMedia({
  baseUrl = DEFAULT_BASE_URL,
  cdnBaseUrl = DEFAULT_CDN_BASE_URL,
  token,
  to,
  buffer,
  fileName = 'file',
  kind = null,
  contextToken = null,
  fetchImpl = fetch,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new RangeError('sendMedia 需要非空 buffer')
  const clientId = randomBytes(16).toString('hex')
  const rawSize = buffer.length
  const rawMd5 = createHash('md5').update(buffer).digest('hex')
  const aesKey = randomBytes(16)
  const aesKeyHex = aesKey.toString('hex')
  const encryptedSize = Math.ceil((rawSize + 1) / 16) * 16
  const mediaType = classifyMedia(fileName, kind) === 'image' ? UPLOAD_MEDIA_TYPE.IMAGE : UPLOAD_MEDIA_TYPE.FILE
  const upload = await getUploadUrl({
    baseUrl,
    token,
    fetchImpl,
    body: {
      filekey: clientId,
      media_type: mediaType,
      to_user_id: to,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: encryptedSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    },
  })
  if (!upload?.upload_param) {
    throw new IlinkError('ilink/bot/getuploadurl', upload?.ret, upload?.errcode, upload?.errmsg ?? 'missing upload_param')
  }
  const uploaded = await uploadMedia({
    buffer,
    aesKey,
    uploadParam: upload.upload_param,
    filekey: clientId,
    cdnBaseUrl,
    uploadUrl: upload.upload_full_url ?? null,
    fetchImpl,
  })
  const cdnMedia = {
    encrypt_query_param: uploaded.encryptQueryParam,
    aes_key: Buffer.from(aesKeyHex).toString('base64'),
    encrypt_type: 1,
  }
  const item = mediaType === UPLOAD_MEDIA_TYPE.IMAGE
    ? {
        type: ITEM_TYPE.IMAGE,
        image_item: {
          media: cdnMedia,
          aeskey: cdnMedia.aes_key,
          url: cdnMedia.encrypt_query_param,
          mid_size: uploaded.encryptedSize,
        },
      }
    : {
        type: ITEM_TYPE.FILE,
        file_item: {
          media: cdnMedia,
          file_name: sanitizeFileName(fileName),
          len: String(rawSize),
        },
      }
  const response = await apiPost({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    token,
    fetchImpl,
    retries: 2,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: MESSAGE_TYPE.BOT,
        message_state: MESSAGE_STATE.FINISH,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [item],
      },
    },
  })
  const rejected = (typeof response.ret === 'number' && response.ret !== 0) || (typeof response.errcode === 'number' && response.errcode !== 0)
  if (rejected) throw new IlinkError('ilink/bot/sendmessage', response.ret, response.errcode, response.errmsg)
  return { externalId: String(response.message_id ?? clientId) }
}

export async function sendOutbound(message, {
  token,
  boundUserId = null,
  baseUrl = DEFAULT_BASE_URL,
  cdnBaseUrl = DEFAULT_CDN_BASE_URL,
  contextToken = null,
  chunkLimit = 4000,
  media = [],
  fetchImpl = fetch,
} = {}) {
  // Resolve here so a raw target ("me"/"uid:…") can never reach the wire as to_user_id.
  const to = resolveRecipient(message.to, boundUserId)
  if (!to) throw new RangeError('sendOutbound 无法解析收件人：to 为空且没有绑定用户')
  const text = String(message.text ?? '')
  const chunks = text.trim() === '' ? [] : splitText(text, chunkLimit)
  const attachments = Array.isArray(media) ? media : []
  if (chunks.length + attachments.length > 10) {
    throw new IlinkError('ilink/bot/sendmessage', -1, undefined, 'invalid request: message needs more than 10 bubbles')
  }
  if (chunks.length + attachments.length === 0) {
    throw new IlinkError('ilink/bot/sendmessage', -1, undefined, 'invalid request: nothing to send')
  }
  let result = null
  for (const chunk of chunks) {
    result = await sendText({ baseUrl, token, to, text: chunk, contextToken, fetchImpl })
  }
  for (const item of attachments) {
    result = await sendMedia({
      baseUrl,
      cdnBaseUrl,
      token,
      to,
      buffer: item.buffer,
      fileName: item.fileName ?? item.name ?? 'file',
      kind: item.kind ?? null,
      contextToken,
      fetchImpl,
    })
  }
  return result
}

export function resolveRecipient(to, boundUserId) {
  let raw = String(to ?? '').trim()
  if (raw.startsWith('uid:')) raw = raw.slice(4)
  if (!raw || ['me', 'self', 'user', 'owner'].includes(raw) || raw === String(boundUserId)) return String(boundUserId)
  return raw
}

export function describeItem(item) {
  if (item?.type === ITEM_TYPE.IMAGE) return '[图片]'
  if (item?.type === ITEM_TYPE.VOICE) return item.voice_item?.text ? `[语音转写] ${item.voice_item.text}` : '[语音]（无转写，听不清）'
  if (item?.type === ITEM_TYPE.FILE) return `[文件] ${item.file_item?.file_name ?? ''}`.trim()
  if (item?.type === ITEM_TYPE.VIDEO) return '[视频]'
  return '[非文字消息]'
}

/** Image and file items are the only ones worth downloading; voice relies on WeChat's transcript. */
export function mediaItems(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  const out = []
  for (const [index, item] of items.entries()) {
    if (item?.type === ITEM_TYPE.IMAGE && item.image_item?.media) {
      out.push({ index, kind: 'image', media: item.image_item.media, fileName: null })
    } else if (item?.type === ITEM_TYPE.FILE && item.file_item?.media) {
      out.push({ index, kind: 'file', media: item.file_item.media, fileName: item.file_item.file_name ?? null })
    }
  }
  return out
}

export function parseWeixinMessage(message, { attachments = [] } = {}) {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  const parts = []
  const texts = []
  for (const [index, item] of items.entries()) {
    if (item?.type === ITEM_TYPE.TEXT) {
      const value = String(item.text_item?.text ?? '')
      if (value) {
        texts.push(value)
        parts.push(value)
      }
      continue
    }
    const attachment = attachments[index] ?? null
    if (item?.type === ITEM_TYPE.IMAGE) {
      parts.push(attachment?.path ? `[图片] ${attachment.path}` : '[图片]')
    } else if (item?.type === ITEM_TYPE.VOICE) {
      parts.push(item.voice_item?.text ? `[语音转写] ${item.voice_item.text}` : '[语音]（无转写，听不清）')
    } else if (item?.type === ITEM_TYPE.FILE) {
      const name = attachment?.name ?? item.file_item?.file_name ?? ''
      parts.push(attachment?.path ? `[文件: ${name}] ${attachment.path}` : `[文件] ${name}`.trim())
    } else if (item?.type === ITEM_TYPE.VIDEO) {
      parts.push('[视频]')
    } else {
      parts.push('[非文字消息]')
    }
  }
  return {
    text: parts.join('\n').trim(),
    itemTypes: items.map((item) => Number(item?.type) || 0),
    hasText: texts.length > 0,
    attachments: attachments.filter(Boolean),
  }
}

export function inboundEvent(message, { gem = 'wechat', ownerId = null, attachments = [] } = {}) {
  const id = message?.message_id || message?.client_id || message?.seq
  if (!id) throw new Error('iLink 消息缺少 message_id / client_id / seq')
  const parsed = parseWeixinMessage(message, { attachments })
  const from = String(message.from_user_id ?? '')
  return {
    gem,
    kind: 'message',
    external_id: `wx_${id}`,
    from: { id: from, name: '' },
    text: parsed.text || '[空消息]',
    ts: Number(message.create_time_ms) || Date.now(),
    meta: {
      reply_to: 'me',
      session_id: message.session_id ?? '',
      group_id: message.group_id ?? '',
      item_types: parsed.itemTypes,
      attachments: parsed.attachments,
      trusted: String(ownerId ?? '').trim() !== '' && from === String(ownerId),
    },
  }
}

export function isUserMessage(message) {
  return Number(message?.message_type) === MESSAGE_TYPE.USER && Boolean(message?.from_user_id)
}

export async function loginWithQr({
  baseUrl = DEFAULT_BASE_URL,
  botType = '3',
  loginTimeoutMs = 5 * 60_000,
  fetchImpl = fetch,
  render,
  log = console.log,
  onQr = null,
  onStatus = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  let qr = await apiGet({ baseUrl, path: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, fetchImpl })
  if (qr.ret !== undefined && qr.ret !== 0) throw new IlinkError('ilink/bot/get_bot_qrcode', qr.ret, qr.errcode, qr.errmsg)
  if (!qr?.qrcode || !qr?.qrcode_img_content) throw new Error('iLink 二维码接口没有返回 qrcode / qrcode_img_content')
  let expired = 0
  const deadline = now() + loginTimeoutMs
  for (;;) {
    onQr?.(qr.qrcode_img_content)
    onStatus?.('wait')
    log('用微信扫码登录（这是一个独立的 bot，与 dsh-wechat 互不影响）：\n')
    log(render ? render(qr.qrcode_img_content) : qr.qrcode_img_content)
    log(`\n二维码链接：${qr.qrcode_img_content}\n`)
    let scanned = false
    while (now() < deadline) {
      const status = await apiGet({
        baseUrl,
        path: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
        fetchImpl,
      })
      if (status.ret !== undefined && status.ret !== 0) throw new IlinkError('ilink/bot/get_qrcode_status', status.ret, status.errcode, status.errmsg)
      if (status.status === 'confirmed') {
        if (!status.bot_token) throw new Error('iLink 确认状态缺少 bot_token')
        if (!status.ilink_user_id) throw new Error('iLink 确认状态缺少 ilink_user_id')
        onStatus?.('confirmed')
        return {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id ?? '',
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        }
      }
      if (status.status === 'scaned' && !scanned) {
        scanned = true
        onStatus?.('scaned')
        log('已扫码，请在手机上确认登录…')
      }
      if (status.status === 'expired') {
        expired += 1
        onStatus?.('expired')
        if (expired > 3) throw new Error('二维码连续失效，请重新运行登录')
        log(`二维码已失效，刷新（${expired}/3）…`)
        qr = await apiGet({ baseUrl, path: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, fetchImpl })
        break
      }
      await sleep(1500)
    }
    if (now() >= deadline) throw new Error('扫码登录超时（5 分钟）')
  }
}
