// The Swarm2 server this plugin talks to and the status token it uses: shared by the pane (register.tsx), the guard's override
// report and the plugin report. register.tsx configures it at load; the token is never logged, shown or stored here.
//
// (The hooks loader only lets `$` reach functions declared at the top of a file of the module, so the POSTs live here as
// plain functions instead of callbacks register.tsx hands to the guard.)
import type { EngineInterface } from 'claude-code'

export const DEFAULT_BASE = 'https://swarm2-mcp.netconnect.ro'

let base = DEFAULT_BASE
let configured = ''
let configuredAtLoad = false
/** Set when /swarm2-token saved a value in THIS session: only then does the stored token outrank the configured option. */
let sessionOverride = false

/** register.tsx: the base URL and the configured status token of the plugin options. Returns what it kept. */
export function configureConnection(options: { baseUrl?: unknown; statusToken?: unknown }): { base: string; token: string } {
  configured = typeof options.statusToken === 'string' ? options.statusToken.trim() : ''
  base = String(options.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')
  configuredAtLoad = true
  return { base, token: configured }
}

/** For tests: forget the configuration (POSTs then go nowhere until configureConnection runs again). */
export function resetConnection(): void {
  base = DEFAULT_BASE
  configured = ''
  configuredAtLoad = false
  sessionOverride = false
}

export function setSessionOverride(value: boolean): void { sessionOverride = value }

/**
 * Token candidates in order, distinct and non-empty. The configured option comes first, so a freshly fixed setting is
 * never shadowed by a stale value persisted by an earlier session; a value saved with /swarm2-token in this session is a
 * deliberate override and comes first. The store is re-read every time (another session may have rotated it).
 */
export async function tokenCandidates($: EngineInterface, configuredToken: string = configured): Promise<string[]> {
  let stored = ''
  try { stored = String((await $.store.get('statusToken')) ?? '').trim() } catch { /* no store value */ }
  const ordered = sessionOverride ? [stored, configuredToken] : [configuredToken, stored]
  return [...new Set(ordered.filter(Boolean))]
}

/** POSTs JSON to `{base}{path}` with the first token candidate. Resolves true for a 2xx answer; false when nothing is
 * configured, there is no token, or the server answered otherwise. A network error rejects (callers are best-effort). */
export async function postToSwarm2($: EngineInterface, path: string, body: unknown): Promise<boolean> {
  if (!configuredAtLoad) return false
  const t = (await tokenCandidates($))[0]
  if (!t) return false
  const res = await $.http.fetch(`${base}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return res.ok
}
