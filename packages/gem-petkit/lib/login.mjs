import { PetkitClient, FEEDER_TYPES } from './client.mjs'
import { loadConfig, saveCredential, saveDevices, saveSelected } from './config.mjs'

/** Shared login flow: username/password, device discovery, credential and selection. */
export async function runLogin({ prompt, emit = () => {}, home, config = loadConfig(home), fetchImpl } = {}) {
  emit({ type: 'prompt', id: 'username', kind: 'text', label: '小佩账号（手机号）', help: '国区小号；不要用主号' })
  const username = String(await prompt('username')).trim()
  if (username === '') throw new Error('账号不能为空')

  emit({ type: 'prompt', id: 'password', kind: 'password', label: '密码', help: '小佩 App 的登录密码' })
  const password = String(await prompt('password'))
  if (password === '') throw new Error('密码不能为空')

  emit({ type: 'status', status: 'wait' })
  const client = new PetkitClient({ config, fetchImpl })
  const session = await client.loginWithPassword(username, password)
  const devices = await client.listDevices()
  const feeders = devices.filter((device) => FEEDER_TYPES.has(device.deviceType))
  if (feeders.length === 0) throw new Error('这个账号下没有喂食器（包括共享设备）')
  const selected = feeders[0]
  if (feeders.length > 1) console.warn(`[petkit] 有多台喂食器，先选 ${selected.id}（${selected.deviceType}）`)

  saveDevices(devices, home)
  saveSelected(selected.id, home)
  const credential = {
    ...session,
    username,
    account: { name: '小佩小号', id: session.userId },
    device: { id: selected.id, name: selected.name, type: selected.deviceType },
  }
  saveCredential(credential, home)
  emit({ type: 'done', account: { name: '小佩小号', id: session.userId } })
  return { credential, devices, selected }
}
