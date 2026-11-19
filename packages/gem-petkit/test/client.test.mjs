import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PetkitClient } from '../lib/client.mjs'
import { PetkitError } from '../lib/errors.mjs'

function mockFetch(handler) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    const payload = await handler(new URL(String(url)), options, calls.length)
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

const credential = {
  sessionId: 'sess-1',
  gateway: 'https://api.petkit.cn/6/',
  region: 'CN',
  timezone: 'Asia/Shanghai',
}

const device = { id: '733807', deviceType: 'd4h', typeCode: 0, name: '喂食器' }

test('client：密码登录表单与 session', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({
    result: { session: { id: 'sess-1', userId: '42', expiresIn: 3600, createdAt: 'now', region: 'CN' } },
  }))
  const client = new PetkitClient({ config: { timezone: 'Asia/Shanghai' }, fetchImpl })
  const session = await client.loginWithPassword('13800000000', 'secret')

  assert.equal(session.sessionId, 'sess-1')
  assert.equal(session.userId, '42')
  assert.equal(calls[0].url, 'https://api.petkit.cn/6/user/login')
  const body = new URLSearchParams(calls[0].options.body)
  assert.equal(body.get('region'), 'CN')
  assert.equal(body.get('username'), '13800000000')
  assert.equal(body.get('password'), '5ebe2294ecd0e0f08eab7690d2a6ee69')
  assert.match(body.get('client'), /'timezoneId': 'Asia\/Shanghai'/)
})

test('client：device_detail 与记录请求带 session', async () => {
  const { fetchImpl, calls } = mockFetch((url) => {
    if (url.pathname.endsWith('/device_detail')) return { result: { state: { food: 2 } } }
    return { result: { feed: [] } }
  })
  const client = new PetkitClient({ credential, fetchImpl })
  await client.detail(device)
  await client.records(device, '20261119')

  assert.equal(calls[0].url, 'https://api.petkit.cn/6/d4h/device_detail')
  assert.equal(calls[0].options.headers['X-Session'], 'sess-1')
  assert.equal(calls[1].url, 'https://api.petkit.cn/6/d4h/getDeviceRecord?days=20261119&deviceId=733807')
})

test('client：手动出粮表单与非法克数', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ result: { id: 'r40878-1', amount: 10 } }))
  const client = new PetkitClient({ credential, fetchImpl })
  const response = await client.manualFeed(device, 10)

  assert.equal(response.id, 'r40878-1')
  const body = new URLSearchParams(calls[0].options.body)
  assert.equal(body.get('deviceId'), '733807')
  assert.equal(body.get('amount'), '10')
  assert.equal(body.get('time'), '-1')
  assert.equal(body.get('name'), '')
  await assert.rejects(() => client.manualFeed(device, 15), /10 \/ 20 \/ 30 \/ 40 \/ 50/)
})

test('client：错误信封映射为 PetkitError', async () => {
  const { fetchImpl } = mockFetch(() => ({ error: { code: 125, msg: 'not registered' } }))
  const client = new PetkitClient({ credential, fetchImpl })
  await assert.rejects(
    () => client.detail(device),
    (error) => error instanceof PetkitError && error.code === 125 && /账号未注册/.test(error.message),
  )
})

test('client：家族设备为空时合并共享设备', async () => {
  const { fetchImpl } = mockFetch((url) => {
    if (url.pathname.endsWith('/group/family/list')) {
      return { result: [{ groupId: 'g1', deviceList: [] }] }
    }
    return {
      result: {
        devices: [{ id: 733807, type: 'D4H', typeCode: 0, deviceTypeId: 26, deviceTypeAndId: '26_733807' }],
      },
    }
  })
  const client = new PetkitClient({ credential, fetchImpl })
  const devices = await client.listDevices()
  assert.equal(devices.length, 1)
  assert.equal(devices[0].deviceType, 'd4h')
  assert.equal(devices[0].shared, true)
  assert.equal(devices[0].id, '733807')
})
