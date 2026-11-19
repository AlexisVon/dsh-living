import { createDecipheriv } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const IV = Buffer.alloc(16, 0x61)

export function decryptPreview(ciphertext, aesKey) {
  const key = Buffer.from(String(aesKey ?? '').trim(), 'utf8')
  if (![16, 24, 32].includes(key.length)) throw new Error(`aesKey 长度不合法（${key.length} 字节）`)
  const algorithm = key.length === 32 ? 'aes-256-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-128-cbc'
  let plain
  try {
    const decipher = createDecipheriv(algorithm, key, IV)
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (error) {
    throw new Error(`预览图解密失败：${error.message}`)
  }
  const pad = plain[plain.length - 1]
  if (pad >= 1 && pad <= 16 && plain.length >= pad && plain.subarray(-pad).every((byte) => byte === pad)) {
    plain = plain.subarray(0, -pad)
  }
  return plain
}

export function detectImageExtension(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return '.gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  return null
}

export function sanitizeEventId(value) {
  const safe = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 120)
  return safe || `preview_${Date.now()}`
}

/** Download one encrypted PetKit preview, decrypt it, and keep it on disk for read_image. */
export async function downloadPetkitImage({
  url,
  aesKey,
  home,
  eventId,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  if (!url) throw new Error('缺少预览 URL')
  if (!aesKey) throw new Error('缺少 aesKey')
  const dir = join(home, 'media')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {}
  const safe = sanitizeEventId(eventId)
  for (const extension of ['.jpg', '.png', '.webp', '.gif']) {
    const cached = join(dir, `${safe}${extension}`)
    if (existsSync(cached)) return { path: cached, cached: true }
  }

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`预览图下载失败：HTTP ${response.status}`)
  const ciphertext = Buffer.from(await response.arrayBuffer())
  const plain = decryptPreview(ciphertext, aesKey)
  const extension = detectImageExtension(plain)
  if (!extension) throw new Error('预览图解密后不是已知图片格式')
  const path = join(dir, `${safe}${extension}`)
  writeFileSync(path, plain, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {}
  return { path, cached: false, bytes: plain.length, extension }
}
