import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { decryptPreview, detectImageExtension, sanitizeEventId } from '../lib/media.mjs'

function encrypt(plain, keyText) {
  const key = Buffer.from(keyText, 'utf8')
  const iv = Buffer.alloc(16, 0x61)
  const cipher = createCipheriv(key.length === 32 ? 'aes-256-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-128-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

test('media：AES-CBC 解密与 JPEG 识别', () => {
  const key = '5f1c56dbea688d94'
  const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12, 0x11)])
  const padded = Buffer.concat([body, Buffer.from([0x01])])
  const decrypted = decryptPreview(encrypt(padded, key), key)
  assert.deepEqual(decrypted, body)
  assert.equal(detectImageExtension(decrypted), '.jpg')
})

test('media：非法 key 与非法密文大声失败', () => {
  assert.throws(() => decryptPreview(Buffer.alloc(16), 'short'), /aesKey 长度/)
  assert.throws(() => decryptPreview(Buffer.alloc(7), '5f1c56dbea688d94'), /解密失败/)
})

test('media：eventId 只保留安全字符', () => {
  assert.equal(sanitizeEventId('733807_1795060144'), '733807_1795060144')
  assert.equal(sanitizeEventId('../../etc/passwd'), 'etc_passwd')
  assert.match(sanitizeEventId(''), /^preview_/)
})
