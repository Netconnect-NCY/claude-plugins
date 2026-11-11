// The plugin report: tells Swarm2 which plugin version runs and whether the local-edit guard is on, so the server's
// plan_only client gate can accept Swarm2 tool calls from this user. POST {base}/me/plugin/report with the status token,
// body { client, plugin_version, guard, session }. Best-effort: never awaited by a hook, never throws, short timeout,
// at most once per REPORT_INTERVAL_MS per session, and at once when the guard state changes.
//
// The report is self-declared: anyone can send it. It is a guard rail for honest clients, not a security boundary.
import type { EngineInterface } from 'claude-code'

import { postToSwarm2 } from './connection'

export const PLUGIN_REPORT_PATH = '/me/plugin/report'
/** A successful report is repeated this often while the session works (the server's "recent" window defaults to 15 min). */
export const REPORT_INTERVAL_MS = 5 * 60_000
/** A failed or unsent report (no token, server down, HTTP error) is tried again after this long. */
export const REPORT_RETRY_MS = 30_000
/** How long one report may take before it counts as failed. */
export const REPORT_TIMEOUT_MS = 4000

export type GuardState = 'on' | 'off'
export type PluginReport = { client: 'claude-code'; plugin_version: string; guard: GuardState; session?: string }

/** What was last sent for a session: when, which guard state, whether it was accepted, and whether one is in flight. */
export type ReportMemory = { at: number; guard: GuardState; ok: boolean; inflight: boolean }

/** The report body; the session id is dropped unless it matches the protocol's [\w-]{1,100}. */
export function reportBody(version: string, guard: GuardState, session: string | null): PluginReport {
  return {
    client: 'claude-code', plugin_version: version, guard,
    ...(session && /^[\w-]{1,100}$/.test(session) ? { session } : {}),
  }
}

/** Whether a report is due: nothing sent yet, the guard state changed, or the interval (retry window after a failure)
 * has passed. Never while one is in flight. */
export function reportDue(prev: ReportMemory | undefined, guard: GuardState, now: number): boolean {
  if (!prev) return true
  if (prev.inflight) return false
  if (prev.guard !== guard) return true
  return now - prev.at >= (prev.ok ? REPORT_INTERVAL_MS : REPORT_RETRY_MS)
}

let version = ''
let clock: () => number = () => Date.now()
const memory = new Map<string, ReportMemory>()
const pending = new Set<Promise<void>>()

/** register.tsx sets the plugin version (PLUGIN_VERSION); null or an empty string turns reporting off. The server URL and
 * the token come from connection.ts. */
export function setPluginVersion(v: string | null): void {
  version = v ?? ''
}

/** For tests: forget what was sent, restore the clock (or set one). */
export function resetPluginReports(now?: () => number): void {
  memory.clear()
  clock = now ?? (() => Date.now())
}

/** For tests: wait until every report started so far has settled. */
export async function flushPluginReports(): Promise<void> {
  while (pending.size) await Promise.all([...pending])
}

async function sessionKey($: EngineInterface): Promise<string | null> {
  try { return await $.session.id() } catch { return null }
}

async function send($: EngineInterface, guard: GuardState): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return
  const session = await sessionKey($)
  const key = session ?? ''
  const now = clock()
  if (!reportDue(memory.get(key), guard, now)) return
  const entry: ReportMemory = { at: now, guard, ok: false, inflight: true }
  memory.set(key, entry)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), REPORT_TIMEOUT_MS) })
    entry.ok = await Promise.race([postToSwarm2($, PLUGIN_REPORT_PATH, reportBody(version, guard, session)), timeout])
  } catch { entry.ok = false } finally {
    clearTimeout(timer)
    entry.inflight = false
    entry.at = clock()
  }
}

/** Reports the guard state when a report is due. Never throws and never needs awaiting (the returned promise is only for
 * callers that want to wait, e.g. tests). `guardOn` is false while /swarm2-local or SWARM2_LOCAL_EDITS is in effect. */
export function reportPluginState($: EngineInterface, guardOn: boolean): Promise<void> {
  const p = send($, guardOn ? 'on' : 'off').catch(() => { /* best-effort */ })
  pending.add(p)
  void p.finally(() => pending.delete(p))
  return p
}
