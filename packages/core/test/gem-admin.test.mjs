import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultGemHome,
  gemSummaries,
  readCredentialStatus,
  readGemConfig,
  resolveGemHomes,
  writeGemConfig,
} from '../lib/gem-admin.mjs'

function gem(id) {
  return {
    manifest: {
      id,
      name: `宝石 ${id}`,
      version: '0.1.0',
      description: '测试',
      capabilities: { text: true },
      limits: { perMinute: 10 },
      etiquette: ['不群发'],
      failure_hints: {},
    },
    dir: `/gems/${id}`,
    skill: '',
  }
}

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'living-gem-admin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('宝石家目录：覆盖优先，非法覆盖大声失败', () => {
  const gemDataDir = '/tmp/living-gem-data'
  const homes = resolveGemHomes([gem('bili')], { bili: '/tmp/bili-home' }, { gemDataDir })
  assert.equal(homes.bili, '/tmp/bili-home')
  assert.equal(resolveGemHomes([gem('bili')], {}, { gemDataDir }).bili, defaultGemHome(gemDataDir, 'bili'))
  assert.throws(() => resolveGemHomes([gem('bili')], { bili: '' }, { gemDataDir }), /gemHomesJson/)
  assert.throws(() => resolveGemHomes([gem('bili')], {}), /宝石数据目录/)
})

test('config.json：读写往返、0600、非法 JSON 带错误', (t) => {
  const home = temp(t)
  writeGemConfig(home, { dmPollSeconds: 30 })
  assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600)
  const read = readGemConfig(home)
  assert.deepEqual(read.config, { dmPollSeconds: 30 })
  assert.equal(read.configError, null)

  writeFileSync(join(home, 'config.json'), '{bad', 'utf8')
  const broken = readGemConfig(home)
  assert.equal(broken.config, null)
  assert.ok(broken.configError)

  assert.throws(() => writeGemConfig(home, []), /JSON 对象/)
})

test('凭据状态只暴露安全字段，不泄露 token / sessdata', (t) => {
  const home = temp(t)
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'credential.json'),
    JSON.stringify({ sessdata: 'SECRET', bili_jct: 'CSRF', uname: '小明', dedeuserid: '42', savedAt: '2026-11-17T00:00:00Z' }),
  )
  const status = readCredentialStatus(home)
  assert.equal(status.present, true)
  assert.equal(status.account.uname, '小明')
  assert.equal(status.account.dedeuserid, '42')
  assert.equal('sessdata' in status.account, false)
  assert.equal('bili_jct' in status.account, false)

  const wxHome = temp(t)
  mkdirSync(join(wxHome, 'auth'), { recursive: true })
  writeFileSync(join(wxHome, 'auth', 'token.json'), JSON.stringify({ token: 'SECRET', accountId: 'bot1', userId: 'u1' }))
  const wx = readCredentialStatus(wxHome)
  assert.equal(wx.account.accountId, 'bot1')
  assert.equal(wx.account.userId, 'u1')
  assert.equal('token' in wx.account, false)
})

test('gemSummaries 合并清单、配置、凭据、健康、config schema 与 token 状态', (t) => {
  const home = temp(t)
  writeGemConfig(home, { dmPollSeconds: 30 })
  const declaration = {
    fields: [{ key: 'dmPollSeconds', label: '私信轮询', type: 'number', default: 30, min: 15, max: 600 }],
  }
  const entry = gem('bili')
  entry.manifest.config = declaration
  const [summary] = gemSummaries({
    gems: [entry],
    gemHomes: { bili: home },
    gemDataDir: home,
    health: [{ id: 'bili', available: false, failures: 2, lastError: 'gem_unavailable', degradedUntil: 123 }],
    tokens: { bili: true },
  })
  assert.equal(summary.id, 'bili')
  assert.equal(summary.available, false)
  assert.equal(summary.lastError, 'gem_unavailable')
  assert.deepEqual(summary.config, { dmPollSeconds: 30 })
  assert.deepEqual(summary.configSchema, declaration)
  assert.equal(summary.tokenConfigured, true)
  assert.equal(summary.credential.present, false)
  assert.equal(summary.hasLoginRpc, false)
})

test('writeGemConfig 按声明校验，未知 key 保留', (t) => {
  const home = temp(t)
  const fields = [{ key: 'dmPollSeconds', label: '私信轮询', type: 'number', min: 15, max: 600 }]
  writeGemConfig(home, { dmPollSeconds: 30, legacy: 'kept' }, fields)
  assert.deepEqual(readGemConfig(home).config, { dmPollSeconds: 30, legacy: 'kept' })
  assert.throws(() => writeGemConfig(home, { dmPollSeconds: 5 }, fields), /不能小于 15/)
  assert.throws(() => writeGemConfig(home, { dmPollSeconds: '30' }, fields), /必须是数字/)
})
