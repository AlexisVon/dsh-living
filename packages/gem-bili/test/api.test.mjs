import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BiliError,
  dmImageParams,
  fetchDmHistory,
  getComments,
  getReplies,
  getUser,
  isSystemDm,
  mapDmMessages,
  mapMsgfeedItem,
  mapSearchItem,
  parseDmContent,
  parseTarget,
  sendComment,
  sendDm,
} from '../lib/api.mjs'
import { dmEvent, failureCodeFor, noticeEvent } from '../lib/channel.mjs'
import { credentialsFromLoginUrl, credentialsFromTicket, isCompleteCredentials, parseSetCookie, rawQueryParam } from '../lib/credential.mjs'
import { qrSvgFor } from '../lib/qr.mjs'
import { encWbi, keysFromUrls, mixinKey } from '../lib/wbi.mjs'

test('WBI：固定密钥与参数的签名可回归', () => {
  const keys = keysFromUrls(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  )
  assert.equal(mixinKey(keys.imgKey, keys.subKey), 'ea1db124af3c7062474693fa704f4ff8')
  const signed = encWbi({ foo: 'bar', baz: '1' }, keys, 1700000000)
  assert.equal(signed.w_rid, '0c5f11a238916d4556aeff87fbbca276')
  assert.equal(signed.wts, '1700000000')
})

test('搜索条目去掉高亮标签并保留 BV 链接', () => {
  const item = mapSearchItem({
    bvid: 'BV1xx411c7mD',
    aid: 1,
    title: '这是 <em class="keyword">标题</em>',
    author: 'UP',
    mid: 2,
    pubdate: 1700000000,
    play: 10,
    video_review: 3,
    description: '<p>简介</p>',
  })
  assert.equal(item.title, '这是 标题')
  assert.equal(item.description, '简介')
  assert.equal(item.url, 'https://www.bilibili.com/video/BV1xx411c7mD')
})

test('私信内容：文本、分享卡片、图片、撤回', () => {
  assert.equal(parseDmContent({ msg_type: 1, content: JSON.stringify({ content: '在吗' }) }), '在吗')
  assert.match(
    parseDmContent({ msg_type: 7, content: JSON.stringify({ title: '视频', author: 'UP', bvid: 'BV1xx411c7mD' }) }),
    /\[分享视频\].*BV1xx411c7mD/,
  )
  assert.equal(parseDmContent({ msg_type: 2, content: '{}' }), '[图片]')
  assert.equal(parseDmContent({ msg_type: 5, content: '{}' }), '[撤回消息]')
})

test('私信按时间正序并标记自己发的', () => {
  const messages = mapDmMessages(
    [
      { msg_key: 'b', timestamp: 20, sender_uid: 9, msg_type: 1, content: JSON.stringify({ content: '二' }) },
      { msg_key: 'a', timestamp: 10, sender_uid: 1, msg_type: 1, content: JSON.stringify({ content: '一' }) },
    ],
    { selfUid: '1' },
  )
  assert.deepEqual(messages.map((message) => message.key), ['a', 'b'])
  assert.equal(messages[0].fromMe, true)
  assert.equal(messages[1].fromMe, false)
})

test('私信事件带回复目标；只有 owner 标 trusted', () => {
  const event = dmEvent({ uid: '9', message: { key: 'k1', text: '在吗', ts: 1700000000 } })
  assert.equal(event.external_id, 'bili_dm_k1')
  assert.equal(event.meta.reply_to, 'uid:9')
  assert.equal(event.ts, 1700000000000)
  assert.equal(event.meta.trusted, false)

  const owner = dmEvent({ uid: '9', message: { key: 'k2', text: '在吗', ts: 1700000000 }, ownerUid: '9' })
  assert.equal(owner.meta.trusted, true)
  const stranger = dmEvent({ uid: '8', message: { key: 'k3', text: '在吗', ts: 1700000000 }, ownerUid: '9' })
  assert.equal(stranger.meta.trusted, false)
})

test('B站系统通知按报文结构识别，不按 uid 大小', () => {
  const notice = JSON.stringify({ title: '登录操作通知', text: '你的账号在新设备登录成功' })
  const chat = JSON.stringify({ content: '在吗' })
  assert.equal(isSystemDm({ content: notice }), true)
  assert.equal(isSystemDm({ content: chat }), false)
  assert.equal(isSystemDm({ content: '不是 JSON' }), false)
  assert.equal(isSystemDm({}), false, '空 content 不当系统通知')

  const mapped = mapDmMessages(
    [
      { msg_key: 'sys', timestamp: 20, sender_uid: 30003, msg_type: 1, content: notice },
      { msg_key: 'me', timestamp: 10, sender_uid: 10001, msg_type: 1, content: chat },
    ],
    { selfUid: '20002' },
  )
  assert.equal(mapped.find((message) => message.key === 'sys').system, true)
  assert.equal(mapped.find((message) => message.key === 'me').system, false)
})

test('系统私信降级成 silent notice：不唤醒、不给回复目标', () => {
  const event = dmEvent({
    uid: '30003',
    message: { key: 'k9', text: '你的账号在新设备登录成功', ts: 1700000000, system: true },
    ownerUid: '10001',
  })
  assert.equal(event.kind, 'notice')
  assert.equal(event.meta.silent, true)
  assert.equal(event.meta.reply_to, undefined, '系统通知不该被回复')
  assert.equal(event.meta.trusted, false)
})

test('@/回复通知事件带 reply 目标', () => {
  const item = mapMsgfeedItem(
    {
      id: 3,
      timestamp: 1700000000,
      user: { mid: 9, nickname: '小明' },
      item: { oid: 100, rpid: 200, root_id: 150, title: '视频', source_content: '看看', uri: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    },
    'reply',
  )
  assert.equal(item.replyTo, 'reply:100:150:200')
  const event = noticeEvent(item)
  assert.equal(event.external_id, 'bili_reply_3')
  assert.equal(event.meta.reply_to, 'reply:100:150:200')
  assert.equal(event.meta.trusted, false)
  assert.match(event.text, /小明/)

  assert.equal(noticeEvent(item, { ownerUid: '9' }).meta.trusted, true)
  assert.equal(noticeEvent(item, { ownerUid: '99' }).meta.trusted, false)
})

test('动态/专栏评论不生成视频回复目标', () => {
  const item = mapMsgfeedItem(
    {
      id: 4,
      timestamp: 1700000000,
      user: { mid: 9, nickname: '小明' },
      item: { oid: 100, rpid: 200, root_id: 150, title: '动态', source_content: '看看', uri: 'https://t.bilibili.com/123' },
    },
    'reply',
  )
  assert.equal(item.replyTo, null)
})

test('发送目标解析：私信 / 评论 / 视频 / 非法', () => {
  assert.deepEqual(parseTarget('123'), { kind: 'dm', uid: '123' })
  assert.deepEqual(parseTarget('uid:123'), { kind: 'dm', uid: '123' })
  assert.deepEqual(parseTarget('reply:1:2:3'), { kind: 'reply', oid: 1, root: 2, parent: 3 })
  assert.deepEqual(parseTarget('bvid:BV1xx411c7mD'), { kind: 'video', bvid: 'BV1xx411c7mD' })
  assert.throws(() => parseTarget('@someone'), /无法识别/)
})

test('失败码映射', () => {
  assert.equal(failureCodeFor(new BiliError('x', 'x', { kind: 'auth' })), 'gem_cookie_expired')
  assert.equal(failureCodeFor(new BiliError('x', 'x', { kind: 'rate' })), 'provider_rate')
  assert.equal(failureCodeFor(new Error('x')), 'unknown')
})

test('登录回调里的 SESSDATA 保持百分号编码', () => {
  const url = 'https://passport.biligame.com/crossDomain?DedeUserID=42&SESSDATA=a%2Cb%2Cc&bili_jct=jct'
  assert.equal(rawQueryParam(url, 'SESSDATA'), 'a%2Cb%2Cc')
  assert.deepEqual(credentialsFromLoginUrl(url), { sessdata: 'a%2Cb%2Cc', bili_jct: 'jct', dedeuserid: '42' })
})

test('Set-Cookie 解析保留百分号编码，丢掉属性', () => {
  assert.deepEqual(parseSetCookie('SESSDATA=a%2Cb%2Cc; Path=/; Domain=biligame.com; Expires=Mon, 17 May 2027 01:48:38 GMT'), {
    name: 'SESSDATA',
    value: 'a%2Cb%2Cc',
  })
  assert.equal(parseSetCookie('garbage'), null)
})

test('ticket 回调：走 crossDomain 跳转链从 Set-Cookie 取凭据，后一跳覆盖前一跳', async () => {
  const hops = []
  const hop = (location, cookies) => {
    const headers = new Headers({ 'content-type': 'text/html' })
    if (location) headers.set('location', location)
    for (const cookie of cookies) headers.append('set-cookie', cookie)
    return new Response('<a>Found</a>', { status: location ? 302 : 200, headers })
  }
  const fetchImpl = async (url) => {
    hops.push(String(url))
    if (hops.length === 1) {
      return hop('https://passport.biligame.cn/x/passport-login/web/crossDomain?ticket=t2', [
        'SESSDATA=game%2C1%2Cx; Path=/; Domain=biligame.com',
        'bili_jct=jct1; Path=/; Domain=biligame.com',
        'DedeUserID=42; Path=/; Domain=biligame.com',
      ])
    }
    return hop(null, ['SESSDATA=main%2C2%2Cy; Path=/; Domain=.bilibili.com', 'sid=abc; Path=/'])
  }

  const cred = await credentialsFromTicket(
    'https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=t1&gourl=https%3A%2F%2Fwww.bilibili.com',
    { fetchImpl },
  )
  assert.equal(hops.length, 2)
  assert.equal(cred.sessdata, 'main%2C2%2Cy', '后一跳的 .bilibili.com Cookie 胜出')
  assert.equal(cred.bili_jct, 'jct1', '前一跳独有的字段保留')
  assert.equal(cred.dedeuserid, '42')
  assert.equal(isCompleteCredentials(cred), true)
})

test('ticket 回调：跳转链拿不到 Cookie 时如实报缺', async () => {
  const fetchImpl = async () => new Response('', { status: 302, headers: { location: 'https://www.bilibili.com' } })
  const cred = await credentialsFromTicket('https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=t', { fetchImpl })
  assert.equal(isCompleteCredentials(cred), false)
})

test('评论读取带 root 与可直接抄的 reply_to', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/x/web-interface/view')) {
      return new Response(JSON.stringify({ code: 0, data: { aid: 100, bvid: 'BV1xx411c7mD' } }), { status: 200 })
    }
    return new Response(JSON.stringify({
      code: 0,
      data: { replies: [{ rpid: 200, root: 0, parent: 0, mid: 2, member: { uname: 'A' }, content: { message: 'hi' }, like: 1, rcount: 2, ctime: 1 }] },
    }), { status: 200 })
  }
  const comments = await getComments('BV1xx411c7mD', { fetchImpl })
  assert.equal(comments[0].oid, 100)
  assert.equal(comments[0].root, 200)
  assert.equal(comments[0].replyTo, 'reply:100:200:200')
})

test('子回复读取带 root/parent 与 reply_to', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({
      code: 0,
      data: { replies: [{ rpid: 300, root: 200, parent: 200, mid: 3, member: { uname: 'B' }, content: { message: 'reply' }, like: 0, ctime: 2 }] },
    }), { status: 200 })
  const replies = await getReplies({ oid: 100, root: 200, fetchImpl })
  assert.equal(replies[0].root, 200)
  assert.equal(replies[0].parent, 200)
  assert.equal(replies[0].replyTo, 'reply:100:200:300')
})

test('历史私信：只在最近 50 条窗口内按 before 过滤', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({
      code: 0,
      data: {
        messages: [
          { msg_key: 'c', timestamp: 1700000300, sender_uid: 9, content: '{"content":"third"}' },
          { msg_key: 'b', timestamp: 1700000200, sender_uid: 9, content: '{"content":"second"}' },
          { msg_key: 'a', timestamp: 1700000100, sender_uid: 9, content: '{"content":"first"}' },
        ],
      },
    }), { status: 200 })
  const cred = { sessdata: 's', bili_jct: 'j', dedeuserid: '5' }
  const history = await fetchDmHistory('9', { before: 1700000250000, cred, fetchImpl })
  assert.deepEqual(history.messages.map((message) => message.text), ['first', 'second'])
  assert.equal(history.windowSize, 3)
})

test('私信发送把 csrf 与回执带回', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/x/web-interface/nav')) {
      return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'https://x/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://x/4932caff0ff746eab6f01bf08b70ac45.png' } } }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: { msg_key: 77 } }), { status: 200 })
  }
  const cred = { sessdata: 's', bili_jct: 'j', dedeuserid: '5' }
  const result = await sendDm('9', '你好', { cred, fetchImpl })
  assert.equal(result.externalId, '77')
  const body = calls.find((call) => call.url.includes('/web_im/v1/web_im/send_msg')).options.body
  assert.equal(body.get('csrf'), 'j')
  assert.equal(body.get('msg[receiver_id]'), '9')
})

test('公开评论带 dm 风控参数与 WBI 签名', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/x/web-interface/nav')) {
      return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'https://x/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://x/4932caff0ff746eab6f01bf08b70ac45.png' } } }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: { rpid: 88 } }), { status: 200 })
  }
  const cred = { sessdata: 's', bili_jct: 'j', dedeuserid: '5' }
  const result = await sendComment({ oid: 100, root: 20, parent: 30, text: '回复', cred, fetchImpl })
  assert.equal(result.externalId, '88')
  const url = calls.find((call) => call.url.includes('/x/v2/reply/add'))
  assert.ok(url.url.includes('w_rid='))
  assert.ok(url.url.includes('dm_img_str='))
  assert.equal(url.options.body.get('root'), '20')
  assert.equal(url.options.body.get('parent'), '30')
})

test('uid → 昵称：card API 映射', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ code: 0, data: { card: { mid: '2', name: '碧诗', sign: '签名', face: 'f', level_info: { current_level: 6 } } } }),
      { status: 200 },
    )
  const user = await getUser('2', { fetchImpl })
  assert.equal(user.uid, '2')
  assert.equal(user.name, '碧诗')
  assert.equal(user.level, 6)
  await assert.rejects(() => getUser('abc', { fetchImpl }), /uid 不合法/)
})

test('评论 @ 昵称：去掉 @ 后的空格', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/x/web-interface/nav')) {
      return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'https://x/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://x/4932caff0ff746eab6f01bf08b70ac45.png' } } }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: { rpid: 1 } }), { status: 200 })
  }
  const cred = { sessdata: 's', bili_jct: 'j', dedeuserid: '5' }
  await sendComment({ oid: 100, text: '@ 碧诗 你好', cred, fetchImpl })
  const call = calls.find((entry) => entry.url.includes('/x/v2/reply/add'))
  assert.equal(call.options.body.get('message'), '@碧诗 你好')
})

test('二维码 SVG 可直接嵌进设置页', () => {
  const svg = qrSvgFor('https://example.com/login?qrcode=abc')
  assert.match(svg, /^<svg/)
  assert.ok(svg.length > 100)
})

test('dm 风控参数每次都是合法形状', () => {
  const params = dmImageParams()
  assert.equal(params.dm_img_str.length, 2)
  assert.equal(params.dm_cover_img_str.length, 2)
  assert.ok(params.dm_img_inter.startsWith('{'))
})
