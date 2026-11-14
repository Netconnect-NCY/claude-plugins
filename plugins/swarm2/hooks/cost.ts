// Cost text for the Swarm2 pane. Pure: no engine imports, so tests can load it directly.
// A cost is API-equivalent at list price (the server's cost_label): never show unknown as $0.00.
import { oneLine } from './toasts'

export type RunCostFields = { tokens?: number | null; cost_usd?: number | null; cost_partial?: boolean | null; cost_label?: string | null }
export type TodayCostFields = { tokens?: number | null; cost_usd?: number | null; partial?: boolean }

export function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

export function tokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** '<tokens> tok · $X.XX API-eq' ('~$X.XX' when partial), 'cost unknown' when cost_usd is null. null when the server sent no cost
 * at all (an older server), so the pane shows nothing rather than a false 'cost unknown'. */
export function runCostText(r: RunCostFields): string | null {
  if ((r.tokens ?? null) === null && (r.cost_usd ?? null) === null && (r.cost_label ?? null) === null) return null
  const tok = r.tokens == null ? null : `${tokenCount(r.tokens)} tok`
  const cost = r.cost_usd == null ? 'cost unknown' : `${r.cost_partial ? '~' : ''}${usd(r.cost_usd)} API-eq`
  return [tok, cost].filter(Boolean).join(' · ')
}

/** 'today $Y.YY API-eq' ('~' when partial), 'today unknown' when cost_usd is null; null when the server has no total. */
export function todayCostText(t: TodayCostFields | null | undefined): string | null {
  if (!t) return null
  const cost = t.cost_usd == null ? 'today unknown' : `today ${t.partial ? '~' : ''}${usd(t.cost_usd)} API-eq`
  return t.tokens == null ? cost : `${cost} · ${tokenCount(t.tokens)} tok`
}

/** The server's cost label as a one-line footnote, or null when the server sent none. */
export function costFootnote(label: string | null | undefined): string | null {
  return typeof label === 'string' && label.trim() ? oneLine(label, 200) : null
}
