// Where the /swarm2-token value lives: the manifest's `statusToken` userConfig field, declared `sensitive`, which the host
// keeps in secure storage (claude-code.d.ts PluginOptions) and a plugin writes with `$.config.set` and reads back with
// `$.config.list`. There is no other secret-store API in the host types. The plain-text copy older versions kept in
// `$.store` is moved there once and removed only after the secure copy reads back equal. Tokens are never logged or returned.
import type { EngineInterface } from 'claude-code'

import { STORED_SCOPE_KEY, STORED_TOKEN_KEY, ownStoredToken } from './token-selection'

/** The `/config` row of the sensitive manifest field: `<plugin>.<field>`. */
export const SECURE_TOKEN_KEY = 'swarm2.statusToken'

/** 'saved': the secure copy reads back equal. 'migration_required': not stored securely; the person re-enters it in /config. */
export type SecureSaveResult = 'saved' | 'migration_required'
/**
 * 'none': no plain copy of this service's own (nothing to do, also on a re-run; one saved for another origin or profile
 * stays where it is, never moved). 'kept': this service's plain copy differs from the configured token, or from the token
 * secure storage holds now (a /swarm2-token save after the plugin loaded), which outranks it: that one is never
 * overwritten, and the plain copy stays as its fallback. 'migrated': secure copy verified,
 * plain copy removed.
 */
export type MigrationResult = 'none' | 'kept' | 'migrated' | 'migration_required'
/** The service the migration runs for (connection.ts) and the configured status token, which outranks a stored one. */
export type MigrationContext = { base: string; profile: string; configured: string }

export const MIGRATION_REQUIRED_MESSAGE =
  'Swarm2 status token: migration_required — it could not be moved to secure storage. Re-enter it in /config (Swarm2 status token, a masked field).'

/**
 * The secure row's current value, or null when there is no row or its value is not a string (an absent or unreadable
 * secure state, never the same as a real empty string); compared here, never printed. A failed read rejects.
 */
async function secureValue($: EngineInterface): Promise<string | null> {
  const row = (await $.config.list()).find(r => r.key === SECURE_TOKEN_KEY)
  return typeof row?.value === 'string' ? row.value : null
}

/** Writes `token` to the sensitive field and verifies it: the row must read back as exactly `token` (also for '').
 * Any deny, mismatch, missing or non-string row or error is 'migration_required'. */
export async function saveTokenSecurely($: EngineInterface, token: string): Promise<SecureSaveResult> {
  try {
    const res = await $.config.set({ key: SECURE_TOKEN_KEY, value: token })
    if (res.deny !== undefined) return 'migration_required'
    return await secureValue($) === token ? 'saved' : 'migration_required'
  } catch {
    return 'migration_required'
  }
}

/**
 * Moves a plain-text stored token of this origin and profile (token-selection.ts ownStoredToken) into secure storage.
 * Idempotent: with no such plain copy it does nothing. The plain copy is deleted only after the secure copy verifies; on
 * any failure it stays, so the only credential is never lost. Once verified, `activate` receives the token to use.
 */
export async function migratePlainToken(
  $: EngineInterface, ctx: MigrationContext, activate: (token: string) => void = () => {},
): Promise<MigrationResult> {
  let token: unknown, scope: unknown
  try { [token, scope] = await Promise.all([$.store.get(STORED_TOKEN_KEY), $.store.get(STORED_SCOPE_KEY)]) } catch { return 'migration_required' }
  const own = ownStoredToken(ctx, { token, scope })
  if (!own) return 'none'
  const configured = ctx.configured.trim()
  if (configured && configured !== own) return 'kept'
  // `configured` was captured when the plugin loaded; the secure row may hold a newer token since (/swarm2-token, then
  // /clear or resume), so it is read again right before the write and never overwritten with a different plain one. An
  // absent, non-string or unreadable row is an unknown state: then nothing is written, activated or deleted
  let current: string | null
  try { current = await secureValue($) } catch { return 'migration_required' }
  if (current === null) return 'migration_required'
  if (current.trim() && current.trim() !== own) return 'kept'
  if (await saveTokenSecurely($, own) !== 'saved') return 'migration_required'
  activate(own)
  try {
    // a plain copy rewritten meanwhile (another value, or the same one rescoped to another service or a malformed scope)
    // is not the one just verified: it stays for the next run to judge
    const [nowToken, nowScope] = await Promise.all([$.store.get(STORED_TOKEN_KEY), $.store.get(STORED_SCOPE_KEY)])
    if (nowToken !== token || ownStoredToken(ctx, { token: nowToken, scope: nowScope }) !== own) return 'migrated'
    await $.store.delete(STORED_TOKEN_KEY)
    await $.store.delete(STORED_SCOPE_KEY)
  } catch {
    // the secure copy is verified; a plain copy left behind is removed on the next run
  }
  return 'migrated'
}
