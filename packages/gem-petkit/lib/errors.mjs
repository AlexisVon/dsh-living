const HINTS = {
  3: '请求参数不完整',
  5: '登录态失效，需要重新登录',
  97: 'App 版本过旧',
  99: '服务端拒绝该请求',
  105: '手机号格式不合法',
  106: '邮箱格式不合法',
  122: '认证失败',
  123: '验证码不正确或已过期',
  125: '账号未注册',
  703: '设备不存在',
  1514: '操作太频繁，稍后再试',
}

export class PetkitError extends Error {
  constructor(code, message, context = '') {
    const hint = HINTS[code] ? `（${HINTS[code]}）` : ''
    super(`PetKit ${code}${hint}: ${message}${context ? ` [${context}]` : ''}`)
    this.name = 'PetkitError'
    this.code = code
  }
}

export function isAuthError(error) {
  return error instanceof PetkitError && (error.code === 5 || error.code === 122)
}

export function isRateLimit(error) {
  return error instanceof PetkitError && error.code === 1514
}
