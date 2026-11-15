// Who is using an account right now, for the account row of the pane: "Alex×2, Costin×1". Shown on the same line as the
// ⚙ worker count (it used to be a separate dimmed "used by" line that was easy to miss and cost a row per busy account).
export type AccountUser = { name: string; count: number }

/** Names with their run counts, most active first (as the server sorts them); empty when nobody uses the account. */
export function accountUsersLabel(users: readonly AccountUser[] | null | undefined, max = 3): string {
  const valid = (users ?? []).filter(u => typeof u?.name === 'string' && u.name.trim() !== '' && Number.isFinite(u.count) && u.count > 0)
  if (valid.length === 0) return ''
  const shown = valid.slice(0, max).map(u => `${u.name.trim()}×${u.count}`)
  const rest = valid.length - shown.length
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ')
}
