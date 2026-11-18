/** iLink CDN media: AES-128-ECB encrypt/decrypt, download, upload, local file classification. */

import { createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

export class MediaError extends Error {
  constructor(message, kind = 'unknown') {
    super(message)
    this.name = 'MediaError'
    this.kind = kind
  }
}

/** The key is base64(16 raw bytes) or base64(32 hex chars). */
export function parseAesKey(media) {
  const raw = media?.aes_key
  if (!raw) return null
  const decoded = Buffer.from(String(raw), 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32) {
    const hex = decoded.toString('ascii')
    if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex')
  }
  return decoded.length >= 16 ? decoded.subarray(0, 16) : null
}

export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** WeChat gives no extension for images; the magic bytes are the only reliable source. */
export function detectImageExtension(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return '.gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp'
  return null
}

export function classifyMedia(name, kind = null) {
  if (kind === 'image' || kind === 'file') return kind
  return IMAGE_EXTENSIONS.has(extname(String(name ?? '')).toLowerCase()) ? 'image' : 'file'
}

export function sanitizeFileName(name, fallback = 'file') {
  const base = basename(String(name ?? '')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim()
  return (base || fallback).slice(0, 120)
}

export function readLocalMedia(path, { maxBytes = 20 * 1024 * 1024 } = {}) {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    throw new MediaError(`附件不存在或不可读: ${path}（${error.message}）`, 'config')
  }
  if (!stat.isFile()) throw new MediaError(`附件不是普通文件: ${path}`, 'config')
  if (stat.size > maxBytes) throw new MediaError(`附件超过 ${maxBytes} 字节上限: ${path}`, 'config')
  return { buffer: readFileSync(path), name: sanitizeFileName(path), kind: classifyMedia(path), size: stat.size }
}

export async function downloadMedia({
  encryptQueryParam,
  aesKey,
  cdnBaseUrl,
  filekey = null,
  maxBytes = 20 * 1024 * 1024,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  if (!encryptQueryParam) throw new MediaError('媒体缺少 encrypt_query_param', 'config')
  if (!aesKey) throw new MediaError('媒体缺少可用的 aes_key', 'config')
  let url = `${cdnBaseUrl.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
  if (filekey) url += `&filekey=${encodeURIComponent(filekey)}`
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new MediaError(`媒体下载失败: HTTP ${response.status}`, 'network')
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) {
    throw new MediaError(`媒体超过 ${maxBytes} 字节上限`, 'config')
  }
  const ciphertext = Buffer.from(await response.arrayBuffer())
  if (ciphertext.length > maxBytes) throw new MediaError(`媒体超过 ${maxBytes} 字节上限`, 'config')
  try {
    return decryptAesEcb(ciphertext, aesKey)
  } catch (error) {
    throw new MediaError(`媒体解密失败: ${error.message}`, 'unknown')
  }
}

export async function uploadMedia({
  buffer,
  aesKey,
  uploadParam,
  filekey,
  cdnBaseUrl,
  uploadUrl = null,
  fetchImpl = fetch,
  retries = 3,
} = {}) {
  if (!uploadParam) throw new MediaError('getuploadurl 没有返回 upload_param', 'unknown')
  const encrypted = encryptAesEcb(buffer, aesKey)
  const url = uploadUrl
    ?? `${cdnBaseUrl.replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
  let lastError = null
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(encrypted),
        signal: AbortSignal.timeout(60_000),
      })
      if (response.status >= 400 && response.status < 500) {
        const detail = response.headers.get('x-error-message') ?? (await response.text())
        throw new MediaError(`CDN 拒绝上传 ${response.status}: ${String(detail).slice(0, 200)}`, 'config')
      }
      if (response.status !== 200) {
        lastError = new MediaError(`CDN 上传失败: HTTP ${response.status}`, 'network')
        continue
      }
      const encryptQueryParam = response.headers.get('x-encrypted-param')
      if (!encryptQueryParam) throw new MediaError('CDN 上传缺少 x-encrypted-param', 'unknown')
      return { encryptQueryParam, encryptedSize: encrypted.length }
    } catch (error) {
      lastError = error
      if (error instanceof MediaError && error.kind === 'config') throw error
    }
  }
  throw lastError ?? new MediaError('CDN 上传失败', 'network')
}

export function saveInboundMedia(buffer, { dir, messageId, index, fileName = null, kind = 'file' }) {
  const safeId = sanitizeFileName(String(messageId ?? 'msg'), 'msg')
  const detected = kind === 'image' ? detectImageExtension(buffer) : null
  const ext = detected ?? (fileName ? extname(sanitizeFileName(fileName)) : '') ?? ''
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${safeId}-${index}${ext || '.bin'}`)
  writeFileSync(path, buffer, { mode: 0o600 })
  return path
}
