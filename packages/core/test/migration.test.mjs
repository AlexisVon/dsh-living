import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createStore } from '../lib/store.mjs'
import { SCHEMA_VERSION } from '../lib/db.mjs'

test('v11 迁移：按 raw 段修正 episode/fact 时间，清空 cold，并留下可见事件', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'living-migration-'))
  const path = join(dir, 'life.db')
  const first = createStore({ path })
  await first.appendRawSegment({
    id: 'raw_x',
    sessionId: 's_x',
    kind: 'rest',
    tsStart: 1000,
    tsEnd: 2000,
    payload: { source: 'session', messages: [] },
  })
  await first.appendEpisode({
    id: 'ep_x',
    tsStart: 999999,
    tsEnd: 999999,
    title: '越界',
    summary: '越界',
    importance: 0.5,
    rawRefs: ['raw_x'],
  })
  await first.upsertFact({
    id: 'fact_x',
    subject: 'a',
    predicate: 'b',
    object: 'c',
    confidence: 0.8,
    firstSeen: 0,
    lastSeen: 0,
    source: 'x',
    rawRefs: ['raw_x'],
  })
  await first.appendCold({ keyword: 'k', label20: '旧线索', lastTs: 0, importance: 0.5 })
  await first.close()

  const raw = new DatabaseSync(path)
  raw.exec('DROP TABLE notes; PRAGMA user_version = 10;')
  raw.close()

  const second = createStore({ path })
  t.after(async () => {
    await second.close()
    rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(second.schemaVersion(), SCHEMA_VERSION)
  assert.equal(second.listEpisodes({ limit: 10 })[0].tsStart, 2000)
  const fact = second.listFacts({ limit: 10 })[0]
  assert.equal(fact.firstSeen, 1000)
  assert.equal(fact.lastSeen, 1000)
  assert.equal(second.listCold({ limit: 10 }).length, 0)
  assert.deepEqual(second.getState('schema.repair.v11'), { episodes: 1, facts: 1, vectors: 0, cold: 1 })
  assert.ok(second.listEvents({ kind: 'change', limit: 10 }).some((event) => event.id === 'ev_schema_v11_repair'))
  assert.equal(second.countNotes({}), 0)
})
