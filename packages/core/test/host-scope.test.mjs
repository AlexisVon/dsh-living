import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findScope } from '../lib/host-scope.mjs'

test('findScope 读取私有 dsh.scope symbol 的值', () => {
  const scope = { id: 'scope-1' }
  const key = Symbol('dsh.scope')
  assert.equal(findScope({ [key]: scope }), scope)
})

test('findScope 沿原型链查找，找不到返回 undefined', () => {
  const scope = { id: 'scope-2' }
  const key = Symbol('dsh.scope')
  const parent = { [key]: scope }
  const child = Object.create(parent)
  assert.equal(findScope(child), scope)
  assert.equal(findScope({}), undefined)
  assert.equal(findScope(null), undefined)
})
