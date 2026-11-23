// Where the /swarm2-token value lives: the manifest's `statusToken` userConfig field, declared `sensitive`, which the host
// keeps in secure storage (claude-code.d.ts PluginOptions) and a plugin writes with `$.config.set` and reads back with
// `$.config.list`. There is no other secret-store API in the host types. The plain-text copy older versions kept in
// `$.store` is moved there once and removed only after the secure copy reads back equal. Tokens are never logged or returned.
import type { EngineInterface } from 'claude-code'

import { STORED_SCOPE_KEY, STORED_TOKEN_KEY } from './token-selection'

/** The `/config` row of the sensitive manifest field: `<plugin>.<field>`. */
export const SECURE_TOKEN_KEY = 'swarm2.statusToken'

/** 'saved': the secure copy reads back equal. 'migration_required': not stored securely; the person re-enters it in /config. */
export type SecureSaveResult = 'saved' | 'migration_required'
/** 'none': no plain copy (nothing to do, also on a re-run). 'migrated': secure copy verified, plain copy removed. */
export type MigrationResult = 'none' | 'migrated' | 'migration_required'

export const MIGRATION_REQUIRED_MESSAGE =
  'Swarm2 status token: migration_required — it could not be moved to secure storage. Re-enter it in /config (Swarm2 status token, a masked field).'

/** Whether the secure row now holds exactly `token`; compared here, never printed. */
async function secureEquals($: EngineInterface, token: string): Promise<boolean> {
  const row = (await $.config.list()).find(r => r.key === SECURE_TOKEN_KEY)
  return typeof row?.value === 'string' && row.value === token
}

/** Writes `token` to the sensitive field and verifies it. Any deny, mismatch or error is 'migration_required'. */
export async function saveTokenSecurely($: EngineInterface, token: string): Promise<SecureSaveResult> {
  try {
    const res = await $.config.set({ key: SECURE_TOKEN_KEY, value: token })
    if (res.deny !== undefined) return 'migration_required'
    return await secureEquals($, token) ? 'saved' : 'migration_required'
  } catch {
    return 'migration_required'
  }
}

/**
 * Moves a plain-text stored token into secure storage. Idempotent: with no plain copy it does nothing. The plain copy is
 * deleted only after the secure copy verifies; on any failure it stays, so the only credential is never lost.
 */
export async function migratePlainToken($: EngineInterface): Promise<MigrationResult> {
  let plain: unknown
  try { plain = await $.store.get(STORED_TOKEN_KEY) } catch { return 'migration_required' }
  if (typeof plain !== 'string' || !plain.trim()) return 'none'
  if (await saveTokenSecurely($, plain.trim()) !== 'saved') return 'migration_required'
  try {
    await $.store.delete(STORED_TOKEN_KEY)
    await $.store.delete(STORED_SCOPE_KEY)
  } catch {
    // the secure copy is verified; a plain copy left behind is removed on the next run
  }
  return 'migrated'
}
