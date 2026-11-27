// The one token selection both the feed poll (register.tsx) and postToSwarm2 (connection.ts) use. Pure: the caller reads
// the store and hands the values in. Tokens are never logged, and no key built here ever contains one.
//
// Rules: a candidate comes from the configured service's origin and profile; a token saved for another profile is a
// fallback only when it was saved for the same origin; a token is sent only to the configured origin; a 403 is final
// (never retried with another credential); a redirect is never followed with a credential.

export const DEFAULT_PROFILE = 'default'
/** Store keys: the /swarm2-token value, the origin + profile it was saved for, and tokens saved for other profiles. */
export const STORED_TOKEN_KEY = 'statusToken'
export const STORED_SCOPE_KEY = 'statusTokenScope'
export const STORED_PROFILES_KEY = 'statusTokenProfiles'

export type Scope = { origin: string; profile: string }
export type SelectionConfig = { base: string; profile: string; configured: string; sessionOverride: boolean }
export type StoredTokens = { token?: unknown; scope?: unknown; profiles?: unknown }

/** The origin of a URL (`https://host:port`), or '' for something that is not an http(s) URL. */
export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : ''
  } catch { return '' }
}

export function normalizeProfile(p: unknown): string {
  return typeof p === 'string' && /^[\w.-]{1,64}$/.test(p.trim()) ? p.trim() : DEFAULT_PROFILE
}

function asScope(v: unknown): Scope | null {
  if (!v || typeof v !== 'object') return null
  const { origin, profile } = v as Record<string, unknown>
  return typeof origin === 'string' && typeof profile === 'string' ? { origin, profile } : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The stored /swarm2-token value when it belongs to this origin and profile, else ''. A legacy value without a scope was
 * saved through /swarm2-token for the configured service, so it counts as this origin and profile; one saved for another
 * origin or profile is never this service's own. Only an absent scope is legacy (the host store reads a missing key as
 * null): a scope that is present but malformed names no service, so its token is never this one's. Selection and the
 * secure-storage migration share this rule.
 */
export function ownStoredToken(cfg: { base: string; profile: string }, stored: StoredTokens): string {
  const origin = originOf(cfg.base)
  const legacy = stored.scope === undefined || stored.scope === null
  const scope = asScope(stored.scope)
  const own = legacy || (scope !== null && scope.origin === origin && scope.profile === cfg.profile)
  return origin && str(stored.token) && own ? str(stored.token) : ''
}

/**
 * Token candidates in order, distinct and non-empty. First the configured option and the stored /swarm2-token value of
 * this origin and profile (the stored one first only when saved in this session); then tokens saved for other profiles
 * of the SAME origin. A stored value saved for another origin is never a candidate. A legacy stored value without a
 * scope was saved through /swarm2-token for the configured service, so it counts as this origin and profile.
 */
export function selectTokens(cfg: SelectionConfig, stored: StoredTokens): string[] {
  const origin = originOf(cfg.base)
  if (!origin) return []
  const own = ownStoredToken(cfg, stored)
  const ordered = cfg.sessionOverride ? [own, cfg.configured] : [cfg.configured, own]
  if (Array.isArray(stored.profiles)) {
    for (const entry of stored.profiles) {
      const s = asScope(entry)
      if (s && s.origin === origin && s.profile !== cfg.profile) ordered.push(str((entry as { token?: unknown }).token))
    }
  }
  return [...new Set(ordered.filter(Boolean))]
}

/** Whether `url` may carry a token of the service at `base`: only the very same origin. */
export function mayCarryToken(url: string, base: string): boolean {
  const o = originOf(url)
  return o !== '' && o === originOf(base)
}

/** What a status answer means for the next candidate: 401 tries the next one; everything else (403 above all) stops. */
export function retryWithNextCandidate(status: number): boolean {
  return status === 401
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

/** The namespace of per-service state (guard reports, history): service origin + profile, never the token. */
export function stateNamespace(base: string, profile: string): string {
  return `${originOf(base) || 'invalid'}#${normalizeProfile(profile)}`
}
