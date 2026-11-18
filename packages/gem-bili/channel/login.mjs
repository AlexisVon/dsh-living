#!/usr/bin/env node
import { loginWithQr } from '../lib/credential.mjs'
import { credentialPath, gemHome } from '../lib/config.mjs'

const home = gemHome()
const credential = await loginWithQr({ home })
console.log(`\n登录成功：${credential.uname || '(未取到昵称)'}（uid ${credential.dedeuserid}）`)
console.log(`凭据已写入 ${credentialPath(home)}`)
