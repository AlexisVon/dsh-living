/** Self-written prompt/rules plus hot-memory notes; small by design. */

export const NOTES_LIMITS = Object.freeze({
  tagChars: 5,
  textChars: 40,
  persistentMax: 50,
  coreMax: 8,
  tempPerDay: 10,
})

const TIERS = new Set(['persistent', 'temp'])

export function assertTier(tier) {
  const value = String(tier ?? '')
  if (!TIERS.has(value)) throw new RangeError(`note.tier 只能是 persistent / temp: ${value}`)
  return value
}

export function normalizeTag(value) {
  const tag = String(value ?? '').replace(/\s+/g, '').trim()
  if (tag === '') throw new RangeError('note.tag 不能为空')
  if ([...tag].length > NOTES_LIMITS.tagChars) {
    throw new RangeError(`note.tag 超 ${[...tag].length - NOTES_LIMITS.tagChars} 字（上限 ${NOTES_LIMITS.tagChars} 字）`)
  }
  return tag
}

export function normalizeNoteText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') throw new RangeError('note.text 不能为空')
  if ([...text].length > NOTES_LIMITS.textChars) {
    throw new RangeError(`note.text 超 ${[...text].length - NOTES_LIMITS.textChars} 字（上限 ${NOTES_LIMITS.textChars} 字）`)
  }
  return text
}

/** Shift a local YYYY-MM-DD date string without touching wall-clock time zones. */
export function shiftDay(day, delta) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new RangeError(`day 必须是 YYYY-MM-DD: ${day}`)
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  date.setUTCDate(date.getUTCDate() + Number(delta))
  return date.toISOString().slice(0, 10)
}

/** Current-view slot code: S persistent, A today, B yesterday; null outside the visible window. */
export function noteCode(note, { today, yesterday } = {}) {
  if (note.tier === 'persistent') return `S${note.seq}`
  if (note.day === today) return `A${note.seq}`
  if (note.day === yesterday) return `B${note.seq}`
  return null
}

export function formatNoteLine(note, code) {
  return `- [${note.tag}] ${code} ${note.text}`
}

/** Flat corpus for the handoff compressor: slot code, tag, text. */
export function formatNoteCorpus(notes = [], { today, yesterday } = {}) {
  return notes
    .map((note) => {
      const code = noteCode(note, { today, yesterday })
      return code == null ? null : formatNoteLine(note, code)
    })
    .filter(Boolean)
    .join('\n')
}

/** Every tag once, with per-tier counts and view-ordered slot codes; tags never disappear while any tier holds them. */
export function listNoteKeywords({ persistent = [], today = [], yesterday = [] } = {}) {
  const map = new Map()
  const add = (notes, key, prefix) => {
    for (const note of notes) {
      if (!map.has(note.tag)) map.set(note.tag, { tag: note.tag, s: 0, a: 0, b: 0, codes: [] })
      const keyword = map.get(note.tag)
      keyword[key] += 1
      keyword.codes.push(`${prefix}${note.seq}`)
    }
  }
  add(persistent, 's', 'S')
  add(today, 'a', 'A')
  add(yesterday, 'b', 'B')
  return [...map.values()].sort(
    (left, right) => right.s + right.a + right.b - (left.s + left.a + left.b) || left.tag.localeCompare(right.tag, 'zh'),
  )
}

export function formatKeywordRow(keyword) {
  const counts = []
  if (keyword.s > 0) counts.push(`S${keyword.s}`)
  if (keyword.a > 0) counts.push(`A${keyword.a}`)
  if (keyword.b > 0) counts.push(`B${keyword.b}`)
  return `${keyword.tag} ${counts.join(' ')}`
}

export function summarizeNotes({ persistent = [], today = [], yesterday = [], limits = NOTES_LIMITS } = {}) {
  const core = persistent.filter((note) => note.core === true).length
  return {
    persistent: persistent.length,
    core,
    tempToday: today.length,
    tempYesterday: yesterday.length,
    persistentMax: limits.persistentMax,
    coreMax: limits.coreMax,
    tempPerDay: limits.tempPerDay,
    persistentFull: persistent.length >= limits.persistentMax,
    coreFull: core >= limits.coreMax,
    tempTodayFull: today.length >= limits.tempPerDay,
  }
}

/** Capacity line shared by the prompt, sleep review and the UI. */
export function formatCapacity(summary) {
  return `S ${summary.persistent}/${summary.persistentMax} · A ${summary.tempToday}/${summary.tempPerDay} · B ${summary.tempYesterday}（只读）`
}

export function formatNotesPrompt({ persistent = [], today = [], yesterday = [], limits = NOTES_LIMITS } = {}) {
  if (persistent.length + today.length + yesterday.length === 0) return ''
  const summary = summarizeNotes({ persistent, today, yesterday, limits })
  const core = persistent.filter((note) => note.core === true)
  const keywords = listNoteKeywords({ persistent, today, yesterday })
  const lines = [
    `## 笔记（${formatCapacity(summary)}）`,
    'S 持久（core 全文注入，其余按关键词索引查）/ A 今天临时（全文）/ B 昨天临时（全文，只读；要复用请新写 S/A）。',
  ]
  if (core.length > 0) {
    lines.push('### core')
    for (const note of core) lines.push(formatNoteLine(note, `S${note.seq}`))
  }
  lines.push('### 关键词索引')
  lines.push(`索引：${keywords.map(formatKeywordRow).join(' · ')}`)
  lines.push('索引只是提醒；涉及某个词先 living_note list --tag <词> 看全文，再行动。')
  if (today.length > 0) {
    lines.push('### A 今天')
    for (const note of today) lines.push(formatNoteLine(note, `A${note.seq}`))
  }
  if (yesterday.length > 0) {
    lines.push('### B 昨天（只读）')
    for (const note of yesterday) lines.push(formatNoteLine(note, `B${note.seq}`))
  }
  return lines.join('\n')
}
