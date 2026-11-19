/** Ollama embedding transport, config shape and vector codec. No host-specific defaults beyond loopback. */

import { createHash } from 'node:crypto'

export const EMBED_DEFAULTS = Object.freeze({
  url: 'http://127.0.0.1:11434',
  model: '',
  fallbackDays: 3,
  minConfidence: 0.35,
  maxSegmentDays: 7,
  timeoutMs: 30000,
})

export function normalizeEmbedUrl(value) {
  const raw = String(value ?? EMBED_DEFAULTS.url).trim().replace(/\/+$/u, '')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new RangeError(`embed.url 不是合法 URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RangeError(`embed.url 只允许 http/https: ${raw}`)
  }
  if (parsed.username || parsed.password) throw new RangeError('embed.url 不能带账号密码')
  return raw
}

export function normalizeEmbedConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    url: normalizeEmbedUrl(source.url),
    model: String(source.model ?? '').trim().slice(0, 200),
    fallbackDays: integerInRange(source.fallbackDays, EMBED_DEFAULTS.fallbackDays, 1, 365, 'fallbackDays'),
    minConfidence: numberInRange(source.minConfidence, EMBED_DEFAULTS.minConfidence, 0, 1, 'minConfidence'),
    maxSegmentDays: integerInRange(source.maxSegmentDays, EMBED_DEFAULTS.maxSegmentDays, 1, 30, 'maxSegmentDays'),
    timeoutMs: integerInRange(source.timeoutMs, EMBED_DEFAULTS.timeoutMs, 1000, 60000, 'timeoutMs'),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : null,
  }
}

export function createOllamaEmbedder() {
  return {
    async listModels({ url = EMBED_DEFAULTS.url, timeoutMs = EMBED_DEFAULTS.timeoutMs } = {}) {
      const base = normalizeEmbedUrl(url)
      const data = await requestJson(`${base}/api/tags`, { timeoutMs })
      const listed = Array.isArray(data?.models) ? data.models : []
      const models = listed.map((model) => ({
        name: String(model?.name ?? model?.model ?? ''),
        digest: typeof model?.digest === 'string' && model.digest !== '' ? model.digest : null,
        size: Number(model?.size) || null,
        capabilities: Array.isArray(model?.capabilities) ? model.capabilities.map(String) : null,
      })).filter((model) => model.name !== '')
      const missing = models.filter((model) => model.capabilities === null)
      await mapLimit(missing, 4, async (model) => {
        try {
          const shown = await requestJson(`${base}/api/show`, { method: 'POST', body: { model: model.name }, timeoutMs: Math.min(timeoutMs, 5000) })
          model.capabilities = Array.isArray(shown?.capabilities) ? shown.capabilities.map(String) : []
        } catch {
          model.capabilities = []
        }
      })
      return models.map((model) => ({ ...model, embedding: (model.capabilities ?? []).includes('embedding') }))
    },

    async embed({ url = EMBED_DEFAULTS.url, model, input, timeoutMs = EMBED_DEFAULTS.timeoutMs } = {}) {
      if (typeof model !== 'string' || model === '') throw new RangeError('embed.model 必填')
      const texts = Array.isArray(input) ? input.map(String) : [String(input ?? '')]
      if (texts.length === 0) throw new RangeError('embed.input 不能为空')
      const data = await requestJson(`${normalizeEmbedUrl(url)}/api/embed`, {
        method: 'POST',
        body: { model, input: texts },
        timeoutMs,
      })
      const embeddings = data?.embeddings
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error(`embed 返回数量不匹配: 期望 ${texts.length}，实际 ${Array.isArray(embeddings) ? embeddings.length : 'n/a'}`)
      }
      return embeddings.map((row, index) => {
        if (!Array.isArray(row) || row.length === 0) throw new Error(`embed 第 ${index} 条为空`)
        return row.map(Number)
      })
    },
  }
}

/** Query instruction keeps unrelated short Chinese text from clustering at the top. */
export function queryText(key) {
  return `Instruct: Given a personal memory query, retrieve relevant passages within a timeline\nQuery: ${String(key ?? '').trim()}`
}

export function cosine(left, right) {
  const length = Math.min(left.length, right.length)
  if (length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export function encodeVector(values) {
  const vector = Float32Array.from(values, Number)
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function decodeVector(buffer) {
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const out = new Float32Array(Math.floor(view.byteLength / 4))
  for (let index = 0; index < out.length; index += 1) out[index] = view.readFloatLE(index * 4)
  return out
}

export function hashText(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16)
}

async function requestJson(url, { method = 'GET', body = null, timeoutMs = EMBED_DEFAULTS.timeoutMs } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 300)}`)
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Ollama 返回不是 JSON: ${error.message}`)
  }
}

async function mapLimit(items, limit, fn) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

function integerInRange(value, fallback, min, max, name) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`embed.${name} 必须是 ${min}–${max} 的整数: ${value}`)
  }
  return number
}

function numberInRange(value, fallback, min, max, name) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`embed.${name} 必须在 ${min}–${max}: ${value}`)
  }
  return number
}
