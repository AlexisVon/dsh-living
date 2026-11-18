/** Minimal line diff for persona version history; no external dependency. */

export function lineDiff(before, after, { context = 3 } = {}) {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length === b.length && a.every((line, index) => line === b[index])) return ''

  const ops = diffOps(a, b)
  const changed = []
  ops.forEach((op, index) => { if (op.type !== ' ') changed.push(index) })
  if (changed.length === 0) return ''

  const ranges = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(ops.length, index + context + 1)
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }

  const oldBefore = [1]
  const newBefore = [1]
  for (const op of ops) {
    oldBefore.push(oldBefore[oldBefore.length - 1] + (op.type === '+' ? 0 : 1))
    newBefore.push(newBefore[newBefore.length - 1] + (op.type === '-' ? 0 : 1))
  }

  const out = []
  for (const range of ranges) {
    const slice = ops.slice(range.start, range.end)
    const oldCount = slice.filter((op) => op.type !== '+').length
    const newCount = slice.filter((op) => op.type !== '-').length
    const oldStart = oldCount === 0 ? oldBefore[range.start] - 1 : oldBefore[range.start]
    const newStart = newCount === 0 ? newBefore[range.start] - 1 : newBefore[range.start]
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of slice) out.push(`${op.type}${op.line}`)
  }
  return out.join('\n')
}

function splitLines(text) {
  const value = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '')
  return value === '' ? [] : value.split('\n')
}

function diffOps(a, b) {
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', line: a[i] })
      i += 1
      j += 1
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: '-', line: a[i] })
      i += 1
    } else {
      ops.push({ type: '+', line: b[j] })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: '-', line: a[i] })
    i += 1
  }
  while (j < m) {
    ops.push({ type: '+', line: b[j] })
    j += 1
  }
  return ops
}
