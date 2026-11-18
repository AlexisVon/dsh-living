#!/usr/bin/env node
import { clearSyncBuf, gemHome, saveToken } from '../lib/config.mjs'
import { DEFAULT_BASE_URL, loginWithQr } from '../lib/ilink.mjs'
import { qrSvgFor } from '../lib/qr.mjs'

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

try {
  const token = await loginWithQr({
    baseUrl: DEFAULT_BASE_URL,
    log: () => {},
    render: () => '',
    onQr: (url) => emit({ type: 'qr', url, svg: qrSvgFor(url) }),
    onStatus: (status) => emit({ type: 'status', status }),
  })
  const home = gemHome()
  saveToken(token, home)
  clearSyncBuf(home)
  emit({ type: 'done', account: { accountId: token.accountId, userId: token.userId } })
} catch (error) {
  emit({ type: 'error', message: error.message })
  process.exitCode = 1
}
