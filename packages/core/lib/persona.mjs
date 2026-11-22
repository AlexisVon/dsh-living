/**
 * Persona stored in life.db: charter is human-only and read-only; self is
 * rewritten by the agent at night (version snapshots + diffs in persona_versions);
 * journal is append-only per day.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './clock.mjs'

export const PERSONA_LIMITS = Object.freeze({ maxChars: 6000 })

/** Legacy file paths, only used to import pre-DB persona files. */
export function personaPaths(home) {
  if (typeof home !== 'string' || home === '') throw new RangeError('persona home 必填')
  const journalDir = join(home, 'journal')
  return {
    home,
    charter: join(home, 'charter.md'),
    self: join(home, 'self.md'),
    journalDir,
    journalFor: (date) => join(journalDir, `${date}.md`),
  }
}

export function readPersona(store, { now = Date.now(), tzOffsetMinutes = null } = {}) {
  if (!store) throw new RangeError('readPersona 需要 store')
  const tz = tzOffsetMinutes ?? -new Date().getTimezoneOffset()
  const date = dayKey(now, tz)
  const journal = store.listJournalEntries({ date, limit: 10000 })
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join('\n')
  return {
    charter: store.getPersonaDoc('charter')?.text ?? '',
    self: store.getPersonaDoc('self')?.text ?? '',
    journal,
    date,
  }
}

/** One-time import of legacy charter.md / self.md / journal/*.md into the DB. */
export async function importLegacyPersonaFiles(store, home, { now = Date.now() } = {}) {
  if (!store || typeof home !== 'string' || home === '') return
  const paths = personaPaths(home)
  for (const kind of ['charter', 'self']) {
    if (store.getPersonaDoc(kind)) continue
    const file = kind === 'charter' ? paths.charter : paths.self
    const text = readText(file)
    if (text.trim() !== '') await store.setPersonaDoc({ kind, text, updatedAt: now })
  }
  if (!existsSync(paths.journalDir)) return
  let files = []
  try {
    files = readdirSync(paths.journalDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
  } catch {
    return
  }
  for (const name of files) {
    const date = name.slice(0, -3)
    if (store.listJournalEntries({ date, limit: 1 }).length > 0) continue
    const file = join(paths.journalDir, name)
    const text = readText(file)
    if (text.trim() === '') continue
    let ts = now
    try {
      ts = statSync(file).mtimeMs
    } catch {
      // Keep now.
    }
    await store.appendJournalEntry({ id: `jr_legacy_${date}`, date, ts, text, source: 'legacy-file', createdAt: now })
  }
}

export function assemblePersona({ charter = '', self = '', journal = '' }, { maxChars = PERSONA_LIMITS.maxChars } = {}) {
  const sections = [
    { title: '你是谁（charter，只读；不得改写）', body: String(charter).trim(), keep: true },
    { title: '你最近的样子（self，每晚重写）', body: String(self).trim(), keep: false },
    { title: '今天（journal）', body: String(journal).trim(), keep: false },
  ]
  let text = render(sections)
  let truncated = false

  if (text.length > maxChars) {
    truncated = true
    sections[2].body = truncate(sections[2].body, Math.max(0, maxChars - render(sections.map((s, i) => (i === 2 ? { ...s, body: '' } : s))).length - 40))
    text = render(sections)
  }
  if (text.length > maxChars) {
    truncated = true
    sections[1].body = truncate(sections[1].body, Math.max(0, maxChars - render([sections[0], { ...sections[1], body: '' }, sections[2]]).length - 40))
    text = render(sections)
  }
  if (text.length > maxChars) {
    text = truncate(text, maxChars)
    truncated = true
  }
  return { text, truncated }
}

export async function writeSelf(store, text, { now = Date.now() } = {}) {
  if (typeof text !== 'string' || text.trim() === '') throw new RangeError('self 内容不能为空')
  await store.setPersonaDoc({ kind: 'self', text: text.trim(), updatedAt: now })
  return 'self'
}

export function cleanSelfText(text, maxChars = 6000) {
  let value = String(text ?? '').trim()
  value = value.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (value.length > maxChars) value = `${value.slice(0, Math.max(0, maxChars - 1))}…`
  return value
}

export async function appendJournal(store, text, { now = Date.now(), tzOffsetMinutes = null, source = null } = {}) {
  if (typeof text !== 'string' || text.trim() === '') throw new RangeError('journal 内容不能为空')
  const date = dayKey(now, tzOffsetMinutes ?? -new Date().getTimezoneOffset())
  const id = await store.appendJournalEntry({ date, ts: now, text, source })
  return { id, date }
}

/** Human-authored charter. The agent has no tool for this path; only the admin UI writes it. */
export async function writeCharter(store, text, { now = Date.now() } = {}) {
  if (typeof text !== 'string' || text.trim() === '') throw new RangeError('charter 内容不能为空')
  if (text.length > 64 * 1024) throw new RangeError('charter 超过 64KB')
  await store.setPersonaDoc({ kind: 'charter', text: text.trim(), updatedAt: now })
  return 'charter'
}

/** Reset the agent-maintained self while keeping the charter. */
export async function clearSelf(store, { now = Date.now() } = {}) {
  await store.setPersonaDoc({ kind: 'self', text: '', updatedAt: now })
  return 'self'
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function render(sections) {
  return sections
    .filter((section) => section.body !== '')
    .map((section) => `## ${section.title}\n${section.body}`)
    .join('\n\n')
}

function truncate(text, maxChars) {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}
