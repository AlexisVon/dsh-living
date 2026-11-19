#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { gemHome, loadConfig } from '../lib/config.mjs'
import { runLogin } from '../lib/login.mjs'

const rl = createInterface({ input: stdin, output: stdout })
const labels = { username: '小佩账号（手机号）', password: '密码' }

try {
  const { credential, selected } = await runLogin({
    prompt: (id) => rl.question(`${labels[id] ?? id}: `),
    home: gemHome(),
    config: loadConfig(),
  })
  console.log(`\n登录成功：${credential.username}`)
  console.log(`已选择：${selected.id} ${selected.deviceType} ${selected.name || '(无名)'}`)
  console.log(`凭据已写入 ${gemHome()}`)
} catch (error) {
  console.error(`登录失败：${error.message}`)
  process.exitCode = 1
} finally {
  rl.close()
}
