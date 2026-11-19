import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLogin } from '../lib/login.mjs'

test('login：账号密码登录、设备发现与凭据落盘', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petkit-login-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith('/user/login')) {
      return new Response(JSON.stringify({
        result: { session: { id: 'sess-login', userId: '42', expiresIn: 3600, createdAt: 'now', region: 'CN' } },
      }), { status: 200 })
    }
    if (String(url).endsWith('/group/family/list')) {
      return new Response(JSON.stringify({
        result: [{
          groupId: 'g1',
          deviceList: [{ deviceId: 733807, deviceType: 'D4H', deviceName: '喂食器', typeCode: 0, type: 26 }],
        }],
      }), { status: 200 })
    }
    throw new Error(`unexpected ${url}`)
  }

  const events = []
  const answers = { username: '13800000000', password: 'secret' }
  const { credential, devices, selected } = await runLogin({
    prompt: async (id) => answers[id],
    emit: (event) => events.push(event),
    home,
    config: { timezone: 'Asia/Shanghai' },
    fetchImpl,
  })

  assert.equal(credential.sessionId, 'sess-login')
  assert.equal(credential.username, '13800000000')
  assert.equal(selected.id, '733807')
  assert.equal(devices.length, 1)
  assert.equal(devices[0].deviceType, 'd4h')
  assert.equal(events.filter((event) => event.type === 'prompt').length, 2)
  assert.equal(events.at(-1).type, 'done')

  const saved = JSON.parse(readFileSync(join(home, 'credential.json'), 'utf8'))
  assert.equal(saved.sessionId, 'sess-login')
  assert.equal(statSync(join(home, 'credential.json')).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(join(home, 'selected.json'), 'utf8')).id, '733807')
  assert.equal(calls.length, 2)
})
