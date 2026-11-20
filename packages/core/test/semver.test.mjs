import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chooseTargetVersion, compareSemver, satisfiesRange } from '../lib/semver.mjs'

test('semver：比较主次修订与预发布', () => {
  assert.equal(compareSemver('0.3.13', '0.3.13'), 0)
  assert.equal(compareSemver('0.3.13', '0.3.12'), 1)
  assert.equal(compareSemver('0.4.0', '0.3.99'), 1)
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1)
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.throws(() => compareSemver('v1.0.0', '1.0.0'), /semver/)
})

test('semver：范围只支持作者声明的比较符集合', () => {
  assert.equal(satisfiesRange('0.3.13', '>=0.3.0 <0.4.0'), true)
  assert.equal(satisfiesRange('0.4.0', '>=0.3.0 <0.4.0'), false)
  assert.equal(satisfiesRange('0.2.9', '>=0.3.0 <0.4.0'), false)
  assert.equal(satisfiesRange('0.3.13', '^0.3.0'), true)
  assert.equal(satisfiesRange('0.4.0', '^0.3.0'), false)
  assert.equal(satisfiesRange('0.0.3', '^0.0.3'), true)
  assert.equal(satisfiesRange('0.0.4', '^0.0.3'), false)
  assert.equal(satisfiesRange('0.3.9', '~0.3.3'), true)
  assert.equal(satisfiesRange('0.4.0', '~0.3.3'), false)
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true)
  assert.throws(() => satisfiesRange('1.2.3', '>=1.2 <2'), /semver/)
  assert.throws(() => satisfiesRange('1.2.3', ''), /非空/)
})

test('semver：目录 floor 与 registry latest 取高者，不降级', () => {
  assert.deepEqual(chooseTargetVersion({ floor: '0.1.1', latest: '0.1.2' }), { resolved: '0.1.2', action: 'install', noDowngrade: false })
  assert.deepEqual(chooseTargetVersion({ floor: '0.1.2', latest: '0.1.1', installed: '0.1.1' }), { resolved: '0.1.2', action: 'upgrade', noDowngrade: false })
  assert.deepEqual(chooseTargetVersion({ floor: '0.1.0', latest: '0.1.0', installed: '0.1.1' }), { resolved: '0.1.0', action: 'none', noDowngrade: true })
  assert.deepEqual(chooseTargetVersion({ floor: '0.1.0', latest: null, installed: '0.1.0' }), { resolved: '0.1.0', action: 'none', noDowngrade: false })
})
