#!/usr/bin/env node
import { PetkitClient, PetkitError, maskPhone, todayIn } from './client.mjs'

const FEEDERS = new Set(['feeder', 'feedermini', 'd3', 'd4', 'd4s', 'd4h', 'd4sh'])
const CAMERA_FEEDERS = new Set(['d4h', 'd4sh'])
const SENSITIVE_KEYS = new Set(['secret', 'sn', 'mac', 'btMac', 'ssid', 'bssid'])

function usage() {
  console.log(`用法：
  node cli.mjs send-code <手机号>
  node cli.mjs login <手机号> <验证码>
  node cli.mjs login-password <手机号> <密码>
  node cli.mjs refresh
  node cli.mjs devices [--select <设备id>]
  node cli.mjs select <设备id>
  node cli.mjs status [设备id]
  node cli.mjs records [YYYYMMDD] [设备id]
  node cli.mjs plan [设备id]
  node cli.mjs feed <10|20|30|40|50> [设备id] --yes

状态保存在 spikes/petkit/.state/（0600），已被 .gitignore 排除。`)
}

function requireSession(client) {
  if (!client.session?.sessionId) throw new Error('没有会话：先运行 send-code + login')
}

function normalizePhone(value) {
  return String(value ?? '').replace(/[\s-]/g, '')
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : redact(child)
  }
  return out
}

function describeDevice(device) {
  const flags = []
  if (FEEDERS.has(device.deviceType)) flags.push('喂食器')
  if (CAMERA_FEEDERS.has(device.deviceType)) flags.push('摄像头')
  if (device.shared) flags.push('共享')
  return `${device.id}  ${device.deviceType.padEnd(10)} typeCode=${device.typeCode ?? '?'}  ${device.name || '(无名)'}  ${flags.join(' / ')}`
}

function pickDevice(client, requestedId) {
  const devices = client.loadDevices()
  const feeders = devices.filter((device) => FEEDERS.has(device.deviceType))
  if (requestedId) {
    const found = devices.find((device) => device.id === String(requestedId))
    if (!found) throw new Error(`devices.json 里没有设备 ${requestedId}`)
    return found
  }
  const selectedId = client.loadSelected()
  if (selectedId) {
    const found = devices.find((device) => device.id === selectedId)
    if (found) return found
  }
  if (feeders.length === 1) return feeders[0]
  if (feeders.length === 0) throw new Error('账号下没有喂食器；先运行 devices 查看')
  throw new Error(`有多台喂食器，先 select 一台：\n${feeders.map(describeDevice).join('\n')}`)
}

async function cmdSendCode(client, phone) {
  const username = normalizePhone(phone)
  if (!username) throw new Error('缺少手机号')
  const result = await client.requestCode(username)
  console.log(`验证码已请求：${maskPhone(username)}`)
  console.log(`响应：${JSON.stringify(result)}`)
}

async function cmdLogin(client, phone, code) {
  const username = normalizePhone(phone)
  if (!username || !code) throw new Error('缺少手机号或验证码')
  const session = await client.loginWithCode(username, code)
  console.log(`登录成功：${maskPhone(username)}，会话到期 ${new Date(session.expiresAt).toISOString()}`)
  await cmdDevices(client, [])
}

async function cmdLoginPassword(client, phone, password) {
  const username = normalizePhone(phone)
  if (!username || !password) throw new Error('缺少手机号或密码')
  const session = await client.loginWithPassword(username, password)
  console.log(`登录成功：${maskPhone(username)}，会话到期 ${new Date(session.expiresAt).toISOString()}`)
  await cmdDevices(client, [])
}

async function cmdRefresh(client) {
  requireSession(client)
  const session = await client.refresh()
  console.log(`会话已刷新，到期 ${new Date(session.expiresAt).toISOString()}`)
}

async function cmdDevices(client, args) {
  requireSession(client)
  const devices = await client.listDevices()
  client.saveDevices(devices)
  if (devices.length === 0) {
    console.log('账号下没有设备（包括共享设备）')
    return
  }
  console.log('设备：')
  for (const device of devices) console.log(`  ${describeDevice(device)}`)
  const selectIndex = args.indexOf('--select')
  if (selectIndex >= 0) {
    client.saveSelected(String(args[selectIndex + 1] ?? ''))
    console.log(`已选择：${args[selectIndex + 1]}`)
    return
  }
  const feeders = devices.filter((device) => FEEDERS.has(device.deviceType))
  if (feeders.length === 1) {
    client.saveSelected(feeders[0].id)
    console.log(`已自动选择唯一的喂食器：${feeders[0].id}`)
  } else if (feeders.length > 1) {
    console.log('有多台喂食器，运行 select <设备id> 选一台')
  }
}

async function cmdSelect(client, id) {
  requireSession(client)
  const devices = client.loadDevices()
  const found = devices.find((device) => device.id === String(id))
  if (!found) throw new Error(`devices.json 里没有设备 ${id}；先运行 devices`)
  client.saveSelected(found.id)
  console.log(`已选择：${describeDevice(found)}`)
}

async function cmdStatus(client, args) {
  requireSession(client)
  const device = pickDevice(client, args[0])
  const detail = await client.detail(device)
  console.log(`设备：${describeDevice(device)}`)
  console.log(`摄像头机型：${CAMERA_FEEDERS.has(device.deviceType) ? '是' : '否'}；AI 归因（typeCode==2）：${device.typeCode === 2 ? '是' : '否'}`)
  console.log(JSON.stringify(redact(detail), null, 2))
}

async function cmdRecords(client, args) {
  requireSession(client)
  const day = /^\d{8}$/.test(args[0] ?? '') ? args[0] : todayIn(client.timezone)
  const device = pickDevice(client, /^\d{8}$/.test(args[0] ?? '') ? args[1] : args[0])
  const records = await client.records(device, day)
  console.log(`记录 ${day}（设备 ${device.id}）：`)
  const groups = records && typeof records === 'object' && !Array.isArray(records) ? records : { feed: records }
  for (const [kind, list] of Object.entries(groups)) {
    if (!Array.isArray(list) || list.length === 0) continue
    console.log(`  ${kind}: ${list.length} 组`)
  }
  console.log(JSON.stringify(redact(records), null, 2))
}

async function cmdPlan(client, args) {
  requireSession(client)
  const device = pickDevice(client, args[0])
  const plan = await client.feedPlan(device)
  console.log(`喂食计划（设备 ${device.id}）：`)
  console.log(JSON.stringify(redact(plan), null, 2))
}

async function cmdFeed(client, args) {
  requireSession(client)
  const amount = Number(args[0])
  if (!Number.isFinite(amount)) throw new Error('缺少出粮量')
  const confirmed = args.includes('--yes')
  const device = pickDevice(client, args.find((arg, index) => index > 0 && arg !== '--yes'))
  console.log(`准备向 ${device.id} 出粮 ${amount}（${device.deviceType}）`)
  if (!confirmed) {
    console.log('未确认：加 --yes 才会真正出粮。出粮是物理动作，结果未知时不要重试。')
    return
  }
  const result = await client.manualFeed(device, amount)
  console.log(`已发送出粮请求，响应：${JSON.stringify(result)}`)
  console.log('不要自动重试；先用 records/status 确认结果。')
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') {
    usage()
    return
  }
  const client = new PetkitClient({
    log: process.env.PETKIT_DEBUG === '1' ? (line) => console.error(line) : () => {},
  })
  switch (command) {
    case 'send-code':
      return cmdSendCode(client, args[0])
    case 'login':
      return cmdLogin(client, args[0], args[1])
    case 'login-password':
      return cmdLoginPassword(client, args[0], args[1])
    case 'refresh':
      return cmdRefresh(client)
    case 'devices':
      return cmdDevices(client, args)
    case 'select':
      return cmdSelect(client, args[0])
    case 'status':
      return cmdStatus(client, args)
    case 'records':
      return cmdRecords(client, args)
    case 'plan':
      return cmdPlan(client, args)
    case 'feed':
      return cmdFeed(client, args)
    default:
      throw new Error(`未知命令：${command}`)
  }
}

main().catch((error) => {
  console.error(error instanceof PetkitError ? error.message : (error.stack ?? error.message))
  process.exitCode = 1
})
