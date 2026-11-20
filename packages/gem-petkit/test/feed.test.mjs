import { test } from 'node:test'
import assert from 'node:assert/strict'
import { feedWithVerification } from '../lib/feed.mjs'
import { PetkitError } from '../lib/errors.mjs'

function detail({ manual, real, errorCode = 0, feeding = 0 }) {
  return { state: { feedState: { addAmountTotal: manual, realAmountTotal: real }, errorCode, feeding } }
}

function harness(snapshots, { submit } = {}) {
  let clock = 0
  let index = 0
  const client = {
    detail: async () => {
      const shot = snapshots[Math.min(index, snapshots.length - 1)]
      index += 1
      return shot
    },
    manualFeed: async () => submit ?? { id: 'r40878-1' },
  }
  return {
    client,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
}

const config = { maxPortion: 20, dailyFeedCap: 40, feedVerifySeconds: 15 }
const device = { id: '733807', deviceType: 'd4h' }
const day = '20261119'

test('feed：realAmountTotal 增量确认 dispensed', async () => {
  const { client, now, sleep } = harness([
    detail({ manual: 30, real: 60 }),
    detail({ manual: 30, real: 60, feeding: 1 }),
    detail({ manual: 40, real: 70 }),
  ])
  const state = {}
  const result = await feedWithVerification({ client, device, amount: 10, config, state, day, now, sleep })
  assert.equal(result.status, 'dispensed')
  assert.equal(result.amount, 10)
  assert.deepEqual(result.evidence, { manualBefore: 30, manualAfter: 40, realBefore: 60, realAfter: 70 })
  assert.equal(state.pendingFeedAt, 0)
  assert.equal(state.gemFeeds.length, 1)
  assert.equal(state.gemFeeds[0].status, 'dispensed')
  assert.equal(state.gemFeeds[0].amount, 10)
})

test('feed：超时返回 unknown 并设置 pending', async () => {
  const { client, now, sleep } = harness([
    detail({ manual: 30, real: 60 }),
    detail({ manual: 30, real: 60 }),
  ])
  const state = {}
  const result = await feedWithVerification({ client, device, amount: 10, config, state, day, now, sleep })
  assert.equal(result.status, 'unknown')
  assert.match(result.message, /不要重试/)
  assert.equal(state.pendingFeedAt, 15_000)
  assert.equal(state.gemFeeds[0].status, 'unknown')
})

test('feed：单次与宝石日上限拒绝', async () => {
  const overPortion = await feedWithVerification({
    client: { detail: async () => detail({ manual: 0, real: 0 }), manualFeed: async () => ({}) },
    device, amount: 30, config, state: {}, day,
  })
  assert.equal(overPortion.status, 'rejected')

  const overDaily = await feedWithVerification({
    client: { detail: async () => detail({ manual: 0, real: 0 }), manualFeed: async () => ({}) },
    device,
    amount: 10,
    config,
    state: { gemFeeds: [{ day, amount: 35, status: 'dispensed' }] },
    day,
  })
  assert.equal(overDaily.status, 'rejected')
  assert.match(overDaily.message, /宝石今日已出 35 克/)
})

test('feed：App 手动不占宝石额度', async () => {
  const { client, now, sleep } = harness([
    detail({ manual: 35, real: 60 }),
    detail({ manual: 45, real: 70 }),
  ])
  const state = {}
  const result = await feedWithVerification({ client, device, amount: 10, config, state, day, now, sleep })
  assert.equal(result.status, 'dispensed')
  assert.equal(state.gemFeeds.length, 1)
  assert.equal(state.gemFeeds[0].status, 'dispensed')
})

test('feed：提交即落 gemFeeds 并触发保存回调', async () => {
  const { client, now, sleep } = harness([
    detail({ manual: 30, real: 60 }),
    detail({ manual: 40, real: 70 }),
  ])
  const state = {}
  const submitted = []
  const result = await feedWithVerification({
    client,
    device,
    amount: 10,
    config,
    state,
    day,
    now,
    sleep,
    onSubmitted: (entry) => submitted.push({ ...entry }),
  })
  assert.equal(result.status, 'dispensed')
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].status, 'submitted')
  assert.equal(submitted[0].amount, 10)
  assert.equal(state.gemFeeds[0].status, 'dispensed')
})

test('feed：未知后 60 秒内拒绝再次出粮', async () => {
  const result = await feedWithVerification({
    client: { detail: async () => detail({ manual: 0, real: 0 }), manualFeed: async () => ({}) },
    device, amount: 10, config, state: { pendingFeedAt: 99_000 }, now: () => 100_000, day,
  })
  assert.equal(result.status, 'rejected')
  assert.match(result.message, /尚未确认/)
})

test('feed：设备报错返回 failed', async () => {
  const { client, now, sleep } = harness([
    detail({ manual: 30, real: 60 }),
    detail({ manual: 30, real: 60, errorCode: 3 }),
  ])
  const state = {}
  const result = await feedWithVerification({ client, device, amount: 10, config, state, day, now, sleep })
  assert.equal(result.status, 'failed')
  assert.match(result.message, /错误码 3/)
  assert.equal(state.gemFeeds[0].status, 'failed')
})

test('feed：字符串错误码返回 failed 且保留原始码', async () => {
  const { client, now, sleep } = harness([
    detail({ manual: 30, real: 60 }),
    detail({ manual: 30, real: 60, errorCode: 'blk_d' }),
  ])
  const state = {}
  const result = await feedWithVerification({ client, device, amount: 10, config, state, day, now, sleep })
  assert.equal(result.status, 'failed')
  assert.match(result.message, /错误码 blk_d/)
  assert.equal(state.gemFeeds[0].status, 'failed')
})

test('feed：登录态失效返回 gem_cookie_expired', async () => {
  const client = {
    detail: async () => detail({ manual: 30, real: 60 }),
    manualFeed: async () => {
      throw new PetkitError(5, 'session expired')
    },
  }
  const state = {}
  const result = await feedWithVerification({ client, device, amount: 10, config, state, day })
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'gem_cookie_expired')
  assert.equal(state.gemFeeds.length, 0)
})

test('feed：提交网络错误返回 unknown 并设置 pending', async () => {
  const client = {
    detail: async () => detail({ manual: 30, real: 60 }),
    manualFeed: async () => {
      throw new Error('socket hang up')
    },
  }
  const state = {}
  const result = await feedWithVerification({ client, device, amount: 10, config, state, day, now: () => 1000 })
  assert.equal(result.status, 'unknown')
  assert.equal(state.pendingFeedAt, 1000)
  assert.equal(state.gemFeeds[0].status, 'unknown')
  assert.equal(state.gemFeeds[0].recordId, null)
})
