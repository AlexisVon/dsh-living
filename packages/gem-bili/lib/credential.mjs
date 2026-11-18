import { API, PASSPORT_API, baseHeaders, requestJson } from './api.mjs'
import { gemHome, saveCredential } from './config.mjs'
import { renderTerminalQr } from './qr.mjs'

const LOGIN_TIMEOUT_MS = 3 * 60_000
const POLL_INTERVAL_MS = 2000

/** Raw query values: SESSDATA is percent-encoded and must stay that way in the Cookie header. */
export function rawQueryParam(url, name) {
  const match = String(url ?? '').match(new RegExp(`[?&]${name}=([^&]*)`))
  return match ? match[1] : ''
}

export function credentialsFromLoginUrl(url) {
  return {
    sessdata: rawQueryParam(url, 'SESSDATA'),
    bili_jct: rawQueryParam(url, 'bili_jct'),
    dedeuserid: rawQueryParam(url, 'DedeUserID'),
  }
}

const CREDENTIAL_COOKIES = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid' }

export function isCompleteCredentials(value) {
  return Boolean(value?.sessdata && value?.bili_jct && value?.dedeuserid)
}

/** Split one Set-Cookie header into a name/value pair; the value keeps its percent-encoding. */
export function parseSetCookie(header) {
  const pair = String(header ?? '').split(';')[0]
  const at = pair.indexOf('=')
  if (at <= 0) return null
  return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1) }
}

/**
 * Newer passport returns a `ticket` instead of cookies. The ticket is exchanged on the
 * crossDomain redirect chain, cookies only arrive in Set-Cookie; later hops win so a
 * .bilibili.com cookie overrides the same-name biligame.com one.
 */
export async function credentialsFromTicket(url, { fetchImpl = fetch, maxHops = 5, referer = 'https://www.bilibili.com/' } = {}) {
  const found = {}
  let next = url
  for (let hop = 0; hop < maxHops && next; hop += 1) {
    const response = await fetchImpl(next, { method: 'GET', redirect: 'manual', headers: baseHeaders(null, referer) })
    const headers = response.headers?.getSetCookie?.() ?? []
    for (const header of headers) {
      const cookie = parseSetCookie(header)
      const key = cookie && CREDENTIAL_COOKIES[cookie.name]
      if (key && cookie.value) found[key] = cookie.value
    }
    next = response.headers?.get?.('location') ?? null
    if (next && !/^https?:/i.test(next)) next = new URL(next, url).toString()
  }
  return {
    sessdata: found.sessdata ?? '',
    bili_jct: found.bili_jct ?? '',
    dedeuserid: found.dedeuserid ?? '',
  }
}

async function fetchBuvid(fetchImpl) {
  const data = await requestJson(`${API}/x/frontend/finger/spi`, { fetchImpl })
  if (!data?.b_3) throw new Error('B站设备指纹接口没有返回 buvid3')
  return { buvid3: data.b_3, buvid4: data.b_4 ?? '' }
}

async function fetchProfile(cred, fetchImpl) {
  let data
  try {
    data = await requestJson(`${API}/x/web-interface/nav`, { cred, fetchImpl })
  } catch (error) {
    throw new Error(`二维码已确认，但 Cookie 校验失败（${error.message}），请重试扫码`)
  }
  if (data?.isLogin !== true) throw new Error('登录回调 Cookie 未被 B站 接受（nav isLogin=false），请重试扫码')
  return { uname: data.uname ?? '', mid: String(data.mid ?? cred.dedeuserid) }
}

export async function loginWithQr({
  home = gemHome(),
  fetchImpl = fetch,
  render = renderTerminalQr,
  log = console.log,
  onQr = null,
  onStatus = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const deadline = now() + LOGIN_TIMEOUT_MS
  let expired = 0
  let qr = await requestJson(`${PASSPORT_API}/x/passport-login/web/qrcode/generate`, {
    fetchImpl,
    referer: 'https://www.bilibili.com/',
  })
  if (!qr?.url || !qr?.qrcode_key) throw new Error('B站二维码接口没有返回 url / qrcode_key')

  for (;;) {
    onQr?.(qr.url)
    onStatus?.('wait')
    log('用手机 B站 扫码登录（请选「记住我 / 长期」）：\n')
    log(render(qr.url))
    log(`\n二维码链接（扫不出来时用手机打开）：${qr.url}\n`)
    let scanned = false
    while (now() < deadline) {
      const result = await requestJson(`${PASSPORT_API}/x/passport-login/web/qrcode/poll`, {
        params: { qrcode_key: qr.qrcode_key, source: 'main-fe-header' },
        fetchImpl,
        referer: 'https://www.bilibili.com/',
      })
      const code = Number(result?.code)
      if (code === 0) {
        let base = credentialsFromLoginUrl(result.url)
        if (!isCompleteCredentials(base)) {
          if (!rawQueryParam(result.url, 'ticket')) {
            throw new Error(`登录成功但回调既没有 Cookie 也没有 ticket：${String(result.url).slice(0, 120)}`)
          }
          base = await credentialsFromTicket(result.url, { fetchImpl })
        }
        if (!isCompleteCredentials(base)) {
          throw new Error('登录成功但 ticket 换不到完整 Cookie（SESSDATA / bili_jct / DedeUserID 缺一），请重试扫码')
        }
        const [buvid, profile] = await Promise.all([fetchBuvid(fetchImpl), fetchProfile(base, fetchImpl)])
        const credential = {
          ...base,
          ...buvid,
          uname: profile.uname,
          mid: profile.mid,
          savedAt: new Date().toISOString(),
        }
        onStatus?.('confirmed')
        saveCredential(credential, home)
        return credential
      }
      if (code === 86090 && !scanned) {
        scanned = true
        onStatus?.('scaned')
        log('已扫码，请在手机上确认登录…')
      }
      if (code === 86038) {
        expired += 1
        onStatus?.('expired')
        if (expired > 3) throw new Error('二维码连续失效，请重新运行登录')
        log(`二维码已失效，刷新（${expired}/3）…`)
        qr = await requestJson(`${PASSPORT_API}/x/passport-login/web/qrcode/generate`, {
          fetchImpl,
          referer: 'https://www.bilibili.com/',
        })
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (now() >= deadline) throw new Error('扫码登录超时（3 分钟）')
  }
}
