/**
 * Tunable memory policy. Structural rules (band ordering, meta strong-field
 * detection, idf tiers) stay in code; only these knobs are configurable.
 */

export const MEMORY_DEFAULTS = Object.freeze({
  metaPenaltyBands: 1,
  journalFactor: 0.65,
  leadChars: 40,
  tierLead: 0.75,
  tierBody: 0.45,
  relBand: 0.05,
  salienceGate: 0.6,
  arousalGate: 0.5,
  chainBonus: 0.12,
  spontaneousProb: 0.5,
  recallTopK: 8,
  l0TopK: 15,
  coldClueMax: 8,
  halfLifeL2: 21,
  halfLifeL3: 180,
  halfLifeL4: 3650,
  halfLifeTopic: 7,
  strength0: 0.85,
  strengthCap: 0.95,
  demoteStrength: 0.15,
  maxItems: 20,
  maxEdges: 40,
  batchJournal: 6,
  batchOther: 3,
})

const num = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const int = (value, min, max, fallback) => Math.round(clamp(num(value, fallback), min, max))

/** Clamp every knob into its safe range; unknown keys are ignored. */
export function resolveMemoryParams(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...MEMORY_DEFAULTS }
  out.metaPenaltyBands = int(src.metaPenaltyBands, 0, 2, MEMORY_DEFAULTS.metaPenaltyBands)
  out.journalFactor = clamp(num(src.journalFactor, MEMORY_DEFAULTS.journalFactor), 0.3, 1)
  out.leadChars = int(src.leadChars, 20, 80, MEMORY_DEFAULTS.leadChars)
  out.tierLead = clamp(num(src.tierLead, MEMORY_DEFAULTS.tierLead), 0.5, 1)
  out.tierBody = clamp(num(src.tierBody, MEMORY_DEFAULTS.tierBody), 0.2, out.tierLead)
  out.relBand = clamp(num(src.relBand, MEMORY_DEFAULTS.relBand), 0.02, 0.1)
  out.salienceGate = clamp(num(src.salienceGate, MEMORY_DEFAULTS.salienceGate), 0.3, 0.9)
  out.arousalGate = clamp(num(src.arousalGate, MEMORY_DEFAULTS.arousalGate), 0.2, 0.9)
  out.chainBonus = clamp(num(src.chainBonus, MEMORY_DEFAULTS.chainBonus), 0, 0.2)
  out.spontaneousProb = clamp(num(src.spontaneousProb, MEMORY_DEFAULTS.spontaneousProb), 0, 1)
  out.recallTopK = int(src.recallTopK, 3, 20, MEMORY_DEFAULTS.recallTopK)
  out.l0TopK = int(src.l0TopK, 5, 30, MEMORY_DEFAULTS.l0TopK)
  out.coldClueMax = int(src.coldClueMax, 0, 20, MEMORY_DEFAULTS.coldClueMax)
  out.halfLifeL2 = clamp(num(src.halfLifeL2, MEMORY_DEFAULTS.halfLifeL2), 1, 10000)
  out.halfLifeL3 = clamp(num(src.halfLifeL3, MEMORY_DEFAULTS.halfLifeL3), 1, 10000)
  out.halfLifeL4 = clamp(num(src.halfLifeL4, MEMORY_DEFAULTS.halfLifeL4), 1, 10000)
  out.halfLifeTopic = clamp(num(src.halfLifeTopic, MEMORY_DEFAULTS.halfLifeTopic), 1, 10000)
  out.strength0 = clamp(num(src.strength0, MEMORY_DEFAULTS.strength0), 0.05, 0.95)
  out.strengthCap = clamp(num(src.strengthCap, MEMORY_DEFAULTS.strengthCap), out.strength0, 0.99)
  out.demoteStrength = clamp(num(src.demoteStrength, MEMORY_DEFAULTS.demoteStrength), 0, out.strength0)
  out.maxItems = int(src.maxItems, 5, 50, MEMORY_DEFAULTS.maxItems)
  out.maxEdges = int(src.maxEdges, 5, 100, MEMORY_DEFAULTS.maxEdges)
  out.batchJournal = int(src.batchJournal, 1, 20, MEMORY_DEFAULTS.batchJournal)
  out.batchOther = int(src.batchOther, 1, 20, MEMORY_DEFAULTS.batchOther)
  return Object.freeze(out)
}

/** Parse the volatile `memoryParamsJson` string; malformed JSON fails loudly. */
export function parseMemoryParams(json, label = 'memoryParamsJson') {
  const raw = String(json ?? '').trim()
  if (raw === '') return resolveMemoryParams({})
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RangeError(`${label} 不是合法 JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RangeError(`${label} 必须是 JSON 对象`)
  }
  return resolveMemoryParams(parsed)
}
