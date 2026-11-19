import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MEMORY_DEFAULTS, parseMemoryParams, resolveMemoryParams } from '../lib/memory-config.mjs'

test('memory-config：空配置等于默认值', () => {
  assert.deepEqual(resolveMemoryParams({}), MEMORY_DEFAULTS)
  assert.deepEqual(parseMemoryParams(''), MEMORY_DEFAULTS)
  assert.deepEqual(parseMemoryParams('{}'), MEMORY_DEFAULTS)
})

test('memory-config：越界钳制，未知键忽略', () => {
  const p = resolveMemoryParams({
    metaPenaltyBands: 9,
    journalFactor: 2,
    leadChars: 5,
    tierLead: 0.2,
    tierBody: 0.9,
    relBand: 1,
    recallTopK: 100,
    halfLifeL2: 0,
    strength0: 0.8,
    strengthCap: 0.1,
    demoteStrength: 0.99,
    maxItems: 100,
    batchOther: 0,
    unknownKey: 123,
  })
  assert.equal(p.metaPenaltyBands, 2)
  assert.equal(p.journalFactor, 1)
  assert.equal(p.leadChars, 20)
  assert.equal(p.tierLead, 0.5)
  assert.equal(p.tierBody, 0.5, 'tierBody 不得超过 tierLead')
  assert.equal(p.relBand, 0.1)
  assert.equal(p.recallTopK, 20)
  assert.equal(p.halfLifeL2, 1)
  assert.equal(p.strengthCap, 0.8, 'cap 不得低于 strength0')
  assert.equal(p.demoteStrength, 0.8, 'demote 不得超过 strength0')
  assert.equal(p.maxItems, 50)
  assert.equal(p.batchOther, 1)
  assert.equal('unknownKey' in p, false)
})

test('memory-config：非法 JSON 大声失败', () => {
  assert.throws(() => parseMemoryParams('{oops'), /不是合法 JSON/)
  assert.throws(() => parseMemoryParams('[]'), /必须是 JSON 对象/)
  assert.throws(() => parseMemoryParams('null'), /必须是 JSON 对象/)
})
