/** Memory layers, lazy decay and the demotion threshold (ARCHITECTURE §7). */

const DAY_MS = 86400000
const STRENGTH_CAP = 0.95

export const DEMOTE_STRENGTH = 0.15

export const LAYERS = Object.freeze({
  L2: { id: 'L2', name: '情节记忆', halfLifeDays: 21 },
  L3: { id: 'L3', name: '语义记忆', halfLifeDays: 180 },
  L4: { id: 'L4', name: '程序记忆', halfLifeDays: 3650 },
  L5: { id: 'L5', name: '自传式记忆', halfLifeDays: 0, permanent: true },
})

const PROCEDURAL_HINTS = [
  '必须', '不要', '别用', '注意', '经验', '踩坑', '步骤', '先', '然后', '写法',
  '参数', '命令', '接口', '配置', '环境变量', '端口', '路径', '字段', '报错', '失败时',
]
const PROCEDURAL_STRONG = /(经验|必须|不要|别用|踩坑|步骤|写法|报错|失败时)/

export function isProcedural(text) {
  const t = String(text ?? '')
  if (PROCEDURAL_STRONG.test(t)) return true
  let hits = 0
  for (const hint of PROCEDURAL_HINTS) if (t.includes(hint)) hits += 1
  return hits >= 3
}

export function classifyLayer(item) {
  const kind = String(item?.kind ?? '')
  if (kind === 'event' || kind === 'episode' || kind === 'topic') return 'L2'
  if (kind === 'message' || kind === 'notice' || kind === 'change') return 'L2'
  if (kind === 'person') return 'L3'
  if (kind === 'fact') return isProcedural(item?.text) ? 'L4' : 'L3'
  if (kind === 'self' || kind === 'identity') return 'L5'
  return 'L3'
}

export function halfLifeDays(item) {
  if (String(item?.kind) === 'topic') return 7
  if (Number.isFinite(item?.halfLifeDays) && item.halfLifeDays > 0) return item.halfLifeDays
  const layer = LAYERS[classifyLayer(item)]
  return layer?.permanent ? 3650 : (layer?.halfLifeDays ?? 21)
}

export function isPermanent(item) {
  return item?.permanent === true || LAYERS[item?.layer]?.permanent === true
}

export function decayedStrength(entry, now) {
  const strength0 = clamp(Number(entry?.strength0 ?? 0.85), 0, STRENGTH_CAP)
  if (isPermanent(entry)) return strength0
  const days = Math.max(0, (now - (entry.lastTs ?? entry.ts ?? now)) / DAY_MS)
  const base = halfLifeDays(entry)
  const slowed = base * (1 + 0.5 * Math.log(1 + Math.max(0, Number(entry.rehearsal) || 0)))
  return clamp(strength0 * Math.exp(-days / slowed), 0, STRENGTH_CAP)
}

export function recencyScore(item, now) {
  const days = Math.max(0, (now - (item.lastTs ?? item.ts ?? now)) / DAY_MS)
  return Math.exp(-days / halfLifeDays(item))
}

export function rehearsalScore(rehearsal) {
  return Math.min(1, Math.log(1 + Math.max(0, Number(rehearsal) || 0)) / Math.log(11))
}

export function isDemotionCandidate(entry, now, threshold = DEMOTE_STRENGTH) {
  return !isPermanent(entry) && decayedStrength(entry, now) < threshold
}

export function layerName(id) {
  const layer = LAYERS[id]
  return layer ? `${layer.id} ${layer.name}` : String(id ?? '')
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
