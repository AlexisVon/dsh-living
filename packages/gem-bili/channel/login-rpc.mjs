#!/usr/bin/env node
import { loginWithQr } from '../lib/credential.mjs'
import { gemHome } from '../lib/config.mjs'
import { qrSvgFor } from '../lib/qr.mjs'

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

try {
  const credential = await loginWithQr({
    home: gemHome(),
    log: () => {},
    render: () => '',
    onQr: (url) => emit({ type: 'qr', url, svg: qrSvgFor(url) }),
    onStatus: (status) => emit({ type: 'status', status }),
  })
  emit({ type: 'done', account: { name: credential.uname ?? '', id: credential.dedeuserid ?? '' } })
} catch (error) {
  emit({ type: 'error', message: error.message })
  process.exitCode = 1
}
