import type { Queue, QueueEntry, RepoQueue, WaitingForPaths } from '../types'

export const QUEUE_MAX_REPOS = 10
export const QUEUE_MAX_ENTRIES = 20
const TITLE_CHARS = 48

const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || null : null)
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0)
const time = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function paths(value: unknown): WaitingForPaths | null {
  const v = record(value)
  const id = text(v?.blocking_run_id, 64)
  return v && id ? { blocking_run_id: id, blocking_pattern: text(v.blocking_pattern, 512) } : null
}

function entry(value: unknown): QueueEntry | null {
  const v = record(value)
  if (!v) return null
  const run_id = text(v.run_id, 64)
  const status = text(v.status, 40)
  const since = time(v.since)
  if (!run_id || !status || !since || count(v.position) === 0) return null
  return {
    position: count(v.position), run_id, title: text(v.title, 120), status, status_reason: text(v.status_reason, 300),
    requester: text(v.requester, 120), mine: v.mine === true, provider: text(v.provider, 120), model: text(v.model, 120),
    effort: text(v.effort, 40), waiting_for_paths: paths(v.waiting_for_paths), retry_at: time(v.retry_at), since,
  }
}

function repoQueue(value: unknown): RepoQueue | null {
  const v = record(value)
  const repo = text(v?.repo, 200)
  if (!v || !repo || !Array.isArray(v.entries)) return null
  const all = v.entries.flatMap(e => { const x = entry(e); return x ? [x] : [] })
  const entries = all.slice(0, QUEUE_MAX_ENTRIES)
  const more = count(v.more) + all.length - entries.length
  return entries.length || more ? { repo, entries, more } : null
}

/** Validates the untrusted, optional `queue` of the control feed. An older server omits it and anything malformed becomes an empty
 * queue (nothing drawn) rather than an error; a malformed repo or entry is dropped alone. Bounded like the server's own caps. */
export function parseQueue(value: unknown): Queue {
  const v = record(value)
  if (!v || !Array.isArray(v.repos)) return { repos: [], more_repos: 0 }
  const all = v.repos.flatMap(r => { const x = repoQueue(r); return x ? [x] : [] })
  const repos = all.slice(0, QUEUE_MAX_REPOS)
  return { repos, more_repos: count(v.more_repos) + all.length - repos.length }
}

/** The glyph and word a queue line shows for an entry's status. */
export function queueStatus(e: Pick<QueueEntry, 'status' | 'status_reason'>): { glyph: string; word: string } {
  if (e.status === 'queued' && e.status_reason === 'waiting_for_paths') return { glyph: '⧗', word: 'waiting for paths' }
  if (e.status === 'queued') return { glyph: '·', word: 'queued' }
  if (e.status === 'waiting_quota') return { glyph: '⏸', word: 'waiting for quota' }
  if (e.status === 'running') return { glyph: '▶', word: 'running' }
  if (e.status === 'verifying') return { glyph: '◎', word: 'verifying' }
  if (e.status.startsWith('awaiting')) return { glyph: '⚑', word: 'awaiting approval' }
  return { glyph: '•', word: e.status.replace(/_/g, ' ') }
}

/** The title cut to fit one pane line beside the other fields. */
export function queueTitle(title: string | null): string | null {
  if (!title) return null
  return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title
}

/** provider / model / effort, or null when the viewer may not see them (or none was chosen). */
export function queueRouting(e: Pick<QueueEntry, 'provider' | 'model' | 'effort'>): string | null {
  return [e.provider, e.model, e.effort].filter(Boolean).join(' / ') || null
}
