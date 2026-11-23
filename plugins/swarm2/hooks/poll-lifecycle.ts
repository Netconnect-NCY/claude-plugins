// The feed poll's lifecycle (register.tsx): when it last tried and last got data, which connection generation an answer
// belongs to, one in-flight poll shared by every caller, a bounded backoff for transient failures, and the timers that all
// end at dispose. Pure: the clock and the timers are handed in (the host's $.clock in the plugin, fakes in tests). It never
// sees a token: the identity it compares is the caller's opaque key, and nothing here logs.

export type Timer = { cancel: () => void }
export type Timers = {
  after: (ms: number, fn: () => void) => Timer | undefined
  every: (ms: number, fn: () => void) => Timer | undefined
}

/** What one poll attempt reports: data arrived, a final failure (401, 403, any other 4xx), or a transient one worth a retry. */
export type Attempt = 'ok' | 'final' | 'transient'

/** A status worth another try after a pause: unreachable (0), 408, 429 and 5xx. Never a 403, a 401 or a redirect. */
export function isTransient(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600)
}

export const RETRY_ATTEMPTS = 3
export const RETRY_BASE_MS = 1000
export const RETRY_MAX_MS = 8000

/** The pause before retry `n` (1-based): doubling from the base, never above the cap. */
export function backoffMs(n: number, base = RETRY_BASE_MS, max = RETRY_MAX_MS): number {
  return Math.min(max, base * 2 ** Math.max(0, n - 1))
}

export type LifecycleOptions = {
  now: () => number
  timers: Timers
  /** Called when the identity changes: drop every cached value that belonged to the previous one. */
  clearPrivate?: () => void
  attempts?: number
  baseMs?: number
  maxMs?: number
}

export class PollLifecycle {
  /** When a poll last started, successful or not. */
  lastAttemptAt: number | null = null
  /** When a poll last brought data: the only time the stale check reads. */
  lastSuccessfulDataAt: number | null = null
  /** Bumped on identity change and on dispose; an answer of an older generation is dropped. */
  generation = 0
  private identity: string | null = null
  private timers = new Set<Timer>()
  private disposed = false

  constructor(private readonly opts: LifecycleOptions) {}

  /** Records the identity (origin, profile, account and credential, as one opaque key) the next poll uses. A change bumps
   * the generation and clears the private state; resolves the current generation. */
  identify(key: string): number {
    if (this.identity !== null && this.identity !== key) {
      this.generation++
      this.lastSuccessfulDataAt = null
      this.opts.clearPrivate?.()
    }
    this.identity = key
    return this.generation
  }

  /** Whether an answer started in `generation` may still be applied. */
  isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  markSuccess(generation: number): boolean {
    if (!this.isCurrent(generation)) return false
    this.lastSuccessfulDataAt = this.opts.now()
    return true
  }

  isStale(staleMs: number, now = this.opts.now()): boolean {
    return this.lastSuccessfulDataAt !== null && now - this.lastSuccessfulDataAt > staleMs
  }

  /**
   * Runs `attempt`, or joins the one already running: concurrent callers share one request. A transient result is retried
   * after a doubling pause, at most `attempts` tries in all; a final result (a 403 above all) is never retried. Resolves when
   * the current try is over (a caller never waits out a backoff); a request during a backoff leaves it to the pending retry.
   */
  request(attempt: () => Promise<Attempt>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.current) return this.current
    if (this.backingOff) return Promise.resolve()
    const generation = this.generation
    const max = this.opts.attempts ?? RETRY_ATTEMPTS
    const once = (n: number): Promise<void> => {
      this.lastAttemptAt = this.opts.now()
      const p = attempt().catch((): Attempt => 'transient').then(result => {
        if (this.current === p) this.current = null
        if (result !== 'transient' || n >= max || !this.isCurrent(generation)) return
        this.backingOff = true
        void this.pause(backoffMs(n, this.opts.baseMs, this.opts.maxMs)).then(go => {
          this.backingOff = false
          if (go && this.isCurrent(generation)) void once(n + 1)
        })
      })
      this.current = p
      return p
    }
    return once(1)
  }

  private current: Promise<void> | null = null
  private backingOff = false

  /** Starts the poll interval (tracked, so dispose ends it). */
  every(ms: number, fn: () => void): void {
    if (this.disposed) return
    const t = this.opts.timers.every(ms, fn)
    if (t) this.timers.add(t)
  }

  /** Tracks a timer started elsewhere (the spinner), so dispose ends it too. */
  track(t: Timer | undefined | null): void {
    if (t) this.disposed ? t.cancel() : this.timers.add(t)
  }

  untrack(t: Timer | undefined | null): void {
    if (t) this.timers.delete(t)
  }

  get pendingTimers(): number { return this.timers.size }

  /** Cancels every timer, drops any answer still under way, and ends a pending backoff. Idempotent. */
  dispose(): void {
    this.generation++
    this.disposed = true
    this.current = null
    this.backingOff = false
    for (const t of this.timers) t.cancel()
    this.timers.clear()
    for (const wake of this.sleepers) wake(false)
    this.sleepers.clear()
  }

  private sleepers = new Set<(go: boolean) => void>()

  private pause(ms: number): Promise<boolean> {
    return new Promise(resolve => {
      let timer: Timer | undefined
      const wake = (go: boolean) => {
        this.sleepers.delete(wake)
        if (timer) this.timers.delete(timer)
        resolve(go)
      }
      this.sleepers.add(wake)
      timer = this.opts.timers.after(ms, () => wake(true))
      if (timer) this.timers.add(timer)
      else wake(true) // a host without a timer answer: retry at once rather than hang
    })
  }
}
