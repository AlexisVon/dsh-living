import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCoreClient, failureCodeFor } from '../lib/channel.mjs'
import {
  DEFAULT_BASE_URL,
  IlinkError,
  SessionTimeoutError,
  getUpdates,
  inboundEvent,
  isMessageLimit,
  loginWithQr,
  mediaItems,
  parseWeixinMessage,
  resolveRecipient,
  sendOutbound,
  sendText,
} from '../lib/ilink.mjs'
import { MediaError } from '../lib/media.mjs'
import { qrSvgFor } from '../lib/qr.mjs'
import { sanitizeText, splitText } from '../lib/text.mjs'

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status })
}

test('文本按码点切分，超长时编号且不超上限', () => {
  assert.deepEqual(splitText('你好', 4000), ['你好'])
  const text = '中'.repeat(25)
  const chunks = splitText(text, 20)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(Array.from(chunk).length <= 20)
  assert.ok(chunks[0].startsWith('（1/'))
})

test('孤立代理项被替换', () => {
  assert.equal(sanitizeText('a\uD800b'), 'a�b')
})

test('入站解析：文本 + 图片 + 语音转写 + 文件', () => {
  assert.deepEqual(parseWeixinMessage({ item_list: [{ type: 1, text_item: { text: '在吗' } }] }), {
    text: '在吗',
    itemTypes: [1],
    hasText: true,
    attachments: [],
  })
  const mixed = parseWeixinMessage({
    item_list: [
      { type: 2, image_item: {} },
      { type: 3, voice_item: { text: '语音内容' } },
      { type: 4, file_item: { file_name: 'a.pdf' } },
    ],
  })
  assert.match(mixed.text, /\[图片\]/)
  assert.match(mixed.text, /\[语音转写\] 语音内容/)
  assert.match(mixed.text, /\[文件\] a\.pdf/)
})

test('入站媒体：附件按 item 位置替换占位，语音无转写直接说听不清', () => {
  const message = {
    item_list: [
      { type: 1, text_item: { text: '看看这个' } },
      { type: 2, image_item: { media: { encrypt_query_param: 'img' } } },
      { type: 3, voice_item: { media: { encrypt_query_param: 'voice' } } },
      { type: 4, file_item: { file_name: 'a.pdf', media: { encrypt_query_param: 'file' } } },
    ],
  }
  const attachments = []
  attachments[1] = { kind: 'image', path: '/tmp/a.png', name: 'a.png' }
  attachments[3] = { kind: 'file', path: '/tmp/a.pdf', name: 'a.pdf' }
  const parsed = parseWeixinMessage(message, { attachments })
  assert.match(parsed.text, /看看这个/)
  assert.match(parsed.text, /\[图片\] \/tmp\/a\.png/)
  assert.match(parsed.text, /\[语音\]（无转写，听不清）/)
  assert.match(parsed.text, /\[文件: a\.pdf\] \/tmp\/a\.pdf/)
  assert.equal(parsed.attachments.length, 2)
  assert.deepEqual(mediaItems(message).map((item) => item.kind), ['image', 'file'])
})

test('入站事件：external_id、时间与回复目标', () => {
  const event = inboundEvent({
    message_id: 99,
    from_user_id: 'u1',
    create_time_ms: 1700000000000,
    session_id: 's1',
    item_list: [{ type: 1, text_item: { text: '在吗' } }],
  })
  assert.equal(event.external_id, 'wx_99')
  assert.equal(event.ts, 1700000000000)
  assert.equal(event.from.id, 'u1')
  assert.equal(event.meta.reply_to, 'me')
  assert.equal(event.meta.trusted, false)
})

test('微信：绑定主人 trusted，allowedUsers 里的其他人不算', () => {
  const message = { message_id: 1, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '在吗' } }] }
  assert.equal(inboundEvent(message, { ownerId: 'u1' }).meta.trusted, true)
  assert.equal(inboundEvent(message, { ownerId: 'u2' }).meta.trusted, false)
})

test('收件人：me/self/空 落到绑定用户', () => {
  assert.equal(resolveRecipient('me', 'u1'), 'u1')
  assert.equal(resolveRecipient('', 'u1'), 'u1')
  assert.equal(resolveRecipient('uid:u1', 'u1'), 'u1')
  assert.equal(resolveRecipient('u2', 'u1'), 'u2')
})

test('失败码：会话超时 / 连发窗口 / 24h 窗口 / 非法请求 / 网络', () => {
  assert.equal(failureCodeFor(new SessionTimeoutError()), 'gem_cookie_expired')
  assert.equal(failureCodeFor(new IlinkError('send', -2, undefined, 'prepare failed')), 'provider_rate')
  assert.ok(isMessageLimit(new IlinkError('send', -2, undefined, 'prepare failed')))
  assert.equal(failureCodeFor(new IlinkError('send', -1, undefined, '窗口已关闭')), 'window_closed')
  assert.equal(failureCodeFor(new IlinkError('send', -1, undefined, 'invalid request')), 'config_invalid')
  assert.equal(failureCodeFor(new MediaError('bad path', 'config')), 'config_invalid')
  assert.equal(failureCodeFor(new MediaError('cdn down', 'network')), 'provider_timeout')
  assert.equal(failureCodeFor(Object.assign(new Error('fetch failed'), { name: 'TypeError' })), 'provider_timeout')
})

test('sendText：bot 消息形状、context_token 与回执', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    return json({ ret: 0, message_id: 123 })
  }
  const result = await sendText({ token: 't', to: 'u1', text: '你好', contextToken: 'ctx', fetchImpl })
  assert.equal(result.externalId, '123')
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.msg.message_type, 2)
  assert.equal(body.msg.message_state, 2)
  assert.equal(body.msg.context_token, 'ctx')
  assert.equal(body.msg.item_list[0].text_item.text, '你好')
  assert.match(calls[0].options.headers.Authorization, /^Bearer t$/)
})

test('sendText：prepare failed 映射为连发窗口', async () => {
  const fetchImpl = async () => json({ ret: -2, errmsg: 'prepare failed' })
  await assert.rejects(
    () => sendText({ token: 't', to: 'u1', text: 'x', fetchImpl }),
    (error) => error instanceof IlinkError && isMessageLimit(error),
  )
})

test('超过 10 条气泡在发送前拒绝', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return json({ ret: 0 })
  }
  await assert.rejects(
    () => sendOutbound({ to: 'u1', text: 'x'.repeat(4000 * 11) }, { token: 't', chunkLimit: 4000, fetchImpl }),
    /10 bubbles/,
  )
  assert.equal(called, false)
})

test('sendOutbound 把 "me" 解析成绑定用户再上线', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return json({ ret: 0, message_id: 1 })
  }
  await sendOutbound({ to: 'me', text: '你好' }, { token: 't', boundUserId: 'owner@im.wechat', fetchImpl })
  assert.equal(calls[0].body.msg.to_user_id, 'owner@im.wechat')
})

test('sendOutbound 图片：getuploadurl → CDN 加密上传 → sendmessage', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('getuploadurl')) {
      return json({ ret: 0, upload_param: 'up-1', upload_full_url: 'https://cdn.example/upload' })
    }
    if (String(url).includes('cdn.example/upload')) {
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'enc-1' } })
    }
    return json({ ret: 0, message_id: 77 })
  }
  const buffer = Buffer.from('hello')
  const result = await sendOutbound(
    { to: 'me', text: '' },
    { token: 't', boundUserId: 'u1', cdnBaseUrl: 'https://cdn.example', fetchImpl, media: [{ buffer, fileName: 'a.png', kind: 'image' }] },
  )
  assert.equal(result.externalId, '77')
  assert.equal(calls.length, 3)
  const upload = JSON.parse(calls[0].options.body)
  assert.equal(upload.media_type, 1)
  assert.equal(upload.to_user_id, 'u1')
  assert.equal(upload.rawsize, buffer.length)
  assert.match(upload.aeskey, /^[0-9a-f]{32}$/)
  const sent = JSON.parse(calls[2].options.body)
  assert.equal(sent.msg.to_user_id, 'u1')
  assert.equal(sent.msg.item_list[0].type, 2)
  assert.equal(sent.msg.item_list[0].image_item.media.encrypt_query_param, 'enc-1')
  assert.match(sent.msg.item_list[0].image_item.media.aes_key, /^[A-Za-z0-9+/=]+$/)
})

test('sendOutbound 文件：按文件气泡发送并带文件名', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('getuploadurl')) return json({ ret: 0, upload_param: 'up-2' })
    if (String(url).includes('/upload')) {
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'enc-2' } })
    }
    return json({ ret: 0, message_id: 78 })
  }
  await sendOutbound(
    { to: 'me', text: '' },
    { token: 't', boundUserId: 'u1', cdnBaseUrl: 'https://cdn.example', fetchImpl, media: [{ buffer: Buffer.from('pdf'), fileName: '报告.pdf', kind: 'file' }] },
  )
  const upload = JSON.parse(calls[0].options.body)
  assert.equal(upload.media_type, 3)
  const sent = JSON.parse(calls[2].options.body)
  assert.equal(sent.msg.item_list[0].type, 4)
  assert.equal(sent.msg.item_list[0].file_item.file_name, '报告.pdf')
  assert.equal(sent.msg.item_list[0].file_item.len, '3')
})

test('getUpdates 超时视为空轮询', async () => {
  const fetchImpl = async () => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    throw error
  }
  const response = await getUpdates({ token: 't', buf: '', fetchImpl, timeoutMs: 1 })
  assert.deepEqual(response.msgs, [])
})

test('二维码 SVG 可直接嵌进设置页', () => {
  const svg = qrSvgFor('https://liteapp.weixin.qq.com/q/abc?qrcode=def')
  assert.match(svg, /^<svg/)
  assert.ok(svg.length > 100)
})

test('loginWithQr：确认后返回并保存形状正确的 token', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('get_bot_qrcode')) return json({ qrcode: 'q1', qrcode_img_content: 'https://qr' })
    return json({ status: 'confirmed', bot_token: 'bt', baseurl: 'https://gw', ilink_bot_id: 'bot1', ilink_user_id: 'u1' })
  }
  const token = await loginWithQr({ fetchImpl, render: (url) => url, log: () => {}, sleep: async () => {}, now: () => 0 })
  assert.deepEqual(
    { token: token.token, baseUrl: token.baseUrl, accountId: token.accountId, userId: token.userId },
    { token: 'bt', baseUrl: 'https://gw', accountId: 'bot1', userId: 'u1' },
  )
  assert.equal(DEFAULT_BASE_URL, 'https://ilinkai.weixin.qq.com')
})

test('core 客户端：ingest / outbox / ack 的路径与 token', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    return json({ accepted: true })
  }
  const core = createCoreClient({ baseUrl: 'http://127.0.0.1:3000/', gem: 'wechat', token: 't', fetchImpl })
  await core.ingest({ gem: 'wechat', kind: 'message', external_id: 'e1', from: { id: 'u1' }, text: 'hi', ts: 1 })
  await core.pullOutbox(5)
  await core.ack('out_1', { ok: true, external_id: 'x' })
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/living/ingest')
  assert.equal(calls[0].options.headers['x-living-token'], 't')
  assert.equal(calls[1].url, 'http://127.0.0.1:3000/living/outbox?gem=wechat&limit=5')
  assert.equal(calls[2].url, 'http://127.0.0.1:3000/living/outbox/out_1/ack')
})
