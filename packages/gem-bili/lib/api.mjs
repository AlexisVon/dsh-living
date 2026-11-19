import { encWbi, keysFromUrls } from './wbi.mjs'

const API = 'https://api.bilibili.com'
const MESSAGE_API = 'https://api.vc.bilibili.com'
const PASSPORT_API = 'https://passport.bilibili.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
const DEV_ID = 'A6716E9A-7CE3-47AF-994B-F0B34178D28D'

export class BiliError extends Error {
  constructor(code, message, { kind = 'api', status = null } = {}) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.kind = kind
    this.status = status
  }
}

export function cookieHeader(cred) {
  if (!cred) return ''
  return Object.entries({
    SESSDATA: cred.sessdata,
    bili_jct: cred.bili_jct,
    buvid3: cred.buvid3,
    buvid4: cred.buvid4,
    DedeUserID: cred.dedeuserid,
  })
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

export function baseHeaders(cred, referer = 'https://www.bilibili.com/') {
  const headers = {
    'User-Agent': UA,
    Referer: referer,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  const cookie = cookieHeader(cred)
  if (cookie) headers.Cookie = cookie
  return headers
}

function authKind(code) {
  if (code === -101 || code === -111) return 'auth'
  if ([352, 412, 509, 799].includes(Number(code))) return 'rate'
  return 'api'
}

export async function requestJson(
  url,
  {
    method = 'GET',
    params = {},
    form = null,
    cred = null,
    fetchImpl = fetch,
    envelope = true,
    referer,
    timeoutMs = 20000,
  } = {},
) {
  const target = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value))
  }
  const headers = baseHeaders(cred, referer)
  let body
  if (form) {
    body = form instanceof URLSearchParams ? form : new URLSearchParams(form)
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  let response
  try {
    response = await fetchImpl(target, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new BiliError('network', `网络请求失败: ${error.message}`, { kind: 'network' })
  }
  const text = await response.text()
  if (!response.ok) {
    throw new BiliError(`http_${response.status}`, `HTTP ${response.status}: ${text.slice(0, 200)}`, {
      kind: response.status === 401 || response.status === 403 ? 'auth' : 'http',
      status: response.status,
    })
  }
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    throw new BiliError('invalid_json', `接口返回不是 JSON: ${text.slice(0, 160)}`, { kind: 'protocol' })
  }
  if (!envelope) return parsed
  if (typeof parsed.code === 'number' && parsed.code !== 0) {
    throw new BiliError(parsed.code, parsed.message || parsed.msg || `B站接口错误 code=${parsed.code}`, {
      kind: authKind(parsed.code),
    })
  }
  return parsed.data ?? null
}

let wbiCache = { keys: null, at: 0 }

export function resetWbiCache() {
  wbiCache = { keys: null, at: 0 }
}

export async function getWbiKeys({ cred = null, fetchImpl = fetch } = {}) {
  if (wbiCache.keys && Date.now() - wbiCache.at < 10 * 60_000) return wbiCache.keys
  const body = await requestJson(`${API}/x/web-interface/nav`, { cred, fetchImpl, envelope: false })
  if (body?.code !== 0 && body?.code !== -101) {
    throw new BiliError(body?.code ?? 'wbi_unavailable', body?.message ?? '无法获取 WBI 密钥', { kind: 'protocol' })
  }
  const keys = keysFromUrls(body?.data?.wbi_img?.img_url, body?.data?.wbi_img?.sub_url)
  if (!keys.imgKey || !keys.subKey) throw new BiliError('wbi_unavailable', '无法获取 WBI 密钥', { kind: 'protocol' })
  wbiCache = { keys, at: Date.now() }
  return keys
}

export async function signedParams(params, opts = {}) {
  const keys = await getWbiKeys(opts)
  return encWbi(params, keys)
}

export function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '')
}

export function mapSearchItem(item) {
  return {
    bvid: item.bvid ?? '',
    aid: Number(item.aid) || 0,
    title: stripHtml(item.title),
    author: item.author ?? '',
    mid: Number(item.mid) || 0,
    pubdate: Number(item.pubdate) || 0,
    duration: item.duration ?? '',
    play: Number(item.play) || 0,
    danmaku: Number(item.video_review) || 0,
    description: stripHtml(item.description),
    url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : (item.arcurl ?? ''),
  }
}

export async function searchVideos(query, { days = 7, limit = 10, order = 'pubdate', cred = null, fetchImpl = fetch } = {}) {
  const pageSize = Math.min(20, Math.max(1, Number(limit) || 10))
  const params = await signedParams(
    { search_type: 'video', keyword: query, page: 1, page_size: pageSize, order },
    { cred, fetchImpl },
  )
  const data = await requestJson(`${API}/x/web-interface/wbi/search/type`, { params, cred, fetchImpl })
  const cutoff = days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0
  return (data?.result ?? [])
    .map(mapSearchItem)
    .filter((item) => item.bvid && (!cutoff || item.pubdate >= cutoff))
    .slice(0, pageSize)
}

export function mapVideo(data) {
  return {
    bvid: data.bvid,
    aid: Number(data.aid) || 0,
    title: data.title ?? '',
    description: data.desc ?? '',
    cover: data.pic ?? '',
    pubdate: Number(data.pubdate) || 0,
    duration: Number(data.duration) || 0,
    owner: { mid: Number(data.owner?.mid) || 0, name: data.owner?.name ?? '' },
    stat: {
      view: Number(data.stat?.view) || 0,
      danmaku: Number(data.stat?.danmaku) || 0,
      reply: Number(data.stat?.reply) || 0,
      like: Number(data.stat?.like) || 0,
    },
    pages: (data.pages ?? []).map((page) => ({
      cid: Number(page.cid) || 0,
      page: Number(page.page) || 0,
      part: page.part ?? '',
      duration: Number(page.duration) || 0,
    })),
    url: `https://www.bilibili.com/video/${data.bvid}`,
  }
}

export async function getVideo(bvid, { cred = null, fetchImpl = fetch } = {}) {
  const data = await requestJson(`${API}/x/web-interface/view`, { params: { bvid }, cred, fetchImpl })
  if (!data?.bvid) throw new BiliError('not_found', `找不到视频 ${bvid}`, { kind: 'not_found' })
  return mapVideo(data)
}

/** Nickname lookup: comment mentions are @nickname text, so UID must be resolved before writing one. */
export async function getUser(uid, { cred = null, fetchImpl = fetch } = {}) {
  if (!/^\d+$/.test(String(uid ?? ''))) throw new BiliError('bad_uid', `uid 不合法: ${uid}`, { kind: 'config' })
  const data = await requestJson(`${API}/x/web-interface/card`, { params: { mid: Number(uid) }, cred, fetchImpl })
  const card = data?.card
  if (!card?.mid) throw new BiliError('not_found', `找不到用户 ${uid}`, { kind: 'not_found' })
  return {
    uid: String(card.mid),
    name: card.name ?? '',
    sign: card.sign ?? '',
    level: Number(card.level_info?.current_level) || 0,
    face: card.face ?? '',
  }
}

export async function getSubtitle(bvid, { page = 1, cred = null, fetchImpl = fetch } = {}) {
  const video = await getVideo(bvid, { cred, fetchImpl })
  const index = Number(page) - 1
  const target = video.pages[index]
  if (!target) throw new BiliError('no_such_page', `视频 ${bvid} 没有第 ${page} 个分P`, { kind: 'not_found' })
  const params = await signedParams({ bvid, cid: target.cid }, { cred, fetchImpl })
  const data = await requestJson(`${API}/x/player/wbi/v2`, { params, cred, fetchImpl })
  const subtitles = data?.subtitle?.subtitles ?? []
  if (subtitles.length === 0) {
    throw new BiliError('no_subtitle', `视频 ${bvid} 没有字幕（分P：${target.part || page}）`, { kind: 'not_found' })
  }
  const chosen = subtitles.find((item) => /中文|zh/i.test(`${item.lan} ${item.lan_doc}`)) ?? subtitles[0]
  const url = String(chosen.subtitle_url ?? '').startsWith('//') ? `https:${chosen.subtitle_url}` : chosen.subtitle_url
  if (!url) throw new BiliError('no_subtitle_url', '字幕元数据没有下载地址', { kind: 'protocol' })
  const body = await requestJson(url, { cred, fetchImpl, envelope: false })
  const segments = (body?.body ?? []).map((segment) => ({
    from: Number(segment.from) || 0,
    to: Number(segment.to) || 0,
    text: String(segment.content ?? '').trim(),
  }))
  const full = segments.map((segment) => segment.text).filter(Boolean).join('\n')
  const limit = 20000
  return {
    bvid,
    page: target.page,
    part: target.part,
    lan: chosen.lan,
    lanDoc: chosen.lan_doc,
    segments,
    text: full.length > limit ? `${full.slice(0, limit)}\n…（字幕过长，已截断）` : full,
    truncated: full.length > limit,
  }
}

export async function getComments(bvid, { limit = 10, cred = null, fetchImpl = fetch } = {}) {
  const video = await getVideo(bvid, { cred, fetchImpl })
  const data = await requestJson(`${API}/x/v2/reply`, {
    params: { type: 1, oid: video.aid, sort: 2, ps: Math.min(20, Math.max(1, Number(limit) || 10)), pn: 1 },
    cred,
    fetchImpl,
  })
  return (data?.replies ?? []).map((reply) => mapComment(reply, { oid: video.aid, bvid }))
}

export async function getReplies({ oid, root, limit = 10, cred = null, fetchImpl = fetch } = {}) {
  const data = await requestJson(`${API}/x/v2/reply/reply`, {
    params: {
      type: 1,
      oid: Number(oid),
      root: Number(root),
      ps: Math.min(20, Math.max(1, Number(limit) || 10)),
      pn: 1,
    },
    cred,
    fetchImpl,
  })
  return (data?.replies ?? []).map((reply) => mapComment(reply, { oid: Number(oid), root: Number(root) }))
}

function mapComment(reply, { oid, bvid = '', root = null } = {}) {
  const rpid = Number(reply.rpid) || 0
  const rootId = Number(reply.root) || Number(root) || rpid
  const parent = Number(reply.parent) || rootId
  const videoUrl = bvid ? `https://www.bilibili.com/video/${bvid}#reply${rpid}` : ''
  return {
    rpid,
    root: rootId,
    parent,
    mid: Number(reply.mid) || 0,
    author: reply.member?.uname ?? '',
    text: reply.content?.message ?? '',
    like: Number(reply.like) || 0,
    replies: Number(reply.rcount) || 0,
    ts: Number(reply.ctime) || 0,
    oid: Number(oid) || 0,
    url: videoUrl,
    replyTo: rpid > 0 && oid > 0 ? `reply:${oid}:${rootId}:${rpid}` : null,
  }
}

export async function getDynamics({ limit = 10, cred = null, fetchImpl = fetch } = {}) {
  const data = await requestJson(`${API}/x/polymer/web-dynamic/v1/feed/all`, {
    params: { type: 'video', page: 1, offset: '' },
    cred,
    fetchImpl,
  })
  return (data?.items ?? []).slice(0, Math.min(20, Math.max(1, Number(limit) || 10))).map((item) => {
    const author = item.modules?.module_author ?? {}
    const dynamic = item.modules?.module_dynamic ?? {}
    const major = dynamic.major ?? {}
    const archive = major.archive ?? {}
    const bvid = archive.bvid ?? ''
    return {
      id: item.id_str ?? String(item.id ?? ''),
      type: item.type ?? '',
      author: author.name ?? '',
      mid: String(author.mid ?? ''),
      text: dynamic.desc?.text ?? '',
      title: archive.title ?? major.opus?.title ?? '',
      bvid,
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
      publishedAt: Number(author.pub_ts) || 0,
    }
  })
}

export function mapMsgfeedItem(item, kind) {
  const user = Array.isArray(item.users) ? (item.users[0] ?? {}) : (item.user ?? item.users ?? {})
  const detail = item.item ?? {}
  const rpid = Number(detail.rpid) || Number(detail.target_id) || Number(detail.source_id) || Number(item.rpid) || Number(item.id) || 0
  const oid = Number(detail.oid ?? detail.subject_id ?? detail.business_id ?? item.oid ?? item.subject_id) || 0
  const rootId = Number(detail.root_id ?? item.root_id) || rpid
  const timestamp = Number(item.at_time ?? item.reply_time ?? item.timestamp) || 0
  const ts = timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp
  const uri = detail.uri ?? item.uri ?? ''
  // Only video comments have a known reply API in v1; dynamic/article comments would post to the wrong type.
  const replyable = /\/video\//.test(uri) && oid > 0 && rpid > 0
  return {
    id: String(item.id || `${kind}_${timestamp}_${user.mid ?? ''}`),
    kind,
    uid: String(user.mid ?? ''),
    name: user.nickname ?? '',
    title: detail.title ?? item.title ?? '',
    text: String(detail.source_content ?? detail.title ?? item.title ?? ''),
    uri,
    ts,
    oid,
    rpid,
    rootId,
    replyTo: replyable ? `reply:${oid}:${rootId}:${rpid}` : null,
  }
}

export async function getMsgfeed(kind, { cred = null, fetchImpl = fetch } = {}) {
  const path = kind === 'at' ? '/x/msgfeed/at' : '/x/msgfeed/reply'
  const data = await requestJson(`${API}${path}`, {
    params: { build: 0, mobi_app: 'web', platform: 'web', web_location: 333.999 },
    cred,
    fetchImpl,
  })
  return (data?.items ?? []).map((item) => mapMsgfeedItem(item, kind))
}

/**
 * System notices arrive as {"title":"…","text":"…"}; a real chat message carries {"content":"…"}.
 * Judging by the payload shape, not by uid — newer real accounts also have huge uids.
 */
export function isSystemDm(message) {
  const type = Number(message?.msg_type) || 1
  if (type === 7 || type === 8) return false
  let parsed
  try {
    parsed = JSON.parse(message?.content ?? '')
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  return typeof parsed.title === 'string' && parsed.content === undefined
}

export function parseDmContent(message) {
  const type = Number(message.msg_type) || 1
  let parsed = null
  try {
    parsed = JSON.parse(message.content ?? '{}')
  } catch {
    return String(message.content ?? '[非文字消息]')
  }
  if (type === 7 || type === 8) {
    const bvid = parsed.bvid || String(parsed.jump_url ?? '').match(/BV[0-9A-Za-z]{10}/)?.[0] || ''
    return `[分享视频] ${String(parsed.title ?? parsed.desc ?? '(无标题)').slice(0, 80)}${parsed.author ? ` / ${parsed.author}` : ''}${bvid ? ` ${bvid}` : ''}`
  }
  if (type === 2) return '[图片]'
  if (type === 5) return '[撤回消息]'
  return String(parsed.content ?? parsed.text ?? '[非文字消息]')
}

export function mapDmMessages(messages, { selfUid } = {}) {
  return (messages ?? [])
    .map((message, index) => ({
      key: String(message.msg_key || message.msg_seqno || `${message.timestamp}_${index}`),
      ts: Number(message.timestamp) || 0,
      fromMe: String(message.sender_uid ?? '') === String(selfUid ?? ''),
      text: parseDmContent(message),
      rawType: Number(message.msg_type) || 1,
      system: isSystemDm(message),
    }))
    .reverse()
}

export async function listDmSessions({ cred = null, fetchImpl = fetch } = {}) {
  const data = await requestJson(`${MESSAGE_API}/session_svr/v1/session_svr/get_sessions`, {
    params: { session_type: 1, group_id: 0, Build: 0, mobi_app: 'web' },
    cred,
    fetchImpl,
    referer: 'https://message.bilibili.com/',
  })
  return (data?.session_list ?? [])
    .map((session) => ({
      uid: String(session.talker_id ?? ''),
      unread: Number(session.unread_count) || 0,
      lastTs: Number(session.last_msg?.timestamp) || 0,
      preview: session.last_msg ? parseDmContent(session.last_msg).slice(0, 80) : '',
    }))
    .filter((session) => session.uid)
}

export async function fetchDmMessages(talkerId, { size = 20, cred = null, fetchImpl = fetch } = {}) {
  const data = await requestJson(`${MESSAGE_API}/svr_sync/v1/svr_sync/fetch_session_msgs`, {
    params: {
      talker_id: Number(talkerId),
      session_type: 1,
      size: Math.max(1, Math.min(50, Number(size) || 20)),
      build: 0,
      mobi_app: 'web',
    },
    cred,
    fetchImpl,
    referer: 'https://message.bilibili.com/',
  })
  return mapDmMessages(data?.messages, { selfUid: cred?.dedeuserid })
}

/**
 * Read-only DM history for the model. B站 returns at most 50 messages per call,
 * so `before` only filters inside that window; it is not a full pagination cursor.
 */
export async function fetchDmHistory(talkerId, { limit = 20, before = null, cred = null, fetchImpl = fetch } = {}) {
  const size = Math.max(1, Math.min(50, Number(limit) || 20))
  const messages = await fetchDmMessages(talkerId, { size: 50, cred, fetchImpl })
  const beforeSec = Number.isFinite(before) ? (before > 1e12 ? before / 1000 : before) : null
  const filtered = beforeSec == null ? messages : messages.filter((message) => message.ts < beforeSec)
  return { messages: filtered.slice(-size), windowSize: messages.length, truncated: messages.length >= 50 }
}

export async function sendDm(uid, text, { cred, fetchImpl = fetch } = {}) {
  requireCredential(cred)
  const senderUid = Number(cred.dedeuserid)
  const params = await signedParams({ w_sender_uid: senderUid, w_receiver_id: Number(uid), web_location: 1550101 }, { cred, fetchImpl })
  const form = new URLSearchParams({
    'msg[sender_uid]': String(senderUid),
    'msg[receiver_id]': String(uid),
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[msg_status]': '0',
    'msg[content]': JSON.stringify({ content: text }),
    'msg[dev_id]': DEV_ID,
    'msg[new_face_version]': '0',
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    from_filework: '0',
    build: '0',
    mobi_app: 'web',
    csrf: cred.bili_jct,
    csrf_token: cred.bili_jct,
  })
  const data = await requestJson(`${MESSAGE_API}/web_im/v1/web_im/send_msg`, {
    method: 'POST',
    params,
    form,
    cred,
    fetchImpl,
    referer: 'https://message.bilibili.com/',
  })
  const msgKey = data?.msg_key ?? data?.data?.msg_key
  if (!msgKey) throw new BiliError('no_receipt', '接口回了成功，但没有投递回执（msg_key）', { kind: 'unknown' })
  return { externalId: String(msgKey) }
}

export function dmImageParams() {
  const alphabet = 'ABCDEFGHIJK'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]
  return {
    dm_img_list: '[]',
    dm_img_str: `${pick()}${pick()}`,
    dm_cover_img_str: `${pick()}${pick()}`,
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  }
}

export async function sendComment({ oid, root = null, parent = null, text, cred, fetchImpl = fetch } = {}) {
  requireCredential(cred)
  const params = await signedParams({ web_location: 333.1387, ...dmImageParams() }, { cred, fetchImpl })
  const form = new URLSearchParams({
    oid: String(oid),
    type: '1',
    // B站 only resolves mentions written as @nickname with no space after @.
    message: String(text ?? '').replace(/@\s+/g, '@'),
    plat: '1',
    statistics: JSON.stringify({ appId: 100, platform: 5 }),
    gaia_source: 'main_web',
    csrf: cred.bili_jct,
    csrf_token: cred.bili_jct,
  })
  if (root) {
    form.set('root', String(root))
    form.set('parent', String(parent ?? root))
  }
  const data = await requestJson(`${API}/x/v2/reply/add`, { method: 'POST', params, form, cred, fetchImpl })
  const rpid = data?.rpid ?? data?.reply?.rpid
  if (!rpid) throw new BiliError('no_receipt', '评论接口回了成功，但没有 rpid', { kind: 'unknown' })
  return { externalId: String(rpid) }
}

export function parseTarget(to) {
  const raw = String(to ?? '').trim()
  if (/^\d+$/.test(raw)) return { kind: 'dm', uid: raw }
  if (raw.startsWith('uid:')) {
    const uid = raw.slice(4)
    if (!/^\d+$/.test(uid)) throw new BiliError('bad_target', `uid 目标不是数字: ${raw}`, { kind: 'config' })
    return { kind: 'dm', uid }
  }
  if (raw.startsWith('bvid:')) {
    const bvid = raw.slice(5)
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new BiliError('bad_target', `bvid 目标不合法: ${raw}`, { kind: 'config' })
    return { kind: 'video', bvid }
  }
  if (raw.startsWith('comment:')) {
    const value = raw.slice(8)
    if (/^BV[0-9A-Za-z]{10}$/.test(value)) return { kind: 'comment_bvid', bvid: value }
    const oid = Number(value)
    if (!Number.isInteger(oid) || oid <= 0) throw new BiliError('bad_target', `comment 目标不合法: ${raw}`, { kind: 'config' })
    return { kind: 'comment', oid }
  }
  if (raw.startsWith('reply:')) {
    const [oid, root, parent] = raw.slice(6).split(':').map(Number)
    if (!Number.isInteger(oid) || oid <= 0 || !Number.isInteger(root) || root <= 0) {
      throw new BiliError('bad_target', `回复目标不完整: ${raw}`, { kind: 'config' })
    }
    return { kind: 'reply', oid, root, parent: parent > 0 ? parent : root }
  }
  throw new BiliError('bad_target', `无法识别的发送目标: ${raw}`, { kind: 'config' })
}

export async function sendOutbound(to, text, { cred, fetchImpl = fetch } = {}) {
  const body = String(text ?? '')
  if (Array.from(body).length > 1000) throw new BiliError('too_long', 'B站单条消息最多 1000 字', { kind: 'config' })
  const target = parseTarget(to)
  if (target.kind === 'dm') return sendDm(target.uid, body, { cred, fetchImpl })
  if (target.kind === 'video') {
    const video = await getVideo(target.bvid, { cred, fetchImpl })
    return sendComment({ oid: video.aid, text: body, cred, fetchImpl })
  }
  if (target.kind === 'comment') return sendComment({ oid: target.oid, text: body, cred, fetchImpl })
  if (target.kind === 'comment_bvid') {
    const video = await getVideo(target.bvid, { cred, fetchImpl })
    return sendComment({ oid: video.aid, text: body, cred, fetchImpl })
  }
  return sendComment({ oid: target.oid, root: target.root, parent: target.parent, text: body, cred, fetchImpl })
}

function requireCredential(cred) {
  if (!cred?.sessdata || !cred?.bili_jct) throw new BiliError('no_credential', 'B站未登录：先运行 node channel/login.mjs', { kind: 'auth' })
}

export { API, MESSAGE_API, PASSPORT_API, UA }
