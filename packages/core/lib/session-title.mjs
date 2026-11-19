/** Human-readable living session titles: living-YYYY-MM-DD-N, N resets at local midnight. */

function localDay(now, tzOffsetMinutes) {
  const shifted = new Date(now + tzOffsetMinutes * 60000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function titleFor(day, seq) {
  return `living-${day}-${seq}`
}

export function livingSessionTitle(now = Date.now(), {
  tzOffsetMinutes = -new Date().getTimezoneOffset(),
  seq = 1,
} = {}) {
  return titleFor(localDay(now, tzOffsetMinutes), seq)
}

/** Allocate the next title for a newly created session; resumes do not call this. */
export function allocateLivingSessionTitle(now = Date.now(), {
  tzOffsetMinutes = -new Date().getTimezoneOffset(),
  previous = null,
} = {}) {
  const day = localDay(now, tzOffsetMinutes)
  const seq = previous?.day === day && Number.isInteger(previous.seq) && previous.seq > 0 ? previous.seq + 1 : 1
  return { title: titleFor(day, seq), state: { day, seq } }
}
