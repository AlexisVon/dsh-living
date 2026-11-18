#!/usr/bin/env node
import { clearSyncBuf, gemHome, loadConfig, saveToken, tokenPath } from '../lib/config.mjs'
import { DEFAULT_BASE_URL, loginWithQr } from '../lib/ilink.mjs'
import { renderTerminalQr } from '../lib/qr.mjs'

const home = gemHome()
const config = loadConfig(home)
const token = await loginWithQr({
  baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
  botType: config.botType,
  render: renderTerminalQr,
})
saveToken(token, home)
clearSyncBuf(home)
console.log(`\n登录成功：bot ${token.accountId}，用户 ${token.userId}`)
console.log(`凭据已写入 ${tokenPath(home)}（旧的同步游标已清除）`)
