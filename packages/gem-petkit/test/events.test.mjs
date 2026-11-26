import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alarmEvents, feedEvents } from '../lib/events.mjs'

const device = { id: '733807', name: '喂食器' }
const config = { foodLowLevel: 1, desiccantWarnDays: 7, batteryLowPercent: 20 }

test('events：完成出粮 silent，失败 ring，未完成跳过且去重', () => {
  const records = {
    feed: [{
      items: [
        {
          id: 's25200', time: 25200, amount: 30, name: '早餐', src: 1, eventId: 'e1',
          state: { realAmount: 30, errCode: 0, result: 0, completedAt: '2026-11-18T23:00:50.000+0000' },
        },
        {
          id: 'r40878-1', time: 40878, amount: 10, src: 3, eventId: 'e2',
          state: { realAmount: 10, errCode: 0, result: 0, completedAt: '2026-11-19T03:21:21.000+0000' },
        },
        {
          id: 's43200', time: 43200, amount: 40, name: '午餐', src: 1, eventId: 'e3',
          state: { realAmount: 0, errCode: 3, result: 1, completedAt: '2026-11-19T04:00:00.000+0000' },
        },
        { id: 's61200', time: 61200, amount: 30, name: '晚餐', src: 1, status: 0 },
      ],
    }],
  }
  const first = feedEvents(device, records)
  assert.equal(first.events.length, 3)
  assert.equal(first.events[0].text, '喂食器出粮 30 克（计划·早餐）')
  assert.equal(first.events[0].meta.silent, true)
  assert.equal(first.events[1].text, '喂食器出粮 10 克（手动）')
  assert.equal(first.events[2].text, '喂食器出粮失败：计划·午餐 40 克（错误码 3）')
  assert.equal(first.events[2].meta.silent, false)

  const second = feedEvents(device, records, first.seen)
  assert.equal(second.events.length, 0)
})

test('events：缺粮/干燥剂同日去重，故障按变化触发', () => {
  const state = {}
  const day = '20261119'
  const detail = { state: { food: 1, desiccantLeftDays: 5, pim: 1, errorCode: 0 } }
  const first = alarmEvents({ detail, config, state, device, day })
  assert.deepEqual(first.map((event) => event.meta.alarm), ['food_low', 'desiccant'])
  assert.equal(first[0].meta.silent, false)
  assert.equal(first[1].meta.silent, true)

  const second = alarmEvents({ detail, config, state, device, day })
  assert.equal(second.length, 0)

  const errored = alarmEvents({ detail: { state: { ...detail.state, errorCode: 3, errorMsg: 'jam' } }, config, state, device, day })
  assert.equal(errored.length, 1)
  assert.equal(errored[0].meta.alarm, 'error')
  assert.match(errored[0].text, /jam/)

  const same = alarmEvents({ detail: { state: { ...detail.state, errorCode: 3 } }, config, state, device, day })
  assert.equal(same.length, 0)

  const cleared = alarmEvents({ detail, config, state, device, day })
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0].meta.alarm, 'error_clear')
})

test('events：字符串错误码只在跳变时触发，重放同一跳变 id 不变', () => {
  const state = {}
  const day = '20261120'
  const detail = {
    state: {
      food: 5, desiccantLeftDays: 30, pim: 1,
      errorCode: 'blk_d', errorMsg: 'Food has piled up at the dispenser chute. Please clean it.',
    },
  }
  const before = structuredClone(state)
  const first = alarmEvents({ detail, config, state, device, day })
  assert.equal(first.length, 1)
  assert.equal(first[0].meta.alarm, 'error')
  assert.equal(first[0].meta.error_code, 'blk_d')
  assert.match(first[0].text, /piled up/)

  const replay = alarmEvents({ detail, config, state: before, device, day })
  assert.equal(replay[0].external_id, first[0].external_id)

  for (let i = 0; i < 5; i += 1) {
    assert.equal(alarmEvents({ detail, config, state, device, day }).length, 0)
  }

  const cleared = alarmEvents({ detail: { state: { ...detail.state, errorCode: 0, errorMsg: '' } }, config, state, device, day })
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0].meta.alarm, 'error_clear')

  const recurring = alarmEvents({ detail, config, state, device, day })
  assert.equal(recurring.length, 1)
  assert.notEqual(recurring[0].external_id, first[0].external_id)
})

test('events：升级前存下的数字错误码不会重复触发', () => {
  const state = { alarms: { errorCode: 3 } }
  const detail = { state: { food: 5, desiccantLeftDays: 30, pim: 1, errorCode: 3, errorMsg: 'jam' } }
  assert.equal(alarmEvents({ detail, config, state, device, day: '20261120' }).length, 0)
  assert.equal(state.alarms.errorCode, '3')
})

test('events：电池供电低电量只在 pim=2 时触发', () => {
  const state = {}
  const battery = alarmEvents({
    detail: { state: { food: 5, desiccantLeftDays: 30, pim: 2, batteryPower: 0, errorCode: 0 } },
    config, state, device, day: '20261119',
  })
  assert.deepEqual(battery.map((event) => event.meta.alarm), ['battery_low'])

  const mains = alarmEvents({
    detail: { state: { food: 5, desiccantLeftDays: 30, pim: 1, batteryPower: 0, errorCode: 0 } },
    config, state: {}, device, day: '20261119',
  })
  assert.equal(mains.length, 0)
})

test('events：粮仓空与粮量低措辞分开', () => {
  const low = alarmEvents({
    detail: { state: { food: 1, desiccantLeftDays: 30, pim: 1, errorCode: 0 } },
    config, state: {}, device, day: '20261126',
  })
  const lowEvent = low.find((event) => event.meta.alarm === 'food_low')
  assert.match(lowEvent.text, /粮量低/)
  const empty = alarmEvents({
    detail: { state: { food: 0, desiccantLeftDays: 30, pim: 1, errorCode: 0 } },
    config, state: {}, device, day: '20261126',
  })
  const emptyEvent = empty.find((event) => event.meta.alarm === 'food_low')
  assert.match(emptyEvent.text, /粮仓空了/)
})
