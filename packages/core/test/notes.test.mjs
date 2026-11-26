import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { NOTES_LIMITS, formatNotesPrompt, noteCode, normalizeNoteText, normalizeTag, shiftDay } from '../lib/notes.mjs'

function open(t) {
  const dir = mkdtempSync(join(tmpdir(), 'living-notes-'))
  const store = createStore({ path: join(dir, 'life.db'), now: () => 1_800_000_000_000 })
  t.after(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('notes：tag/text 上限大声失败', () => {
  assert.equal(normalizeTag('猫粮'), '猫粮')
  assert.equal(normalizeNoteText('  一条   规则  '), '一条 规则')
  assert.throws(() => normalizeTag('一二三四五六'), /上限 5 字/)
  assert.throws(() => normalizeNoteText('字'.repeat(NOTES_LIMITS.textChars + 1)), /上限 40 字/)
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28')
})

test('notes：槽位取最小空闲，删除留空不重排，持久与临时各自编号', async (t) => {
  const store = open(t)
  const p1 = await store.addNote({ tier: 'persistent', tag: 'a', text: '一' })
  const p2 = await store.addNote({ tier: 'persistent', tag: 'b', text: '二' })
  const p3 = await store.addNote({ tier: 'persistent', tag: 'c', text: '三' })
  assert.deepEqual([p1.seq, p2.seq, p3.seq], [1, 2, 3])
  await store.deleteNote(p2.id)
  const p4 = await store.addNote({ tier: 'persistent', tag: 'd', text: '四' })
  assert.equal(p4.seq, 2, '删除留下的空槽优先复用')
  assert.deepEqual([p1.seq, p3.seq, p4.seq], [1, 3, 2], '其余条目编号不重排')

  const t1 = await store.addNote({ tier: 'temp', tag: 'x', text: '甲', day: '2026-11-26' })
  const t2 = await store.addNote({ tier: 'temp', tag: 'y', text: '乙', day: '2026-11-26' })
  const t3 = await store.addNote({ tier: 'temp', tag: 'z', text: '丙', day: '2026-11-27' })
  assert.deepEqual([t1.seq, t2.seq, t3.seq], [1, 2, 1], '临时按天独立编号')
  assert.equal(store.getNoteBySeq({ tier: 'temp', seq: 2, day: '2026-11-26' }).id, t2.id)
  assert.equal(store.getNoteBySeq({ tier: 'temp', seq: 2, day: '2026-11-27' }), null)
})

test('notes：CRUD、promote/demote 重新分配槽位与容量上限', async (t) => {
  const store = open(t)
  const p1 = await store.addNote({ tier: 'persistent', tag: '窗口回复', text: '窗口里打的字就在窗口回', core: true })
  const p2 = await store.addNote({ tier: 'persistent', tag: '猫粮', text: '先看粉料比例，再看蛋白' })
  assert.equal(p1.core, true)
  assert.deepEqual([p1.seq, p2.seq], [1, 2])
  assert.equal(store.countNotes({ tier: 'persistent' }), 2)
  assert.equal(store.countNotes({ tier: 'persistent', core: true }), 1)

  const temp = await store.addNote({ tier: 'temp', tag: '猫粮', text: '明天问虎子体重', day: '2026-11-26' })
  assert.equal(temp.day, '2026-11-26')
  assert.equal(temp.seq, 1)
  assert.equal(store.countNotes({ tier: 'temp', day: '2026-11-26' }), 1)

  const updated = await store.updateNote(p2.id, { text: '先看粉料比例，再看蛋白和脂肪' })
  assert.match(updated.text, /脂肪/)
  assert.equal(updated.seq, 2, '更新不动槽位')

  const promoted = await store.promoteNote(temp.id, { core: false })
  assert.equal(promoted.tier, 'persistent')
  assert.equal(promoted.day, null)
  assert.equal(promoted.seq, 3, '升持久取持久组最小空槽')

  const demoted = await store.demoteNote(promoted.id, { day: '2026-11-26' })
  assert.equal(demoted.tier, 'temp')
  assert.equal(demoted.core, false)
  assert.equal(demoted.seq, 1, '降临时取当天最小空槽')

  assert.deepEqual(await store.deleteNote(p2.id), { removed: true })
  assert.deepEqual(await store.deleteNote('missing'), { removed: false })

  for (let index = store.countNotes({ tier: 'persistent' }); index < NOTES_LIMITS.persistentMax; index += 1) {
    await store.addNote({ tier: 'persistent', tag: `t${index % 9}`, text: `规则${index}` })
  }
  await assert.rejects(
    () => store.addNote({ tier: 'persistent', tag: '溢出', text: '再加一条' }),
    /持久笔记已满/,
  )
})

test('notes：临时每天 10 条、过期清理保留今天和昨天', async (t) => {
  const store = open(t)
  for (let index = 0; index < NOTES_LIMITS.tempPerDay; index += 1) {
    await store.addNote({ tier: 'temp', tag: '今天', text: `事${index}`, day: '2026-11-26' })
  }
  await assert.rejects(
    () => store.addNote({ tier: 'temp', tag: '溢出', text: '再来', day: '2026-11-26' }),
    /今天临时笔记已满/,
  )
  await store.addNote({ tier: 'temp', tag: '昨天', text: '昨天的事', day: '2026-11-25' })
  await store.addNote({ tier: 'temp', tag: '前天', text: '前天的事', day: '2026-11-24' })

  const pruned = await store.pruneTempNotes({ keepDays: ['2026-11-26', '2026-11-25'] })
  assert.equal(pruned, 1)
  assert.equal(store.countNotes({ tier: 'temp', day: '2026-11-26' }), NOTES_LIMITS.tempPerDay)
  assert.equal(store.countNotes({ tier: 'temp', day: '2026-11-25' }), 1)
  assert.equal(store.countNotes({ tier: 'temp', day: '2026-11-24' }), 0)
})

test('notes：code 由视图日期决定，B 之外为 null', () => {
  const window = { today: '2026-11-26', yesterday: '2026-11-25' }
  assert.equal(noteCode({ tier: 'persistent', seq: 3 }, window), 'S3')
  assert.equal(noteCode({ tier: 'temp', seq: 2, day: '2026-11-26' }, window), 'A2')
  assert.equal(noteCode({ tier: 'temp', seq: 1, day: '2026-11-25' }, window), 'B1')
  assert.equal(noteCode({ tier: 'temp', seq: 4, day: '2026-11-24' }, window), null)
})

test('notes：prompt 注入 core 全文、关键词索引与 A/B 全文', () => {
  const persistent = [
    { id: 'p1', seq: 1, tier: 'persistent', tag: '窗口回复', text: '窗口里打的字就在窗口回', core: true },
    { id: 'p2', seq: 2, tier: 'persistent', tag: '猫粮', text: '先看粉料比例', core: false },
    { id: 'p3', seq: 3, tier: 'persistent', tag: '猫粮', text: '蛋白只作参考', core: false },
  ]
  const today = [{ id: 't1', seq: 1, tier: 'temp', tag: '猫粮', text: '明天问体重', day: '2026-11-26' }]
  const yesterday = [{ id: 't2', seq: 2, tier: 'temp', tag: 'B站', text: '先读评论树', day: '2026-11-25' }]
  const text = formatNotesPrompt({ persistent, today, yesterday })
  assert.match(text, /## 笔记（S 3\/50 · A 1\/10 · B 1（只读））/)
  assert.match(text, /S1 窗口里打的字就在窗口回/)
  assert.doesNotMatch(text, /S2 先看粉料比例/, '非 core 只进索引，不注入全文')
  assert.match(text, /猫粮 S2 A1/)
  assert.match(text, /B站 B1/)
  assert.match(text, /A1 明天问体重/)
  assert.match(text, /B2 先读评论树/)
  assert.match(text, /### B 昨天（只读）/)
  assert.equal(formatNotesPrompt({}), '')
})

test('notes：持久/core 满时大声拒绝', async (t) => {
  const store = open(t)
  await assert.rejects(
    () => store.addNote({ tier: 'temp', tag: 'x', text: 'x', core: true, day: '2026-11-26' }),
    /临时笔记不能设 core/,
  )
  for (let index = 0; index < NOTES_LIMITS.coreMax; index += 1) {
    await store.addNote({ tier: 'persistent', tag: '核心', text: `核心${index}`, core: true })
  }
  await assert.rejects(
    () => store.addNote({ tier: 'persistent', tag: '核心', text: '再来', core: true }),
    /core 笔记已满/,
  )
})
