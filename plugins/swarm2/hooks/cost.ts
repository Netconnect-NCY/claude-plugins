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

export type BaselinePct = { p50: number | null; p90: number | null }
/** The compact per_deliverable summary (swarm_cost_report view per_deliverable). Absent unless the server sends it. */
export type TokenBaselineFields = { deliverables: number; noncached_input: BaselinePct; output: BaselinePct; attempts: BaselinePct; failed_work_tokens?: number | null }

const pctText = (p: BaselinePct): string => p.p50 === null || p.p90 === null ? 'n/a' : `${tokenCount(p.p50)}/${tokenCount(p.p90)}`

/** 'per deliverable (n=N) P50/P90: noncached A/B · output C/D · attempts E/F · failed work G tok'; without data a pointer to the tool view. */
export function baselineText(b: TokenBaselineFields | null | undefined): string {
  if (!b) return 'token baseline: swarm_cost_report view per_deliverable'
  if (b.deliverables === 0) return 'per deliverable: none in the window'
  const failed = b.failed_work_tokens == null ? '' : ` · failed work ${tokenCount(b.failed_work_tokens)} tok`
  return `per deliverable (n=${b.deliverables}) P50/P90: noncached ${pctText(b.noncached_input)} · output ${pctText(b.output)} · attempts ${pctText(b.attempts)}${failed}`
}
