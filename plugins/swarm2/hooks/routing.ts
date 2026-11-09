import type { RunRouting } from '../types'

const SOURCES = ['model', 'heuristic', 'fallback'] as const
const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : null)

/** Validates the untrusted `routing` field of a control-feed run. An older server omits it, a newer one may add fields: both are
 * tolerated, anything malformed becomes null (no routing line) rather than an error. Only the bounded known fields are kept. */
export function parseRouting(value: unknown): RunRouting | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const d = v.difficulty
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 5) return null
  const source = (SOURCES as readonly unknown[]).includes(v.classification_source) ? (v.classification_source as RunRouting['classification_source']) : null
  return {
    difficulty: d as RunRouting['difficulty'], classification_source: source,
    provider: text(v.provider, 120), model: text(v.model, 120), effort: text(v.effort, 40), why: text(v.why, 240) ?? '',
    reasons: Array.isArray(v.reasons) ? v.reasons.slice(0, 4).flatMap(r => { const t = text(r, 160); return t ? [t] : [] }) : [],
  }
}

/** One pane line: difficulty and source, the requested provider/model/effort, then why. "requested" because the observed model
 * is telemetry reported separately by the worker rows. */
export function routingLine(r: RunRouting): string {
  const chosen = [r.provider, r.model, r.effort].filter(Boolean).join(' / ') || 'provider default'
  return `d${r.difficulty}${r.classification_source ? ` (${r.classification_source})` : ''} → ${chosen} requested${r.why ? ` · ${r.why}` : ''}`
}
