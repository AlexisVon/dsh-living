/** Per-gem proactive-send quota. Event replies (`origin: 'event'`) never consume it. */

export function createProactiveLimit({ state, config = {}, save = () => {}, now = () => Date.now() } = {}) {
  state.limits ??= { day: '', proactiveSent: 0 }

  const isProactive = (item) => item?.origin !== 'event'

  function dayKey(at) {
    const date = new Date(at)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  function sync(at = now()) {
    const day = dayKey(at)
    if (state.limits.day !== day) {
      state.limits = { day, proactiveSent: 0 }
      save()
    }
  }

  sync()

  return {
    isProactive,
    atLimit(item, at = now()) {
      if (!isProactive(item)) return false
      sync(at)
      const cap = Number(config.proactiveDaily)
      return Number.isFinite(cap) && cap > 0 && (state.limits.proactiveSent ?? 0) >= cap
    },
    noteSent(item, at = now()) {
      if (!isProactive(item)) return
      sync(at)
      state.limits.proactiveSent = (state.limits.proactiveSent ?? 0) + 1
      save()
    },
    snapshot(at = now()) {
      sync(at)
      return { day: state.limits.day, proactiveSent: state.limits.proactiveSent ?? 0 }
    },
  }
}
