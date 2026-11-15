// Account usage windows in the pane: when an expired window resets next, and how long a quota cooldown has left.
// Pure helpers (tested in test/plugin/window-status.test.ts); register.tsx only renders their output.

/** Window length in hours from its name ("5h", "5 h", "7d", "seven_day", "weekly", ...); null when the name says nothing. */
export function windowHours(name: string): number | null {
  const n = name.trim().toLowerCase()
  if (n === 'five_hour') return 5
  if (n === 'seven_day' || n === 'weekly' || n === 'week') return 168
  if (n === 'daily' || n === 'day') return 24
  const m = /^(\d+(?:\.\d+)?)\s*(h|hour|hours|d|day|days)$/.exec(n)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return m[2]!.startsWith('d') ? value * 24 : value
}

/**
 * The next reset of a window whose last reset has passed. Only fixed calendar windows (24 h or longer) are projected:
 * a short (5 h) window starts again on the next use, so its next reset is not known in advance (null).
 */
export function nextFixedReset(name: string, resetsAt: string | null, now: number): string | null {
  const hours = windowHours(name)
  if (hours === null || hours < 24 || !resetsAt) return null
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return null
  const step = hours * 3_600_000
  if (at > now) return new Date(at).toISOString()
  const periods = Math.floor((now - at) / step) + 1
  return new Date(at + periods * step).toISOString()
}

/** "2h05", "42m", "30s"; "" for a negative or invalid duration. */
export function durationLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  return m === 60 ? `${h + 1}h00` : `${h}h${m < 10 ? `0${m}` : m}`
}

/**
 * A cooldown's progress: the bar fills as the cooldown runs out (full = recovered). Without a known start only the time
 * left is given (bar null). null when the end is unknown or has passed.
 */
export function cooldownProgress(since: string | null | undefined, until: string | null, now: number, cells = 8): { bar: string | null; left: string } | null {
  const end = until ? Date.parse(until) : NaN
  if (!Number.isFinite(end) || end <= now) return null
  const left = durationLeft(end - now)
  const start = since ? Date.parse(since) : NaN
  if (!Number.isFinite(start) || start >= end) return { bar: null, left }
  const done = Math.max(0, Math.min(1, (now - start) / (end - start)))
  const full = Math.max(0, Math.min(cells, Math.floor(done * cells)))
  return { bar: '▰'.repeat(full) + '▱'.repeat(cells - full), left }
}
