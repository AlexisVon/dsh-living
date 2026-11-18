/** Human-readable living session titles: living-YYYY-MM-DD-上午/下午. */

export const NOON_BOUNDARY_HOUR = 13

export function livingSessionTitle(now = Date.now(), {
  tzOffsetMinutes = -new Date().getTimezoneOffset(),
} = {}) {
  const shifted = new Date(now + tzOffsetMinutes * 60000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const date = `living-${year}-${month}-${day}`
  return `${date}-${shifted.getUTCHours() < NOON_BOUNDARY_HOUR ? '上午' : '下午'}`
}
