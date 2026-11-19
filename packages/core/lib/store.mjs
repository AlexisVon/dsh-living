/**
 * The only write path into life.db. node:sqlite is synchronous, so every write
 * goes through one serial queue; concurrent transactions would block until timeout.
 */

import { randomUUID } from 'node:crypto'
import { FAILURE_CODES, isRetryable } from 'dsh-living-protocol'
import { openDatabase, transaction } from './db.mjs'
import { lineDiff } from './diff.mjs'
import { tokenizeForIndex } from './text.mjs'

export const OUTBOX_LEASE_MS = 5 * 60 * 1000

export function createStore({ path, now = Date.now } = {}) {
  const db = openDatabase(path)
  let tail = Promise.resolve()
  let closed = false

  const withWriteLock = (fn) => {
    const next = tail.then(fn)
    tail = next.catch(() => {})
    return next
  }

  const store = {
    withWriteLock,

    async appendEvent(input) {
      return withWriteLock(() => transaction(db, () => insertEvent(input, input?.ts ?? now())))
    },

    async recordIngest({ gem, externalId, event, nowMs = now() }) {
      if (typeof gem !== 'string' || gem === '') throw new RangeError('ingest.gem 必填')
      if (typeof externalId !== 'string' || externalId === '') throw new RangeError('ingest.externalId 必填')
      return withWriteLock(() =>
        transaction(db, () => {
          const eventId = event?.id ?? `ev_${randomUUID()}`
          const inserted = db
            .prepare('INSERT OR IGNORE INTO ingest_seen(gem, external_id, event_id, seen_at) VALUES(?,?,?,?)')
            .run(gem, externalId, eventId, nowMs).changes
          if (inserted === 0) return { accepted: false, eventId: null }
          insertEvent({ ...event, id: eventId }, event?.ts ?? nowMs)
          return { accepted: true, eventId }
        }),
      )
    },

    getEvent(id) {
      const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id)
      return row ? mapEvent(row) : null
    },

    listEvents({ since = null, until = null, kind = null, kinds = null, limit = 100, order = 'asc' } = {}) {
      if (order !== 'asc' && order !== 'desc') throw new RangeError(`events.order 只能是 asc/desc: ${order}`)
      if (kind && kinds) throw new RangeError('events.kind 与 events.kinds 只能二选一')
      const where = []
      const params = []
      if (Number.isFinite(since)) {
        where.push('ts >= ?')
        params.push(since)
      }
      if (Number.isFinite(until)) {
        where.push('ts <= ?')
        params.push(until)
      }
      if (kind) {
        where.push('kind = ?')
        params.push(kind)
      }
      const limitValue = assertLimit(limit)
      const selectedKinds = kinds ? (Array.isArray(kinds) ? kinds.map(String) : null) : null
      if (kinds && selectedKinds === null) throw new RangeError('events.kinds 必须是数组')
      if (selectedKinds?.length === 0) return []
      if (selectedKinds) {
        where.push(`kind IN (${selectedKinds.map(() => '?').join(',')})`)
        params.push(...selectedKinds)
      }
      params.push(limitValue)
      const direction = order === 'desc' ? 'DESC' : 'ASC'
      const sql = `SELECT * FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts ${direction} LIMIT ?`
      const rows = db.prepare(sql).all(...params).map(mapEvent)
      return direction === 'DESC' ? rows.reverse() : rows
    },

    getState(key) {
      const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key)
      return row ? JSON.parse(row.value) : null
    },

    async setState(key, value) {
      if (typeof key !== 'string' || key === '') throw new RangeError('state.key 必填')
      return withWriteLock(() => {
        db.prepare('INSERT INTO state(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
          key,
          JSON.stringify(value),
        )
        return value
      })
    },

    listState() {
      const out = {}
      for (const row of db.prepare('SELECT key, value FROM state').all()) out[row.key] = JSON.parse(row.value)
      return out
    },

    async appendAnchor(input) {
      const a = normalizeAnchor(input)
      return withWriteLock(() => {
        db.prepare(
          `INSERT INTO anchors(round_id, started_at, ended_at, trigger, trigger_detail, session_id, outcome, error_code)
           VALUES(?,?,?,?,?,?,?,?)`,
        ).run(a.roundId, a.startedAt, a.endedAt, a.trigger, a.triggerDetail, a.sessionId, a.outcome, a.errorCode)
        return a.roundId
      })
    },

    async updateAnchor(roundId, patch) {
      const columns = { endedAt: 'ended_at', outcome: 'outcome', errorCode: 'error_code', sessionId: 'session_id', triggerDetail: 'trigger_detail' }
      const sets = []
      const params = []
      for (const [key, column] of Object.entries(columns)) {
        if (patch?.[key] === undefined) continue
        sets.push(`${column} = ?`)
        params.push(patch[key])
      }
      if (sets.length === 0) throw new RangeError('updateAnchor 至少需要一个字段')
      for (const key of Object.keys(patch ?? {})) {
        if (!(key in columns)) throw new RangeError(`未知的 anchor 字段: ${key}`)
      }
      return withWriteLock(() => {
        const changes = db.prepare(`UPDATE anchors SET ${sets.join(', ')} WHERE round_id = ?`).run(...params, roundId).changes
        if (changes === 0) throw new RangeError(`未知的 round_id: ${roundId}`)
        return true
      })
    },

    listRounds({ since = null, until = null, limit = 100 } = {}) {
      const where = []
      const params = []
      if (Number.isFinite(since)) {
        where.push('started_at >= ?')
        params.push(since)
      }
      if (Number.isFinite(until)) {
        where.push('started_at <= ?')
        params.push(until)
      }
      params.push(assertLimit(limit))
      const sql = `SELECT * FROM anchors${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`
      return db.prepare(sql).all(...params).map(mapRound)
    },

    async closeOrphanAnchors(nowMs = now(), { code = 'interrupted' } = {}) {
      return withWriteLock(() =>
        transaction(db, () => {
          const rows = db.prepare('SELECT round_id FROM anchors WHERE ended_at IS NULL').all()
          if (rows.length === 0) return []
          const update = db.prepare(
            'UPDATE anchors SET ended_at = ?, outcome = ?, error_code = ? WHERE round_id = ? AND ended_at IS NULL',
          )
          for (const row of rows) update.run(nowMs, 'interrupted', code, row.round_id)
          return rows.map((row) => row.round_id)
        }),
      )
    },

    async appendEpisode({ id = null, tsStart, tsEnd = null, title = '', summary = '', importance = 0, confidence = 0.8, eventIds = [], rawRefs = [] }) {
      if (!Number.isFinite(tsStart)) throw new RangeError('episode.tsStart 必填')
      const episodeId = id ?? `ep_${randomUUID()}`
      return withWriteLock(() =>
        transaction(db, () => {
          db.prepare(
            `INSERT INTO episodes(id, ts_start, ts_end, title, summary, importance, confidence, event_ids, raw_refs)
             VALUES(?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               ts_start = excluded.ts_start,
               ts_end = COALESCE(excluded.ts_end, episodes.ts_end),
               title = excluded.title,
               summary = excluded.summary,
               importance = excluded.importance,
               confidence = excluded.confidence,
               event_ids = excluded.event_ids,
               raw_refs = excluded.raw_refs`,
          ).run(episodeId, tsStart, tsEnd, title, summary, importance, confidence, JSON.stringify(eventIds), JSON.stringify(rawRefs))
          indexMemory('episode', episodeId, `${title} ${summary}`)
          return episodeId
        }),
      )
    },

    listEpisodes({ since = null, until = null, limit = 100, order = 'asc' } = {}) {
      if (order !== 'asc' && order !== 'desc') throw new RangeError(`episodes.order 只能是 asc/desc: ${order}`)
      const where = []
      const params = []
      if (Number.isFinite(since)) {
        where.push('ts_start >= ?')
        params.push(since)
      }
      if (Number.isFinite(until)) {
        where.push('ts_start <= ?')
        params.push(until)
      }
      params.push(assertLimit(limit))
      const direction = order === 'desc' ? 'DESC' : 'ASC'
      const sql = `SELECT * FROM episodes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts_start ${direction} LIMIT ?`
      const rows = db.prepare(sql).all(...params).map(mapEpisode)
      return direction === 'DESC' ? rows.reverse() : rows
    },

    async upsertFact({
      id = null,
      subject = '',
      predicate = '',
      object = '',
      confidence = 0.75,
      firstSeen = now(),
      lastSeen = null,
      source = null,
      eventIds = [],
      rawRefs = [],
    }) {
      const factId = id ?? `fact_${randomUUID()}`
      return withWriteLock(() =>
        transaction(db, () => {
          db.prepare(
            `INSERT INTO facts(id, subject, predicate, object, confidence, first_seen, last_seen, source, event_ids, raw_refs)
             VALUES(?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               subject = excluded.subject,
               predicate = excluded.predicate,
               object = excluded.object,
               confidence = excluded.confidence,
               first_seen = COALESCE(excluded.first_seen, facts.first_seen),
               last_seen = COALESCE(excluded.last_seen, facts.last_seen),
               source = COALESCE(excluded.source, facts.source),
               event_ids = excluded.event_ids,
               raw_refs = excluded.raw_refs`,
          ).run(factId, subject, predicate, object, confidence, firstSeen, lastSeen, source, JSON.stringify(eventIds), JSON.stringify(rawRefs))
          indexMemory('fact', factId, `${subject} ${predicate} ${object}`)
          return factId
        }),
      )
    },

    listFacts({ subject = null, limit = 100 } = {}) {
      const params = []
      let sql = 'SELECT * FROM facts'
      if (subject) {
        sql += ' WHERE subject = ?'
        params.push(subject)
      }
      sql += ' ORDER BY last_seen DESC LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map(mapFact)
    },

    async appendRawSegment({
      id,
      sessionId = null,
      kind,
      tsStart,
      tsEnd = null,
      payload = {},
      status = 'pending',
      createdAt = now(),
    }) {
      if (typeof id !== 'string' || id === '') throw new RangeError('raw segment id 必填')
      if (typeof kind !== 'string' || kind === '') throw new RangeError('raw segment kind 必填')
      if (!Number.isFinite(tsStart)) throw new RangeError('raw segment tsStart 必须是数字')
      return withWriteLock(() => {
        const changes = db.prepare(
          `INSERT OR IGNORE INTO raw_segments(id, session_id, kind, ts_start, ts_end, payload, status, created_at)
           VALUES(?,?,?,?,?,?,?,?)`,
        ).run(id, sessionId, kind, tsStart, tsEnd, JSON.stringify(payload), status, createdAt).changes
        return changes > 0
      })
    },

    countRawSegments({ status = null } = {}) {
      if (status) return db.prepare('SELECT COUNT(*) AS n FROM raw_segments WHERE status = ?').get(status).n
      return db.prepare('SELECT COUNT(*) AS n FROM raw_segments').get().n
    },

    listJournalRawIds({ status = 'processed' } = {}) {
      const rows = db.prepare("SELECT id FROM raw_segments WHERE kind = 'journal' AND status = ?").all(status)
      return rows.map((row) => String(row.id).replace(/^raw_journal_/, ''))
    },

    listRawSegments({ status = null, limit = 50 } = {}) {
      const params = []
      let sql = 'SELECT * FROM raw_segments'
      if (status) {
        sql += ' WHERE status = ?'
        params.push(status)
      }
      sql += ' ORDER BY created_at ASC, id ASC LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map(mapRawSegment)
    },

    async markRawSegment(id, { status = 'processed', processedAt = now(), error = null } = {}) {
      if (typeof id !== 'string' || id === '') throw new RangeError('raw segment id 必填')
      return withWriteLock(() => {
        const changes = db.prepare(
          `UPDATE raw_segments
              SET status = ?, processed_at = ?, attempts = attempts + 1, last_error = ?
            WHERE id = ?`,
        ).run(status, status === 'processed' ? processedAt : null, error, id).changes
        if (changes === 0) throw new RangeError(`未知 raw segment id: ${id}`)
      })
    },

    async appendMemoryEdge({
      id = `edge_${randomUUID()}`,
      fromKind,
      fromId,
      relation,
      toKind,
      toId,
      note = null,
      confidence = 0.5,
      rawRefs = [],
      model = null,
      createdAt = now(),
      status = 'active',
    }) {
      if (typeof fromKind !== 'string' || fromKind === '') throw new RangeError('edge.fromKind 必填')
      if (typeof fromId !== 'string' || fromId === '') throw new RangeError('edge.fromId 必填')
      if (typeof relation !== 'string' || relation === '') throw new RangeError('edge.relation 必填')
      if (typeof toKind !== 'string' || toKind === '') throw new RangeError('edge.toKind 必填')
      if (typeof toId !== 'string' || toId === '') throw new RangeError('edge.toId 必填')
      return withWriteLock(() =>
        transaction(db, () => {
          db.prepare(
            `INSERT OR REPLACE INTO memory_edges(id, from_kind, from_id, relation, to_kind, to_id, note, confidence, raw_refs, model, created_at, status)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(id, fromKind, fromId, relation, toKind, toId, note, confidence, JSON.stringify(rawRefs), model, createdAt, status)
          return id
        }),
      )
    },

    countMemoryItems({ kind = null } = {}) {
      if (kind) return db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE kind = ?').get(kind).n
      return db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n
    },

    listMemoryItems({ kind = null, limit = 100 } = {}) {
      const params = []
      let sql = 'SELECT * FROM memory_items'
      if (kind) {
        sql += ' WHERE kind = ?'
        params.push(kind)
      }
      sql += ' ORDER BY ts_start ASC LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map((row) => ({
        kind: row.kind,
        id: row.id,
        title: row.title,
        description: row.description,
        importance: row.importance,
        confidence: row.confidence,
        tsStart: row.ts_start,
        tsEnd: row.ts_end,
        rawRefs: JSON.parse(row.raw_refs ?? '[]'),
        source: row.source,
      }))
    },

    listAllMemoryEdges({ status = 'active', limit = 100 } = {}) {
      const params = []
      let sql = 'SELECT * FROM memory_edges'
      if (status) {
        sql += ' WHERE status = ?'
        params.push(status)
      }
      sql += ' ORDER BY created_at DESC LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map((row) => {
        const edge = mapMemoryEdge(row, { kind: row.from_kind, id: row.from_id })
        return { ...edge, direction: 'out', otherKind: row.to_kind, otherId: row.to_id }
      })
    },

    getMemoryItem({ kind, id } = {}) {
      if (typeof kind !== 'string' || typeof id !== 'string') throw new RangeError('memory item kind/id 必填')
      const row = db.prepare('SELECT * FROM memory_items WHERE kind = ? AND id = ?').get(kind, id)
      if (!row) return null
      const facets = {}
      for (const facet of db.prepare('SELECT dim, value FROM facets WHERE memory_kind = ? AND memory_id = ?').all(kind, id)) {
        (facets[facet.dim] ??= []).push(facet.value)
      }
      return {
        kind: row.kind,
        id: row.id,
        title: row.title,
        description: row.description,
        importance: row.importance,
        confidence: row.confidence,
        tsStart: row.ts_start,
        tsEnd: row.ts_end,
        rawRefs: JSON.parse(row.raw_refs ?? '[]'),
        source: row.source,
        facets,
      }
    },

    countMemoryEdges({ status = 'active' } = {}) {
      if (status) return db.prepare('SELECT COUNT(*) AS n FROM memory_edges WHERE status = ?').get(status).n
      return db.prepare('SELECT COUNT(*) AS n FROM memory_edges').get().n
    },

    listMemoryEdges({ kind, id, direction = 'both', status = 'active', limit = 50 } = {}) {
      if (typeof kind !== 'string' || kind === '') throw new RangeError('edge.kind 必填')
      if (typeof id !== 'string' || id === '') throw new RangeError('edge.id 必填')
      const clauses = []
      const params = []
      if (direction === 'out' || direction === 'both') {
        clauses.push('(from_kind = ? AND from_id = ?)')
        params.push(kind, id)
      }
      if (direction === 'in' || direction === 'both') {
        clauses.push('(to_kind = ? AND to_id = ?)')
        params.push(kind, id)
      }
      let sql = `SELECT * FROM memory_edges WHERE (${clauses.join(' OR ')})`
      if (status) {
        sql += ' AND status = ?'
        params.push(status)
      }
      sql += ' ORDER BY confidence DESC, created_at DESC LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map((row) => mapMemoryEdge(row, { kind, id }))
    },

    async setFacets(memoryKind, memoryId, facets) {
      if (!memoryKind || !memoryId) throw new RangeError('facets 需要 memoryKind 与 memoryId')
      return withWriteLock(() =>
        transaction(db, () => {
          db.prepare('DELETE FROM facets WHERE memory_kind = ? AND memory_id = ?').run(memoryKind, memoryId)
          const insert = db.prepare('INSERT OR IGNORE INTO facets(memory_kind, memory_id, dim, value) VALUES(?,?,?,?)')
          for (const [dim, value] of Object.entries(facets ?? {})) {
            for (const v of Array.isArray(value) ? value : [value]) {
              if (v != null && String(v) !== '') insert.run(memoryKind, memoryId, dim, String(v))
            }
          }
        }),
      )
    },

    getFacets(memoryKind, memoryId) {
      const out = {}
      const rows = db.prepare('SELECT dim, value FROM facets WHERE memory_kind = ? AND memory_id = ?').all(memoryKind, memoryId)
      for (const row of rows) (out[row.dim] ??= []).push(row.value)
      return out
    },

    async appendAccess(memoryKind, memoryId, { ts = now(), kind, weight = 1 } = {}) {
      if (!memoryKind || !memoryId) throw new RangeError('access 需要 memoryKind 与 memoryId')
      if (typeof kind !== 'string' || kind === '') throw new RangeError('access.kind 必填')
      return withWriteLock(() => {
        db.prepare('INSERT INTO access(memory_kind, memory_id, ts, kind, weight) VALUES(?,?,?,?,?)').run(
          memoryKind,
          memoryId,
          ts,
          kind,
          weight,
        )
      })
    },

    listAccess(memoryKind, memoryId, { limit = 100 } = {}) {
      return db
        .prepare('SELECT * FROM access WHERE memory_kind = ? AND memory_id = ? ORDER BY ts DESC LIMIT ?')
        .all(memoryKind, memoryId, assertLimit(limit))
        .map((row) => ({ ts: row.ts, kind: row.kind, weight: row.weight }))
    },

    async appendCold({ keyword, eventIds = [], label20 = '', lastTs = null, importance = 0, fidelity = 'low' }) {
      if (typeof keyword !== 'string' || keyword === '') throw new RangeError('cold.keyword 必填')
      return withWriteLock(() => {
        db.prepare('INSERT INTO cold(keyword, event_ids, label_20char, last_ts, importance, fidelity) VALUES(?,?,?,?,?,?)').run(
          keyword,
          JSON.stringify(eventIds),
          label20,
          lastTs,
          importance,
          fidelity,
        )
      })
    },

    listCold({ keyword = null, limit = 100 } = {}) {
      const params = []
      let sql = 'SELECT * FROM cold'
      if (keyword) {
        sql += ' WHERE keyword = ?'
        params.push(keyword)
      }
      sql += ' ORDER BY last_ts DESC LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map(mapCold)
    },

    /** Append a persona snapshot; `diff` against the previous version is computed unless supplied. */
    getPersonaDoc(kind) {
      const row = db.prepare('SELECT * FROM persona_docs WHERE kind = ?').get(String(kind ?? ''))
      return row ? { kind: row.kind, text: row.text, updatedAt: row.updated_at } : null
    },

    async setPersonaDoc({ kind, text, updatedAt = now() }) {
      if (!['charter', 'self'].includes(kind)) throw new RangeError('persona doc kind 必须是 charter / self')
      if (typeof text !== 'string') throw new RangeError('persona doc text 必填')
      return withWriteLock(() => {
        db.prepare(
          `INSERT INTO persona_docs(kind, text, updated_at) VALUES(?,?,?)
           ON CONFLICT(kind) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        ).run(kind, text, updatedAt)
      })
    },

    listJournalEntries({ date = null, limit = 1000 } = {}) {
      const params = []
      let sql = 'SELECT * FROM journal_entries'
      if (date) {
        sql += ' WHERE date = ?'
        params.push(date)
      }
      sql += ' ORDER BY ts ASC, created_at ASC LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map((row) => ({
        id: row.id,
        date: row.date,
        ts: row.ts,
        text: row.text,
        source: row.source,
        createdAt: row.created_at,
      }))
    },

    async appendJournalEntry({ id = `jr_${randomUUID()}`, date, ts = now(), text, source = null, createdAt = now() }) {
      if (typeof date !== 'string' || date === '') throw new RangeError('journal.date 必填')
      if (typeof text !== 'string' || text.trim() === '') throw new RangeError('journal.text 不能为空')
      return withWriteLock(() => {
        db.prepare(
          `INSERT OR IGNORE INTO journal_entries(id, date, ts, text, source, created_at)
           VALUES(?,?,?,?,?,?)`,
        ).run(id, date, ts, String(text).trim(), source, createdAt)
        return id
      })
    },

    async appendPersonaVersion({ id = `pv_${randomUUID()}`, ts = now(), kind, actor, action, message = null, text, diff = null }) {
      if (!['charter', 'self'].includes(kind)) throw new RangeError('persona version kind 必须是 charter / self')
      if (!['human', 'agent'].includes(actor)) throw new RangeError('persona version actor 必须是 human / agent')
      if (typeof action !== 'string' || action === '') throw new RangeError('persona version action 必填')
      if (typeof text !== 'string') throw new RangeError('persona version text 必填')
      return withWriteLock(() => transaction(db, () => {
        const previous = db.prepare(
          'SELECT * FROM persona_versions WHERE kind = ? ORDER BY ts DESC, rowid DESC LIMIT 1',
        ).get(kind)
        if (previous && previous.text === text && diff == null) {
          return { ...mapPersonaVersion(previous, { withText: true }), unchanged: true }
        }
        const computed = diff ?? lineDiff(previous?.text ?? '', text)
        db.prepare(
          'INSERT INTO persona_versions(id, ts, kind, actor, action, message, previous_id, text, diff) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(id, ts, kind, actor, action, message, previous?.id ?? null, text, computed)
        return { id, ts, kind, actor, action, message, previousId: previous?.id ?? null, diff: computed }
      }))
    },

    listPersonaVersions({ kind = null, limit = 30 } = {}) {
      const where = kind ? ' WHERE kind = ?' : ''
      const params = kind ? [kind, assertLimit(limit)] : [assertLimit(limit)]
      return db.prepare(`SELECT id, ts, kind, actor, action, message, previous_id, diff FROM persona_versions${where} ORDER BY ts DESC, rowid DESC LIMIT ?`)
        .all(...params)
        .map((row) => mapPersonaVersion(row))
    },

    getPersonaVersion(id) {
      if (typeof id !== 'string' || id === '') throw new RangeError('persona version id 必填')
      const row = db.prepare('SELECT * FROM persona_versions WHERE id = ?').get(id)
      return row ? mapPersonaVersion(row, { withText: true }) : null
    },

    async recordImport({ key, source = null, ts = now(), text }) {
      if (typeof key !== 'string' || key === '') throw new RangeError('import.key 必填')
      if (typeof text !== 'string' || text === '') throw new RangeError('import.text 必填')
      return withWriteLock(() =>
        transaction(db, () => {
          const inserted = db.prepare('INSERT OR IGNORE INTO imported(key, source, ts, text) VALUES(?,?,?,?)').run(
            key,
            source,
            ts,
            text,
          ).changes
          if (inserted === 0) return { accepted: false, eventId: null }
          const eventId = `imp_${key}`
          insertEvent({ id: eventId, kind: 'import', ts, source: 'import', payload: { text, origin: source } }, ts)
          return { accepted: true, eventId }
        }),
      )
    },

    async enqueueOutbox({
      gem,
      to,
      text,
      media = null,
      id = null,
      createdAt = now(),
      nextAttemptAt = null,
      visibility = 'private',
      origin = 'proactive',
      decision = null,
      ruleId = null,
      reason = null,
      verdictSource = null,
    }) {
      if (typeof gem !== 'string' || gem === '') throw new RangeError('outbox.gem 必填')
      if (typeof to !== 'string' || to === '') throw new RangeError('outbox.to 必填')
      const outboxId = id ?? `out_${randomUUID()}`
      return withWriteLock(() => {
        db.prepare(
          `INSERT INTO outbox(id, gem, target, text, media, visibility, origin, created_at, next_attempt_at, decision, rule_id, reason, verdict_source)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          outboxId,
          gem,
          to,
          text ?? '',
          media == null ? null : JSON.stringify(media),
          visibility ?? 'private',
          origin ?? 'proactive',
          createdAt,
          nextAttemptAt ?? createdAt,
          decision,
          ruleId,
          reason,
          verdictSource,
        )
        return outboxId
      })
    },

    async deferOutbox(id, nextAttemptAt, reason = null) {
      if (typeof id !== 'string' || id === '') throw new RangeError('outbox.id 必填')
      if (!Number.isFinite(nextAttemptAt)) throw new RangeError('nextAttemptAt 必须是数字')
      return withWriteLock(() => {
        const changes = db
          .prepare('UPDATE outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?')
          .run(nextAttemptAt, reason, id).changes
        if (changes === 0) throw new RangeError(`未知的 outbox id: ${id}`)
      })
    },

    async approveOutbox(id, nowMs = now()) {
      if (typeof id !== 'string' || id === '') throw new RangeError('outbox.id 必填')
      return withWriteLock(() =>
        transaction(db, () => {
          const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id)
          if (!row) throw new RangeError(`未知的 outbox id: ${id}`)
          const changes = db
            .prepare(
              `UPDATE outbox SET next_attempt_at = ?, last_error = NULL,
                 decision = CASE WHEN decision = 'review' THEN 'send' ELSE decision END
               WHERE id = ? AND acked_at IS NULL AND failed_at IS NULL`,
            )
            .run(nowMs, id).changes
          if (changes === 0) throw new RangeError(`不可放行的 outbox id: ${id}`)
          insertEvent(
            {
              id: `ev_${randomUUID()}`,
              kind: 'outbound_approved',
              ts: nowMs,
              source: 'living',
              payload: {
                outboxId: id,
                gem: row.gem,
                decision: row.decision ?? 'review',
                ruleId: row.rule_id ?? null,
                verdictSource: row.verdict_source ?? null,
                reason: row.reason ?? null,
              },
            },
            nowMs,
          )
        }),
      )
    },

    async rejectOutbox(id, reason = 'rejected', nowMs = now()) {
      if (typeof id !== 'string' || id === '') throw new RangeError('outbox.id 必填')
      return withWriteLock(() =>
        transaction(db, () => {
          const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id)
          if (!row) throw new RangeError(`未知的 outbox id: ${id}`)
          const changes = db
            .prepare('UPDATE outbox SET failed_at = ?, last_error = ? WHERE id = ? AND acked_at IS NULL')
            .run(nowMs, reason, id).changes
          if (changes === 0) throw new RangeError(`不可拒绝的 outbox id: ${id}`)
          insertEvent(
            {
              id: `ev_${randomUUID()}`,
              kind: 'outbound_rejected',
              ts: nowMs,
              source: 'living',
              payload: {
                outboxId: id,
                gem: row.gem,
                decision: row.decision ?? 'review',
                ruleId: row.rule_id ?? null,
                verdictSource: row.verdict_source ?? null,
                reason,
              },
            },
            nowMs,
          )
        }),
      )
    },

    async claimOutbox({ gem, limit = 20, nowMs = now() }) {
      if (typeof gem !== 'string' || gem === '') throw new RangeError('outbox.gem 必填')
      return withWriteLock(() =>
        transaction(db, () => {
          const rows = db
            .prepare(
              `SELECT * FROM outbox
               WHERE gem = ? AND acked_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?
                 AND (decision IS NULL OR decision <> 'review')
               ORDER BY created_at ASC LIMIT ?`,
            )
            .all(gem, nowMs, assertLimit(limit))
          const update = db.prepare('UPDATE outbox SET attempts = attempts + 1, claimed_at = ?, next_attempt_at = ? WHERE id = ?')
          for (const row of rows) update.run(nowMs, nowMs + OUTBOX_LEASE_MS, row.id)
          return rows.map((row) => mapOutbox(row, row.attempts + 1))
        }),
      )
    },

    getOutbox(id) {
      const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id)
      return row ? mapOutbox(row, row.attempts) : null
    },

    countPendingProactiveOutbox({ gem } = {}) {
      if (typeof gem !== 'string' || gem === '') throw new RangeError('outbox.gem 必填')
      return db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE gem = ? AND origin = 'proactive' AND acked_at IS NULL AND failed_at IS NULL")
        .get(gem).n
    },

    listOutbox({ gem = null, limit = 100 } = {}) {
      const params = []
      let sql = 'SELECT * FROM outbox'
      if (gem) {
        sql += ' WHERE gem = ?'
        params.push(gem)
      }
      sql += ' ORDER BY created_at DESC LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map((row) => ({
        ...mapOutbox(row, row.attempts),
        createdAt: row.created_at,
        nextAttemptAt: row.next_attempt_at,
        ackedAt: row.acked_at,
        failedAt: row.failed_at,
        lastError: row.last_error,
      }))
    },

    async ackOutbox({ id, ok, code = null, externalId = null, nowMs = now() }) {
      if (typeof id !== 'string' || id === '') throw new RangeError('ack.id 必填')
      return withWriteLock(() =>
        transaction(db, () => {
          const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id)
          if (!row) throw new RangeError(`未知的 outbox id: ${id}`)
          if (row.acked_at != null) return { id, ok: true, retryable: false, duplicate: true }
          if (row.failed_at != null) return { id, ok: false, retryable: false, duplicate: true }
          if (ok === true) {
            db.prepare('UPDATE outbox SET acked_at = ?, external_id = ?, last_error = NULL WHERE id = ?').run(nowMs, externalId, id)
            return { id, ok: true, retryable: false, duplicate: false }
          }
          const retryable = isRetryable(code ?? FAILURE_CODES.UNKNOWN)
          if (retryable) {
            db.prepare('UPDATE outbox SET last_error = ?, next_attempt_at = ? WHERE id = ?').run(code, nowMs + OUTBOX_LEASE_MS, id)
          } else {
            db.prepare('UPDATE outbox SET last_error = ?, failed_at = ? WHERE id = ?').run(code, nowMs, id)
          }
          return { id, ok: false, retryable, duplicate: false }
        }),
      )
    },

    searchMemory(tokens, { kinds = null, limit = 20 } = {}) {
      const list = [...new Set((Array.isArray(tokens) ? tokens : tokenizeForIndex(tokens)).filter(Boolean))]
      if (list.length === 0) return []
      const match = list.map((token) => `"${String(token).replaceAll('"', '""')}"`).join(' OR ')
      const params = [match]
      let sql = 'SELECT memory_kind, memory_id, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ?'
      if (kinds?.length) {
        sql += ` AND memory_kind IN (${kinds.map(() => '?').join(',')})`
        params.push(...kinds)
      }
      sql += ' ORDER BY rank LIMIT ?'
      params.push(assertLimit(limit))
      return db.prepare(sql).all(...params).map((row) => ({ kind: row.memory_kind, id: row.memory_id, rank: row.rank }))
    },

    async upsertReport({ date, generatedAt = now(), live = false, report, markdown, html = null }) {
      if (typeof date !== 'string' || date === '') throw new RangeError('report.date 必填')
      if (!report || typeof report !== 'object') throw new RangeError('report.report 必填')
      if (typeof markdown !== 'string') throw new RangeError('report.markdown 必填')
      return withWriteLock(() => {
        db.prepare(
          `INSERT INTO reports(date, generated_at, live, json, markdown, html)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(date) DO UPDATE SET
             generated_at = excluded.generated_at,
             live = excluded.live,
             json = excluded.json,
             markdown = excluded.markdown,
             html = excluded.html`,
        ).run(date, generatedAt, live ? 1 : 0, JSON.stringify(report), markdown, html)
        return date
      })
    },

    listReportDates() {
      return db.prepare('SELECT date FROM reports ORDER BY date ASC').all().map((row) => row.date)
    },

    getReport(date) {
      const row = db.prepare('SELECT * FROM reports WHERE date = ?').get(String(date ?? ''))
      if (!row) return null
      return { ...JSON.parse(row.json), live: row.live === 1, markdown: row.markdown, html: row.html ?? undefined }
    },

    getReportHtml(date) {
      const row = db.prepare('SELECT html FROM reports WHERE date = ?').get(String(date ?? ''))
      return row?.html ?? null
    },

    schemaVersion() {
      return db.prepare('PRAGMA user_version').get().user_version
    },

    snapshotTo(path) {
      if (typeof path !== 'string' || path === '') throw new RangeError('snapshot path 必填')
      return withWriteLock(() => {
        db.prepare('VACUUM INTO ?').run(path)
        return path
      })
    },

    async close() {
      if (closed) return
      closed = true
      await tail
      db.close()
    },
  }

  function insertEvent(input, ts) {
    if (!input || typeof input.kind !== 'string' || input.kind === '') throw new RangeError('event.kind 必填')
    if (!Number.isFinite(ts)) throw new RangeError('event.ts 必须是数字')
    const id = input.id ?? `ev_${randomUUID()}`
    const payload = JSON.stringify(input.payload ?? {})
    const refs = JSON.stringify(input.refs ?? [])
    db.prepare(
      'INSERT INTO events(id, ts, kind, actor, source, payload, session_id, refs) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, ts, input.kind, input.actor ?? null, input.source ?? null, payload, input.sessionId ?? null, refs)
    indexMemory('event', id, `${input.kind} ${input.text ?? ''} ${payload}`)
    return id
  }

  function indexMemory(kind, id, text) {
    db.prepare('DELETE FROM memory_fts WHERE memory_kind = ? AND memory_id = ?').run(kind, id)
    const tokens = tokenizeForIndex(text).join(' ')
    if (tokens) db.prepare('INSERT INTO memory_fts(memory_kind, memory_id, tokens) VALUES(?,?,?)').run(kind, id, tokens)
  }

  return store
}

function assertLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError(`limit 必须是正整数: ${limit}`)
  return limit
}

function mapEvent(row) {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    actor: row.actor,
    source: row.source,
    payload: JSON.parse(row.payload),
    sessionId: row.session_id,
    refs: JSON.parse(row.refs ?? '[]'),
  }
}

function normalizeAnchor(input) {
  if (!input || typeof input.roundId !== 'string' || input.roundId === '') throw new RangeError('anchor.roundId 必填')
  if (!Number.isFinite(input.startedAt)) throw new RangeError('anchor.startedAt 必须是数字')
  return {
    roundId: input.roundId,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    trigger: input.trigger ?? null,
    triggerDetail: input.triggerDetail == null ? null : JSON.stringify(input.triggerDetail),
    sessionId: input.sessionId ?? null,
    outcome: input.outcome ?? null,
    errorCode: input.errorCode ?? null,
  }
}

function mapRound(row) {
  return {
    roundId: row.round_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    trigger: row.trigger,
    triggerDetail: row.trigger_detail == null ? null : JSON.parse(row.trigger_detail),
    sessionId: row.session_id,
    outcome: row.outcome,
    errorCode: row.error_code,
  }
}

function mapEpisode(row) {
  return {
    id: row.id,
    tsStart: row.ts_start,
    tsEnd: row.ts_end,
    title: row.title,
    summary: row.summary,
    importance: row.importance,
    confidence: row.confidence,
    eventIds: JSON.parse(row.event_ids ?? '[]'),
    rawRefs: JSON.parse(row.raw_refs ?? '[]'),
  }
}

function mapFact(row) {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    source: row.source,
    eventIds: JSON.parse(row.event_ids ?? '[]'),
    rawRefs: JSON.parse(row.raw_refs ?? '[]'),
  }
}

function mapRawSegment(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    tsStart: row.ts_start,
    tsEnd: row.ts_end,
    payload: JSON.parse(row.payload),
    status: row.status,
    createdAt: row.created_at,
    processedAt: row.processed_at,
    attempts: row.attempts,
    lastError: row.last_error,
  }
}

function mapMemoryEdge(row, { kind, id }) {
  const outgoing = row.from_kind === kind && row.from_id === id
  return {
    id: row.id,
    fromKind: row.from_kind,
    fromId: row.from_id,
    relation: row.relation,
    toKind: row.to_kind,
    toId: row.to_id,
    note: row.note,
    confidence: row.confidence,
    rawRefs: JSON.parse(row.raw_refs ?? '[]'),
    model: row.model,
    createdAt: row.created_at,
    status: row.status,
    direction: outgoing ? 'out' : 'in',
    otherKind: outgoing ? row.to_kind : row.from_kind,
    otherId: outgoing ? row.to_id : row.from_id,
  }
}

function mapPersonaVersion(row, { withText = false } = {}) {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    actor: row.actor,
    action: row.action,
    message: row.message ?? null,
    previousId: row.previous_id ?? null,
    diff: row.diff ?? '',
    ...(withText ? { text: row.text } : {}),
  }
}

function mapCold(row) {
  return {
    keyword: row.keyword,
    eventIds: JSON.parse(row.event_ids ?? '[]'),
    label20: row.label_20char,
    lastTs: row.last_ts,
    importance: row.importance,
    fidelity: row.fidelity,
  }
}

function mapOutbox(row, attempts) {
  return {
    id: row.id,
    gem: row.gem,
    to: row.target,
    text: row.text,
    media: row.media == null ? null : JSON.parse(row.media),
    visibility: row.visibility ?? 'private',
    origin: row.origin ?? 'proactive',
    attempts,
    decision: row.decision ?? null,
    ruleId: row.rule_id ?? null,
    reason: row.reason ?? null,
    verdictSource: row.verdict_source ?? null,
  }
}
