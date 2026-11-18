/** Text helpers shared by indexing, recall and L0 budgeting. */

const TOKEN_LIMIT = 2000
const CJK = /[㐀-鿿]/

export function tokenizeForIndex(text) {
  const s = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const segment of s.split(/[^a-z0-9_㐀-鿿]+/)) {
    if (!segment) continue
    if (/^[a-z0-9_]+$/.test(segment)) {
      if (segment.length >= 2) out.add(segment)
      continue
    }
    for (const word of segment.match(/[a-z0-9_]+/g) ?? []) {
      if (word.length >= 2) out.add(word)
    }
    if (segment.length === 1) {
      out.add(segment)
      continue
    }
    for (let i = 0; i + 2 <= segment.length; i += 1) out.add(segment.slice(i, i + 2))
    if (segment.length >= 4) for (let i = 0; i + 4 <= segment.length; i += 2) out.add(segment.slice(i, i + 4))
  }
  return [...out].slice(0, TOKEN_LIMIT)
}

/** Cue tokens: bigrams and ASCII words only — 4-grams would dilute overlap. */
export function tokenizeCue(text, limit = 40) {
  const s = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const segment of s.split(/[^a-z0-9_㐀-鿿]+/)) {
    if (!segment) continue
    if (/^[a-z0-9_]+$/.test(segment)) {
      if (segment.length >= 2) out.add(segment)
      continue
    }
    for (const word of segment.match(/[a-z0-9_]+/g) ?? []) {
      if (word.length >= 2) out.add(word)
    }
    if (segment.length === 1) out.add(segment)
    else for (let i = 0; i + 2 <= segment.length; i += 1) out.add(segment.slice(i, i + 2))
  }
  return [...out].slice(0, limit)
}

/** Fraction of cue tokens present in the haystack. */
export function overlapScore(tokens, haystack) {
  if (!tokens.length) return 0
  const hay = String(haystack ?? '').toLowerCase()
  let hit = 0
  for (const token of tokens) if (hay.includes(token)) hit += 1
  return hit / tokens.length
}

/** Conservative token estimate: one token per CJK char, four chars per token otherwise. */
export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const ch of String(text ?? '')) {
    if (CJK.test(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}
