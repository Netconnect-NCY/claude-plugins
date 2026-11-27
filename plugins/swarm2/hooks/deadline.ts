// A deadline on the host's clock: the hooks module has no Node and no free timers, so a bound on a wait is one
// `$.clock.after`, cancelled as soon as the wait it bounds is over.
import type { EngineInterface } from 'claude-code'

export type Deadline<T> = { promise: Promise<T>; cancel: () => void }

/** Resolves `value` after `ms` milliseconds unless `cancel()` comes first (then it never resolves). */
export function deadline<T>($: EngineInterface, ms: number, value: T): Deadline<T> {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>(r => { resolve = r })
  // outside the executor: a host that cannot start the timer throws here, never hands back a silently rejected wait
  const timer = $.clock.after(ms, () => resolve(value))
  return { promise, cancel: () => timer?.cancel() }
}
