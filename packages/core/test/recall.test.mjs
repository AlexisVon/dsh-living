import { test } from 'node:test'
import assert from 'node:assert/strict'

import { recall, RECALL_CHANNELS } from '../lib/recall.mjs'

const MIN = 60000
const NOW = Date.UTC(2026, 10, 17, 12)

function item(overrides = {}) {
  return {
    id: 'm1',
    kind: 'event',
    layer: 'L2',
    text: '显卡散热坏了，换了风扇',
    ts: NOW - 60 * MIN,
    lastTs: NOW - 60 * MIN,
    source: 'bili',
    confidence: 0.8,
    importance: 0.3,
    facets: {},
    ...overrides,
  }
}

test('R1：线索命中才浮现，结果带 why_recalled', () => {
  const r = recall({ items: [item()], cue: { text: '散热' }, channels: ['R1'], now: NOW })
  assert.equal(r.recalled.length, 1)
  assert.ok(r.recalled[0].why.some((w) => w.startsWith('R1:cued_by=')))
})

test('没有通道命中 → 不浮现（不是翻档案）', () => {
  const r = recall({ items: [item()], cue: { text: '股票' }, channels: ['R1'], now: NOW })
  assert.equal(r.recalled.length, 0)
  assert.equal(r.notFound, true)
})

test('通道可被显式关闭', () => {
  const r = recall({ items: [item({ text: '普通事件' })], cue: {}, channels: ['R1'], now: NOW })
  assert.equal(r.recalled.length, 0, 'R3 未启用时，仅靠近因不得浮现')
})

test('R3：近因与首因', () => {
  const recent = item({ id: 'recent', text: '刚刚发生', ts: NOW - MIN, lastTs: NOW - MIN })
  const r = recall({ items: [recent], cue: {}, channels: ['R3'], now: NOW })
  assert.equal(r.recalled[0].id, 'recent')
  assert.ok(r.recalled[0].why.some((w) => w.startsWith('R3:')))
})

test('R4：显著度插队需要过阈值', () => {
  const salient = item({ id: 'big', text: '被当众羞辱那次', importance: 0.9 })
  const plain = item({ id: 'plain', text: '普通一天', importance: 0.2 })
  const r = recall({ items: [plain, salient], cue: {}, channels: ['R4'], now: NOW })
  assert.equal(r.recalled[0].id, 'big')
  assert.ok(r.recalled[0].why.includes('R4:salient=0.90'))
})

test('R5：人物与场景', () => {
  const m = item({ id: 'p', text: '和小明约好周末看展', target: 'uid_9', facets: { who: ['uid_9'] } })
  const r = recall({ items: [m], cue: { participants: ['uid_9'] }, channels: ['R5'], now: NOW })
  assert.equal(r.recalled[0].id, 'p')
  assert.ok(r.recalled[0].why.includes('R5:participant=uid_9'))
})

test('R2：情绪同频（无 affect 时不生效）', () => {
  const withMood = item({ id: 'mood', text: '那天很难过', affect: { sad: 1 } })
  const r = recall({ items: [withMood], cue: {}, mood: { sad: 1 }, channels: ['R2'], now: NOW })
  assert.equal(r.recalled.length, 1)
  assert.ok(r.recalled[0].why.includes('R2:mood_congruent=sad'))

  const noAffect = recall({ items: [item({ affect: undefined })], cue: {}, mood: { sad: 1 }, channels: ['R2'], now: NOW })
  assert.equal(noAffect.recalled.length, 0)
})

test('R6：时间链回溯，每条只加一次', () => {
  const anchor = item({ id: 'a', text: '散热坏了', ts: NOW - 20 * MIN })
  const neighbor = item({ id: 'b', text: '买了个风扇', ts: NOW - 10 * MIN })
  const without = recall({ items: [anchor, neighbor], cue: { text: '散热' }, channels: ['R1'], now: NOW })
  const withChain = recall({ items: [anchor, neighbor], cue: { text: '散热' }, channels: ['R1', 'R6'], now: NOW })
  const b1 = withChain.recalled.find((r) => r.id === 'b')
  assert.ok(b1, '相邻事件应被顺带想起')
  assert.ok(b1.why.includes('R6:chain'))
  const baseB = without.recalled.find((r) => r.id === 'b')
  assert.ok(!baseB || b1.score > baseB.score)
})

test('R7：无线索时的不自主闪回，概率由 RNG 注入', () => {
  const big = item({ id: 'big', text: '第一次见面', importance: 0.8 })
  const seq = (...values) => {
    let i = 0
    return () => values[Math.min(i++, values.length - 1)]
  }
  const hit = recall({ items: [big], cue: {}, channels: ['R7'], now: NOW, rng: seq(0.1, 0.1) })
  assert.equal(hit.recalled[0]?.id, 'big')
  assert.ok(hit.recalled[0].why.includes('R7:spontaneous'))

  const miss = recall({ items: [big], cue: {}, channels: ['R7'], now: NOW, rng: seq(0.9) })
  assert.equal(miss.recalled.length, 0)
})

test('R8：模糊命中返回舌尖碎片，并标注细节缺失', () => {
  const m = item({ text: '显卡散热坏了' })
  const cue = { text: '散热 天气 你好 世界 和平 股票 音乐' }
  const r = recall({ items: [m], cue, channels: ['R1', 'R8'], now: NOW })
  assert.ok(r.partialHits.length >= 1)
  assert.equal(r.partialHits[0].note.includes('细节想不全'), true)
})

test('有明确线索时语义占主导，近期无关事件不能压过', () => {
  const relevant = item({ id: 'rel', text: '显卡散热坏了', ts: NOW - 3 * 86400000, importance: 0.2 })
  const recentNoise = item({ id: 'noise', text: '今天天气很好', ts: NOW - MIN, importance: 0.2 })
  const r = recall({ items: [recentNoise, relevant], cue: { text: '散热' }, channels: ['R1', 'R3'], now: NOW })
  assert.equal(r.recalled[0].id, 'rel')
  assert.deepEqual(r.recalled.map((entry) => entry.id), ['rel'], '零语义的近因条目不应浮现')
})

test('有线索时零语义的显著条目不得插队', () => {
  const relevant = item({ id: 'rel', text: '显卡散热坏了' })
  const salientNoise = item({ id: 'salient', text: '被当众羞辱', importance: 0.95, ts: NOW - MIN })
  const r = recall({ items: [salientNoise, relevant], cue: { text: '散热' }, now: NOW })
  assert.deepEqual(r.recalled.map((entry) => entry.id), ['rel'])
})

test('journal 原文排在归一化记忆之后', () => {
  const fact = item({ id: 'fact', kind: 'fact', text: '散热坏了', source: 'fact', confidence: 0.8 })
  const journal = item({
    id: 'journal',
    kind: 'journal',
    text: '散热坏了',
    source: 'journal',
    confidence: 1,
    recallChannels: ['R1'],
  })
  const r = recall({ items: [journal, fact], cue: { text: '散热' }, channels: ['R1'], now: NOW })
  assert.equal(r.recalled[0].id, 'fact')
})

test('topK 限制正式回忆条数；why 永不为空', () => {
  const items = Array.from({ length: 8 }, (_, i) => item({ id: `m${i}`, text: `散热第 ${i} 次` }))
  const r = recall({ items, cue: { text: '散热' }, channels: ['R1'], topK: 3, now: NOW })
  assert.equal(r.recalled.length, 3)
  for (const entry of r.recalled) assert.ok(entry.why.length > 0)
})

test('通道表包含 R1–R8 与 G1', () => {
  assert.deepEqual(Object.keys(RECALL_CHANNELS), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'G1'])
})

test('单 token：标题命中 > 前 40 字 > 正文', () => {
  const titled = item({ id: 'titled', kind: 'episode', title: '米糕', text: '米糕：重点色银渐层，懒' })
  const lead = item({ id: 'lead', text: '米糕是重点色银渐层，懒，爱睡' })
  const body = item({ id: 'body', text: `${'今天聊了很多别的事，'.repeat(4)}最后顺带提到米糕` })
  const r = recall({ items: [body, lead, titled], cue: { text: '米糕' }, now: NOW })
  assert.deepEqual(r.recalled.map((entry) => entry.id), ['titled', 'lead', 'body'])
})

test('显著度只能在相关度档内插队', () => {
  const precise = item({ id: 'precise', text: '米糕是重点色银渐层猫', importance: 0.2 })
  const vague = item({ id: 'vague', text: `${'今天聊了很多别的事，'.repeat(4)}最后顺带提到米糕`, importance: 0.95 })
  const r = recall({ items: [vague, precise], cue: { text: '米糕' }, now: NOW })
  assert.deepEqual(r.recalled.map((entry) => entry.id), ['precise', 'vague'])
})

test('meta 条目降到最低档但保留', () => {
  const meta = item({ id: 'meta', kind: 'episode', title: '记忆整合自检：米糕', text: '记忆整合自检：米糕', importance: 0.95, meta: true })
  const real = item({ id: 'real', text: `${'今天聊了很多别的事，'.repeat(4)}最后顺带提到米糕`, importance: 0.2 })
  const r = recall({ items: [meta, real], cue: { text: '米糕' }, now: NOW })
  assert.equal(r.recalled[0].id, 'real')
  assert.ok(r.recalled.some((entry) => entry.id === 'meta'))
})

test('多 token：稀有 token 权重更高', () => {
  const common = Array.from({ length: 8 }, (_, index) => item({ id: `c${index}`, text: `散热第 ${index} 次` }))
  const rare = item({ id: 'rare', text: '显卡' })
  const r = recall({ items: [...common, rare], cue: { text: '散热 显卡' }, now: NOW })
  assert.equal(r.recalled[0].id, 'rare')
})

test('journal 相关度更高时不被 0.65 折价埋没', () => {
  const journal = item({ id: 'j', kind: 'journal', text: '米糕是重点色银渐层', source: 'journal', confidence: 1, recallChannels: ['R1'] })
  const fact = item({ id: 'f', kind: 'fact', text: `${'今天聊了很多别的事，'.repeat(4)}最后顺带提到米糕` })
  const r = recall({ items: [fact, journal], cue: { text: '米糕' }, now: NOW })
  assert.equal(r.recalled[0].id, 'j')
})
