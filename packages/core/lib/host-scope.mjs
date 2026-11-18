/**
 * dsh-scope keys its agent scope with a private Symbol("dsh.scope"). Read the
 * value structurally: importing the package would compare symbols from a
 * different peer instance and miss the host's key.
 */
export function findScope(ctx) {
  const seen = new Set()
  let current = ctx
  while (current && !seen.has(current)) {
    seen.add(current)
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === 'symbol' && key.description === 'dsh.scope') return current[key]
    }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}
