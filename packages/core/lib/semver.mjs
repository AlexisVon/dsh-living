/** Minimal semver compare and range subset for gem version resolution. */

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

export function parseSemver(value) {
  const match = SEMVER_RE.exec(String(value ?? ''))
  if (!match) throw new RangeError(`不是合法 semver: ${value}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (const key of ['major', 'minor', 'patch']) {
    const diff = a[key] - b[key]
    if (diff !== 0) return Math.sign(diff)
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const diff = compareIdentifiers(x, y)
    if (diff !== 0) return diff
  }
  return 0
}

/** Space-separated comparators (AND). Supported operators: >= > <= < = ^ ~ and bare exact. */
export function satisfiesRange(version, range) {
  if (typeof range !== 'string' || range.trim() === '') throw new RangeError(`版本范围必须是非空字符串: ${range}`)
  parseSemver(version)
  return range.trim().split(/\s+/u).every((token) => satisfiesComparator(version, token))
}

function satisfiesComparator(version, token) {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(token)
  if (!match) throw new RangeError(`版本比较符不合法: ${token}`)
  const operator = match[1] ?? '='
  const bound = match[2]
  const parsed = parseSemver(bound)
  const diff = compareSemver(version, bound)
  switch (operator) {
    case '>=': return diff >= 0
    case '>': return diff > 0
    case '<=': return diff <= 0
    case '<': return diff < 0
    case '=': return diff === 0
    case '^': return diff >= 0 && satisfiesComparator(version, `<${upperBound(parsed, '^')}`)
    case '~': return diff >= 0 && satisfiesComparator(version, `<${upperBound(parsed, '~')}`)
    default: throw new RangeError(`版本比较符不合法: ${token}`)
  }
}

function upperBound(parsed, operator) {
  if (operator === '^') {
    if (parsed.major > 0) return `${parsed.major + 1}.0.0`
    if (parsed.minor > 0) return `0.${parsed.minor + 1}.0`
    return `0.0.${parsed.patch + 1}`
  }
  return `${parsed.major}.${parsed.minor + 1}.0`
}

/** Catalog floor and registry latest decide the target; installed newer than target is kept. */
export function chooseTargetVersion({ installed = null, floor, latest = null }) {
  parseSemver(floor)
  if (latest !== null) parseSemver(latest)
  const resolved = latest !== null && compareSemver(latest, floor) > 0 ? latest : floor
  const action = installed === null
    ? 'install'
    : compareSemver(installed, resolved) < 0
      ? 'upgrade'
      : 'none'
  return { resolved, action, noDowngrade: installed !== null && compareSemver(installed, resolved) > 0 }
}
