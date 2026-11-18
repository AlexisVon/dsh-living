import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyMedia,
  decryptAesEcb,
  detectImageExtension,
  downloadMedia,
  encryptAesEcb,
  MediaError,
  parseAesKey,
  readLocalMedia,
  saveInboundMedia,
} from '../lib/media.mjs'

test('AES-128-ECB 往返；aes_key 支持 16 字节与 32 位 hex 两种编码', () => {
  const key = Buffer.alloc(16, 7)
  const plain = Buffer.from('hello wechat media')
  const encrypted = encryptAesEcb(plain, key)
  assert.deepEqual(decryptAesEcb(encrypted, key), plain)
  assert.deepEqual(parseAesKey({ aes_key: key.toString('base64') }), key)
  assert.deepEqual(parseAesKey({ aes_key: Buffer.from(key.toString('hex')).toString('base64') }), key)
})

test('图片扩展名靠魔数识别；未知扩展名按文件处理', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  assert.equal(detectImageExtension(png), '.png')
  assert.equal(classifyMedia('a.png'), 'image')
  assert.equal(classifyMedia('a.pdf'), 'file')
  assert.equal(classifyMedia('a.bin', 'image'), 'image')
})

test('CDN 下载解密；超过上限大声失败', async () => {
  const key = Buffer.alloc(16, 3)
  const encrypted = encryptAesEcb(Buffer.from('payload'), key)
  const fetchImpl = async () => new Response(new Uint8Array(encrypted), { status: 200 })
  const plain = await downloadMedia({
    encryptQueryParam: 'q',
    aesKey: key,
    cdnBaseUrl: 'https://cdn.example',
    fetchImpl,
  })
  assert.equal(plain.toString(), 'payload')
  await assert.rejects(
    () => downloadMedia({
      encryptQueryParam: 'q',
      aesKey: key,
      cdnBaseUrl: 'https://cdn.example',
      fetchImpl,
      maxBytes: 2,
    }),
    (error) => error instanceof MediaError && error.kind === 'config',
  )
})

test('本地媒体读取：大小上限与相对路径由调用方保证', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'living-wechat-media-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'a.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const local = readLocalMedia(file, { maxBytes: 100 })
  assert.equal(local.kind, 'image')
  assert.equal(local.name, 'a.png')
  assert.throws(() => readLocalMedia(file, { maxBytes: 2 }), /超过/)
})

test('入站媒体落盘：文件名带消息 id 与 item 序号', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'living-wechat-save-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const path = saveInboundMedia(png, { dir, messageId: 'm1', index: 2, kind: 'image' })
  assert.match(path, /m1-2\.png$/)
  assert.deepEqual(readFileSync(path), png)
})
