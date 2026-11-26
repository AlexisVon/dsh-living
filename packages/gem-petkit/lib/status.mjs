/** Feeder food status: D4H hopper is binary; bowl/percent/weight are optional. */

export function foodStatus(state = {}) {
  const food = Number(state.food)
  const hopper = !Number.isFinite(food) ? '未知' : food <= 0 ? '空' : food === 1 ? '低' : '有粮'
  const parts = [`粮仓 ${hopper}（food=${Number.isFinite(food) ? food : '?'}）`]
  const percent = Number(state.percent)
  if (Number.isFinite(percent) && percent >= 0) parts.push(`粮仓余量 ${clampPercent(percent)}%`)
  const bowl = Number(state.bowl)
  if (Number.isFinite(bowl) && bowl >= 0) parts.push(`碗里 ${clampPercent(bowl)}%`)
  const weight = Number(state.weight)
  if (Number.isFinite(weight) && weight >= 0) parts.push(`碗重 ${Math.round(weight)}g`)
  return parts.join('；')
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}
