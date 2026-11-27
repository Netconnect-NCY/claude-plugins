// The Swarm2 server this plugin talks to and the status token it uses: shared by the pane (register.tsx), the guard's override
// report and the plugin report. register.tsx configures it at load; the token is never logged, shown or stored here.
//
// (The hooks loader only lets `$` reach functions declared at the top of a file of the module, so the POSTs live here as
// plain functions instead of callbacks register.tsx hands to the guard.)
import type { EngineInterface, HttpInit, HttpResponse } from 'claude-code'

import {
  DEFAULT_PROFILE, STORED_PROFILES_KEY, STORED_SCOPE_KEY, STORED_TOKEN_KEY, isRedirect, mayCarryToken, normalizeProfile,
  originOf, selectTokens, stateNamespace,
} from './token-selection'

export const DEFAULT_BASE = 'https://swarm2-mcp.netconnect.ro'

let base = DEFAULT_BASE
let configured = ''
let profile = DEFAULT_PROFILE
let configuredAtLoad = false
/** Set when /swarm2-token saved a value in THIS session: only then does the stored token outrank the configured option. */
let sessionOverride = false
/** The token /swarm2-token saved (verified, in secure storage) in THIS session: tried first, the configured option after it. */
let sessionToken = ''

/**
 * register.tsx: the base URL and the configured status token of the plugin options. Returns what it kept. A new
 * configuration (another base or profile, or another configured token) drops the token /swarm2-token saved and its
 * override: that one belonged to the previous configuration and is never sent to this one.
 */
export function configureConnection(options: { baseUrl?: unknown; statusToken?: unknown; profile?: unknown }): { base: string; token: string } {
  const nextConfigured = typeof options.statusToken === 'string' ? options.statusToken.trim() : ''
  const nextBase = String(options.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')
  const nextProfile = normalizeProfile(options.profile)
  if (!configuredAtLoad || nextBase !== base || nextProfile !== profile || nextConfigured !== configured) {
    sessionOverride = false
    sessionToken = ''
  }
  configured = nextConfigured
  base = nextBase
  profile = nextProfile
  configuredAtLoad = true
  return { base, token: configured }
}

/** For tests: forget the configuration (POSTs then go nowhere until configureConnection runs again). */
export function resetConnection(): void {
  base = DEFAULT_BASE
  configured = ''
  profile = DEFAULT_PROFILE
  configuredAtLoad = false
  sessionOverride = false
  sessionToken = ''
}

export function setSessionOverride(value: boolean): void { sessionOverride = value }

/** register.tsx: the configured token, when the migration activated a verified secure copy the load-time options predate. */
export function setConfiguredToken(value: string): void { configured = value.trim() }

/**
 * register.tsx: the token /swarm2-token just saved (verified) in the sensitive option, or '' when /swarm2-token clear drops
 * it. A saved token is this session's override; a cleared one ends it.
 */
export function setSessionToken(value: string): void {
  sessionToken = value.trim()
  sessionOverride = sessionToken !== ''
}

export function getSessionToken(): string { return sessionToken }

/** The service the token belongs to: base URL and profile (the migration's eligibility, token-storage.ts). */
export function connectionContext(): { base: string; profile: string } { return { base, profile } }

/** The namespace of this service's state (origin + profile; never the token). */
export function connectionNamespace(): string { return stateNamespace(base, profile) }

/** The origin + profile a /swarm2-token value is saved for (register.tsx stores it next to the token). */
export function connectionScope(): { origin: string; profile: string } { return { origin: originOf(base), profile } }

/**
 * Token candidates in order (token-selection.ts selectTokens), with the token /swarm2-token saved in this session: first
 * while its override holds, else right after the configured one (a fallback). The one selection the poll and
 * postToSwarm2 share. The store is re-read every time (another session may have rotated it).
 */
export async function tokenCandidates($: EngineInterface, configuredToken: string = configured): Promise<string[]> {
  const read = async (key: string): Promise<unknown> => { try { return await $.store.get(key) } catch { return null } }
  const [token, scope, profiles] = await Promise.all([read(STORED_TOKEN_KEY), read(STORED_SCOPE_KEY), read(STORED_PROFILES_KEY)])
  const selected = selectTokens({ base, profile, configured: configuredToken, sessionOverride }, { token, scope, profiles })
  if (!sessionToken || !originOf(base)) return selected
  const head = configuredToken.trim()
  const ordered = sessionOverride ? [sessionToken, ...selected]
    : selected[0] === head && head ? [head, sessionToken, ...selected.slice(1)] : [sessionToken, ...selected]
  return [...new Set(ordered)]
}

/**
 * Fetches `url` with `token`, only when `url` is on the configured origin (otherwise it resolves a synthetic 421 and
 * nothing is sent). The host's fetch has no redirect option, so a 3xx answer is returned as is and its Location is never
 * requested again: no credential follows a redirect from here.
 */
export async function fetchWithToken($: EngineInterface, url: string, token: string, init: HttpInit = {}): Promise<HttpResponse> {
  if (!mayCarryToken(url, base)) return { status: 421, ok: false, headers: {}, text: '' }
  const res = await $.http.fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })
  return isRedirect(res.status) ? { ...res, ok: false } : res
}

/** POSTs JSON to `{base}{path}` with the first token candidate. Resolves true for a 2xx answer; false when nothing is
 * configured, there is no token, or the server answered otherwise. A network error rejects (callers are best-effort). */
export async function postToSwarm2($: EngineInterface, path: string, body: unknown): Promise<boolean> {
  if (!configuredAtLoad) return false
  const t = (await tokenCandidates($))[0]
  if (!t) return false
  const res = await fetchWithToken($, `${base}${path}`, t, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return res.ok
}
