import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import {
  PERSONA_LIMITS,
  readPersona,
  assemblePersona,
  writeSelf,
  writeCharter,
  clearSelf,
  appendJournal,
  importLegacyPersonaFiles,
} from '../lib/persona.mjs'

const TZ = 480
const NOW = Date.UTC(2026, 10, 17, 4) // 2026-11-17 12:00 UTC+8

function open(t) {
  const home = mkdtempSync(join(tmpdir(), 'living-persona-'))
  const store = createStore({ path: join(home, 'life.db'), now: () => NOW })
  t.after(async () => {
    await store.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, store }
}

test('self 存 DB；clearSelf 清空；空内容大声失败', async (t) => {
  const { store } = open(t)
  await writeSelf(store, '今天在想散热的事')
  assert.equal(readPersona(store, { now: NOW, tzOffsetMinutes: TZ }).self.trim(), '今天在想散热的事')

  await writeSelf(store, '今天换了风扇')
  assert.equal(readPersona(store, { now: NOW, tzOffsetMinutes: TZ }).self.trim(), '今天换了风扇')

  await clearSelf(store)
  assert.equal(readPersona(store, { now: NOW, tzOffsetMinutes: TZ }).self, '')
  await assert.rejects(() => writeSelf(store, '  '), RangeError)
})

test('charter 由人类侧写入；readPersona 原样返回', async (t) => {
  const { store } = open(t)
  await writeCharter(store, '我是谁：不替主人做决定')
  await writeSelf(store, 'self 内容')
  assert.equal(readPersona(store, { now: NOW, tzOffsetMinutes: TZ }).charter.trim(), '我是谁：不替主人做决定')
  await assert.rejects(() => writeCharter(store, '   '), RangeError)
})

test('journal 按日追加，跨日分开', async (t) => {
  const { store } = open(t)
  await appendJournal(store, '第一条', { now: NOW, tzOffsetMinutes: TZ })
  await appendJournal(store, '第二条', { now: NOW + 1000, tzOffsetMinutes: TZ })
  const persona = readPersona(store, { now: NOW, tzOffsetMinutes: TZ })
  assert.equal(persona.date, '2026-11-17')
  assert.equal(persona.journal.trim(), '第一条\n第二条')
  const next = readPersona(store, { now: NOW + 86400000, tzOffsetMinutes: TZ })
  assert.equal(next.journal, '')
})

test('旧文件一次性导入 DB', async (t) => {
  const { home, store } = open(t)
  writeFileSync(join(home, 'charter.md'), 'OLD CHARTER', 'utf8')
  writeFileSync(join(home, 'self.md'), 'OLD SELF', 'utf8')
  mkdirSync(join(home, 'journal'), { recursive: true })
  writeFileSync(join(home, 'journal', '2026-11-17.md'), '旧日记', 'utf8')
  await importLegacyPersonaFiles(store, home, { now: NOW })
  const persona = readPersona(store, { now: NOW, tzOffsetMinutes: TZ })
  assert.equal(persona.charter, 'OLD CHARTER')
  assert.equal(persona.self, 'OLD SELF')
  assert.equal(persona.journal, '旧日记')
})

test('组装顺序：charter → self → journal', () => {
  const { text } = assemblePersona({ charter: 'C', self: 'S', journal: 'J' })
  assert.ok(text.indexOf('charter') < text.indexOf('self'))
  assert.ok(text.indexOf('self') < text.indexOf('journal'))
  assert.ok(text.includes('## 你是谁'))
})

test('超预算时截断 journal 与 self，charter 保留', () => {
  const charter = `CHARTER ${'c'.repeat(120)}`
  const self = `SELF ${'s'.repeat(120)}`
  const journal = `JOURNAL ${'j'.repeat(120)}`
  const result = assemblePersona({ charter, self, journal }, { maxChars: 260 })
  assert.ok(result.text.length <= 260, `len=${result.text.length}`)
  assert.equal(result.truncated, true)
  assert.ok(result.text.includes(charter.slice(0, 40)))
})

test('缺少 DB 文档返回空串；空内容写 self 大声失败', async (t) => {
  const { store } = open(t)
  const persona = readPersona(store, { now: NOW, tzOffsetMinutes: TZ })
  assert.equal(persona.charter, '')
  assert.equal(persona.self, '')
  await assert.rejects(() => writeSelf(store, '  ', { now: NOW }), RangeError)
  await assert.rejects(() => appendJournal(store, ''), RangeError)
})

test('预算默认值与 ARCHITECTURE 一致', () => {
  assert.equal(PERSONA_LIMITS.maxChars, 6000)
})
