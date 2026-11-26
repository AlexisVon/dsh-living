/**
 * SQLite schema and migrations. One connection is opened; all writes are
 * serialized by store.mjs because node:sqlite's API is synchronous.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SCHEMA_VERSION = 11

export function openDatabase(path, { readOnly = false, busyTimeoutMs = 3000 } = {}) {
  if (typeof path !== 'string' || path === '') throw new RangeError('数据库路径必填')
  if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {})
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  }
  return db
}

export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version
  if (current > SCHEMA_VERSION) {
    throw new RangeError(`life.db schema v${current} 高于当前插件支持的 v${SCHEMA_VERSION}；请升级 dsh-living 或改用兼容备份`)
  }
  if (current === SCHEMA_VERSION) return current
  for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
    transaction(db, () => {
      MIGRATIONS[version - 1](db)
      db.exec(`PRAGMA user_version = ${version}`)
    })
  }
  return SCHEMA_VERSION
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction may already be rolled back by SQLite.
    }
    throw error
  }
}

const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT,
        source TEXT,
        payload TEXT NOT NULL,
        session_id TEXT,
        refs TEXT
      );
      CREATE INDEX idx_events_ts ON events(ts);
      CREATE INDEX idx_events_kind_ts ON events(kind, ts);

      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        ts_start INTEGER,
        ts_end INTEGER,
        title TEXT,
        summary TEXT,
        importance INTEGER,
        event_ids TEXT
      );
      CREATE INDEX idx_episodes_ts ON episodes(ts_start);

      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        subject TEXT,
        predicate TEXT,
        object TEXT,
        confidence REAL,
        first_seen INTEGER,
        last_seen INTEGER,
        source TEXT,
        event_ids TEXT
      );
      CREATE INDEX idx_facts_subject ON facts(subject);

      CREATE TABLE facets (
        memory_kind TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        dim TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (memory_kind, memory_id, dim, value)
      );
      CREATE INDEX idx_facets_dim_value ON facets(dim, value);

      CREATE TABLE access (
        memory_kind TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        weight REAL NOT NULL
      );
      CREATE INDEX idx_access_memory ON access(memory_kind, memory_id, ts);

      CREATE TABLE cold (
        keyword TEXT NOT NULL,
        event_ids TEXT,
        label_20char TEXT,
        last_ts INTEGER,
        importance INTEGER,
        fidelity TEXT
      );
      CREATE INDEX idx_cold_keyword ON cold(keyword);

      CREATE TABLE anchors (
        round_id TEXT PRIMARY KEY,
        started_at INTEGER,
        ended_at INTEGER,
        trigger TEXT,
        trigger_detail TEXT,
        session_id TEXT,
        outcome TEXT,
        error_code TEXT
      );
      CREATE INDEX idx_anchors_started ON anchors(started_at);

      CREATE TABLE state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        gem TEXT NOT NULL,
        target TEXT,
        text TEXT,
        media TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        claimed_at INTEGER,
        acked_at INTEGER,
        external_id TEXT,
        failed_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX idx_outbox_due ON outbox(acked_at, failed_at, next_attempt_at);

      CREATE TABLE ingest_seen (
        gem TEXT NOT NULL,
        external_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (gem, external_id)
      );

      CREATE VIRTUAL TABLE memory_fts USING fts5(
        memory_kind UNINDEXED,
        memory_id UNINDEXED,
        tokens
      );
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE imported (
        key TEXT PRIMARY KEY,
        source TEXT,
        ts INTEGER,
        text TEXT
      );
    `)
  },
  (db) => {
    db.exec(`
      ALTER TABLE outbox ADD COLUMN decision TEXT;
      ALTER TABLE outbox ADD COLUMN rule_id TEXT;
      ALTER TABLE outbox ADD COLUMN reason TEXT;
      ALTER TABLE outbox ADD COLUMN verdict_source TEXT;
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE persona_versions (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        message TEXT,
        previous_id TEXT,
        text TEXT NOT NULL,
        diff TEXT
      );
      CREATE INDEX idx_persona_versions_kind_ts ON persona_versions(kind, ts);
    `)
  },
  (db) => {
    db.exec(`
      ALTER TABLE outbox ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
      CREATE INDEX idx_outbox_gem_visibility_created ON outbox(gem, visibility, created_at);
    `)
  },
  (db) => {
    db.exec(`
      ALTER TABLE outbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'proactive';
    `)
  },
  (db) => {
    db.exec(`
      ALTER TABLE episodes ADD COLUMN raw_refs TEXT;
      ALTER TABLE episodes ADD COLUMN confidence REAL NOT NULL DEFAULT 0.8;
      ALTER TABLE facts ADD COLUMN raw_refs TEXT;

      CREATE TABLE raw_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        kind TEXT NOT NULL,
        ts_start INTEGER NOT NULL,
        ts_end INTEGER NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        processed_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX idx_raw_segments_status_created ON raw_segments(status, created_at);

      CREATE TABLE memory_edges (
        id TEXT PRIMARY KEY,
        from_kind TEXT NOT NULL,
        from_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_id TEXT NOT NULL,
        note TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        raw_refs TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX idx_memory_edges_from ON memory_edges(from_kind, from_id, status);
      CREATE INDEX idx_memory_edges_to ON memory_edges(to_kind, to_id, status);
      CREATE UNIQUE INDEX idx_memory_edges_unique
        ON memory_edges(from_kind, from_id, relation, to_kind, to_id);

      CREATE VIEW memory_items AS
        SELECT 'episode' AS kind, id, title, summary AS description, importance,
               confidence, ts_start, ts_end, raw_refs, 'episode' AS source
          FROM episodes
        UNION ALL
        SELECT 'fact' AS kind, id, subject || ' ' || predicate || ' ' || object AS title,
               subject || ' ' || predicate || ' ' || object AS description, 0.5 AS importance,
               confidence, first_seen AS ts_start, last_seen AS ts_end, raw_refs, source
          FROM facts;
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE reports (
        date TEXT PRIMARY KEY,
        generated_at INTEGER NOT NULL,
        live INTEGER NOT NULL DEFAULT 0,
        json TEXT NOT NULL,
        markdown TEXT NOT NULL,
        html TEXT
      );
      CREATE INDEX idx_reports_generated ON reports(generated_at);
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE persona_docs (
        kind TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE journal_entries (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        ts INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_journal_entries_date_ts ON journal_entries(date, ts);
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE memory_vectors (
        source TEXT NOT NULL,
        id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT,
        text TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source, id)
      );
      CREATE INDEX idx_memory_vectors_model_ts ON memory_vectors(model, ts);
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('persistent','temp')),
        tag TEXT NOT NULL,
        text TEXT NOT NULL,
        core INTEGER NOT NULL DEFAULT 0,
        day TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_notes_tier_day ON notes(tier, day);
      CREATE INDEX idx_notes_tag ON notes(tag);
      CREATE UNIQUE INDEX idx_notes_persistent_seq ON notes(seq) WHERE tier = 'persistent';
      CREATE UNIQUE INDEX idx_notes_temp_slot ON notes(day, seq) WHERE tier = 'temp';
    `)
    const repair = repairMemoryTimestamps(db)
    if (repair.episodes > 0 || repair.facts > 0 || repair.cold > 0) {
      db.prepare('INSERT OR REPLACE INTO state(key, value) VALUES(?,?)').run('schema.repair.v11', JSON.stringify(repair))
      db.prepare(
        'INSERT OR REPLACE INTO events(id, ts, kind, actor, source, payload, session_id, refs) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        'ev_schema_v11_repair',
        Date.now(),
        'change',
        null,
        'living',
        JSON.stringify({
          text: `系统：记忆时间修复（episode ${repair.episodes} / fact ${repair.facts} / vector ${repair.vectors} / cold ${repair.cold}）`,
          meta: { silent: true, system: true, repair: 'v11' },
        }),
        null,
        '[]',
      )
    }
  },
]

function repairMemoryTimestamps(db) {
  const repair = { episodes: 0, facts: 0, cold: 0 }
  const segment = db.prepare('SELECT ts_start, ts_end FROM raw_segments WHERE id = ?')
  const updateEpisode = db.prepare('UPDATE episodes SET ts_start = ?, ts_end = ? WHERE id = ?')
  for (const row of db.prepare(
    "SELECT id, ts_start, ts_end, raw_refs FROM episodes WHERE raw_refs IS NOT NULL AND raw_refs != '[]' AND raw_refs != ''",
  ).all()) {
    const refs = parseRawRefs(row.raw_refs)
    const seg = refs.length > 0 ? segment.get(refs[0]) : null
    if (!seg) continue
    const start = clampRange(row.ts_start, seg.ts_start, seg.ts_end)
    const end = clampRange(row.ts_end ?? start, seg.ts_start, seg.ts_end)
    const lo = Math.min(start, end)
    const hi = Math.max(start, end)
    if (lo !== row.ts_start || hi !== row.ts_end) {
      updateEpisode.run(lo, hi, row.id)
      repair.episodes += 1
    }
  }
  const updateFact = db.prepare('UPDATE facts SET first_seen = ?, last_seen = ? WHERE id = ?')
  for (const row of db.prepare(
    "SELECT id, first_seen, last_seen, raw_refs FROM facts WHERE raw_refs IS NOT NULL AND raw_refs != '[]' AND raw_refs != ''",
  ).all()) {
    const refs = parseRawRefs(row.raw_refs)
    const seg = refs.length > 0 ? segment.get(refs[0]) : null
    if (!seg) continue
    const start = clampRange(row.first_seen ?? seg.ts_start, seg.ts_start, seg.ts_end)
    const end = clampRange(row.last_seen ?? row.first_seen ?? seg.ts_end, seg.ts_start, seg.ts_end)
    const lo = Math.min(start, end)
    const hi = Math.max(start, end)
    if (lo !== row.first_seen || hi !== row.last_seen) {
      updateFact.run(lo, hi, row.id)
      repair.facts += 1
    }
  }
  repair.vectors = db.prepare(
    "UPDATE memory_vectors SET ts = (SELECT e.ts_start FROM episodes e WHERE e.id = memory_vectors.id) WHERE source = 'items' AND kind = 'episode' AND EXISTS (SELECT 1 FROM episodes e WHERE e.id = memory_vectors.id) AND ts != (SELECT e.ts_start FROM episodes e WHERE e.id = memory_vectors.id)",
  ).run().changes
  repair.vectors += db.prepare(
    "UPDATE memory_vectors SET ts = (SELECT f.last_seen FROM facts f WHERE f.id = memory_vectors.id) WHERE source = 'items' AND kind = 'fact' AND EXISTS (SELECT 1 FROM facts f WHERE f.id = memory_vectors.id) AND ts != (SELECT f.last_seen FROM facts f WHERE f.id = memory_vectors.id)",
  ).run().changes
  repair.cold = db.prepare('SELECT COUNT(*) AS n FROM cold').get().n
  db.prepare('DELETE FROM cold').run()
  return repair
}

function parseRawRefs(value) {
  try {
    const parsed = JSON.parse(value ?? '[]')
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function clampRange(value, lo, hi) {
  if (!Number.isFinite(value)) return lo
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return value
  return Math.min(hi, Math.max(lo, value))
}
