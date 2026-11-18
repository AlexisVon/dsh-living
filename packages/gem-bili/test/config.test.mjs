import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../lib/config.mjs'

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'living-bili-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('B站 ownerUid 从 config.json 读取，未配置为空（所有人都是外部）', (t) => {
  const home = temp(t)
  assert.equal(loadConfig(home).ownerUid, '')

  writeFileSync(join(home, 'config.json'), JSON.stringify({ ownerUid: 123456 }))
  assert.equal(loadConfig(home).ownerUid, '123456')

  writeFileSync(join(home, 'config.json'), JSON.stringify({ ownerUid: ' 987654 ' }))
  assert.equal(loadConfig(home).ownerUid, '987654')
})

test('B站 轮询参数仍按边界钳制', (t) => {
  const home = temp(t)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dmPollSeconds: 1, noticePollSeconds: 99999 }))
  const config = loadConfig(home)
  assert.equal(config.dmPollSeconds, 15)
  assert.equal(config.noticePollSeconds, 1800)
})
