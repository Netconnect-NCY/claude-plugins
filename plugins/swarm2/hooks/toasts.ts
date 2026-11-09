import type { Account, Attention, Deployment, Message, ProjectRow, Run } from '../types'

// The toast rules of the README, as pure functions over what the module remembers between polls.

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'])

/** The capability an approval item asks of the viewer; the server already filters on it, the pane re-checks. */
export const ATTENTION_CAPABILITY: Readonly<Record<string, string>> = {
  run_approval: 'run.approve_scope', deploy_approval: 'deploy.prod.approve',
}

/**
 * Approval items ("waiting for your approval") only where the viewer's project row grants the matching capability. Items
 * name their repo first (`acme/app: …`); a row without capabilities (a server before roles) or no matching row keeps the
 * server's decision.
 */
export function visibleAttention(attention: Attention[], projects: ProjectRow[] | null | undefined): Attention[] {
  return attention.filter(a => {
    const needed = ATTENTION_CAPABILITY[a.kind]
    if (!needed) return true
    const project = projects?.find(p => a.text.startsWith(`${p.repo}:`))
    return project?.capabilities ? project.capabilities.includes(needed) : true
  })
}

type Snapshot = Pick<Run, 'status' | 'pr_url' | 'merge_status'>

// Structured fields keep PR URLs and status names from colliding with delimiters or substring checks.
export function runKey(run: Run): string {
  return JSON.stringify({ status: run.status, pr_url: run.pr_url, merge_status: run.merge_status ?? null } satisfies Snapshot)
}

/**
 * prevKey: the run's key at the previous poll, undefined for a run not seen before (never toasts, so the first poll does
 * not replay history). The `merging` phase alone never announces success: only the recorded merge outcome does.
 */
export function toastFor(prevKey: string | undefined, run: Run): string | null {
  if (prevKey === undefined || prevKey === runKey(run)) return null
  const prev = JSON.parse(prevKey) as Snapshot
  const prefix = `Swarm2 ${run.run_id.slice(0, 8)}`
  if (run.merge_status === 'merged' && prev.merge_status !== 'merged') {
    return `${prefix} merged (${run.repo})${run.merge_sha ? ` · ${run.merge_sha.slice(0, 8)}` : ''}`
  }
  if (prev.merge_status === 'pending' && run.merge_status && run.merge_status !== 'pending' && run.merge_status !== 'merged') {
    return `${prefix} merge ${run.merge_status}${run.merge_reason ? `: ${run.merge_reason}` : ''}`
  }
  if (run.pr_url && prev.pr_url !== run.pr_url) return `${prefix} opened a PR: ${run.pr_url}`
  if (prev.status === 'waiting_quota' && (run.status === 'queued' || run.status === 'running')) {
    return `${prefix} quota wait ended; resuming (${run.repo})`
  }
  if (TERMINAL.has(run.status) && prev.status !== run.status) {
    return `${prefix} ${run.status}${run.status_reason ? `: ${run.status_reason}` : ''}`
  }
  return null
}

/** Deployment phases worth a toast when a deployment reaches them. */
export const DEPLOYMENT_TOAST_PHASES = new Set(['done', 'failed', 'awaiting_approval'])

/** The phase the server sends, or the one its status maps to (as the server's deploymentPhase does). */
export function deploymentPhase(deployment: Deployment): string {
  if (deployment.phase) return deployment.phase
  if (deployment.status === 'succeeded') return 'done'
  if (deployment.status === 'failed' || deployment.status === 'cancelled') return 'failed'
  return deployment.status
}

/** Describe health after a merge without claiming which revision is deployed. */
export function observationLabel(deployment: Deployment): string {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(deployment.status)
  const result = deployment.status === 'cancelled' ? 'cancelled' : deployment.outcome ?? deployment.status
  const sha = deployment.merge_sha && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(deployment.merge_sha)
    ? ` · merged ${deployment.merge_sha.slice(0, 8)}` : ''
  return `${terminal ? `observed · ${result}` : 'observing'}${sha}`
}

type DeploymentSnapshot = { phase: string; status: string; source?: string; outcome?: Deployment['outcome'] }

export function deploymentKey(deployment: Deployment): string {
  return JSON.stringify({ phase: deploymentPhase(deployment), status: deployment.status,
    ...(deployment.source === 'external' ? { source: deployment.source, outcome: deployment.outcome ?? null } : {}),
  } satisfies DeploymentSnapshot)
}

/**
 * prevKey: undefined while loading the first feed (never toasts), null for a deployment first seen after that (a new
 * prod deployment starts in awaiting_approval, so it must be able to toast), else the deployment's previous key.
 */
export function deploymentToastFor(prevKey: string | null | undefined, deployment: Deployment): string | null {
  if (prevKey === undefined || prevKey === deploymentKey(deployment)) return null
  const prev = prevKey === null ? null : (JSON.parse(prevKey) as DeploymentSnapshot)
  const phase = deploymentPhase(deployment)
  if (deployment.source === 'external') {
    if (!['succeeded', 'failed', 'cancelled'].includes(deployment.status)
      || (prev?.source === 'external' && prev.status === deployment.status && prev.outcome === (deployment.outcome ?? null))) return null
    return `Swarm2 observation ${deployment.repo} → ${deployment.target} ${observationLabel(deployment)}${deployment.reason ? `: ${oneLine(deployment.reason, 160)}` : ''}`
  }
  if (!DEPLOYMENT_TOAST_PHASES.has(phase) || prev?.phase === phase) return null
  const what = phase === 'done' ? 'deployed' : phase === 'failed' ? `failed (${deployment.status})` : 'awaiting approval'
  return `Swarm2 deploy ${deployment.repo} → ${deployment.target} ${what}${deployment.reason ? `: ${oneLine(deployment.reason, 160)}` : ''}`
}

export const MAX_MESSAGE_TOASTS = 3
const MAX_SEEN_MESSAGES = 1000

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

export function messageToast(message: Message): string {
  return `Swarm2 message ${message.repo} · ${message.from}: ${oneLine(message.body, 160)}`
}

/**
 * seen: ids already shown, or null before the first successful load (which only records ids). Each message id toasts at most
 * once; more than MAX_MESSAGE_TOASTS new messages in one poll collapse into one summary toast.
 */
export function messageToasts(seen: ReadonlySet<number> | null, messages: Message[]): { toasts: string[]; seen: Set<number> } {
  const next = new Set(seen ?? [])
  const fresh = messages.filter(m => !next.has(m.id)).sort((a, b) => a.id - b.id)
  for (const m of fresh) next.add(m.id)
  // Sets keep insertion order: drop the oldest ids so a long session does not grow without bound.
  for (const id of next) {
    if (next.size <= MAX_SEEN_MESSAGES) break
    next.delete(id)
  }
  if (seen === null || !fresh.length) return { toasts: [], seen: next }
  if (fresh.length > MAX_MESSAGE_TOASTS) {
    const repos = [...new Set(fresh.map(m => m.repo))].join(', ')
    return { toasts: [`Swarm2: ${fresh.length} new project messages (${repos})`], seen: next }
  }
  return { toasts: fresh.map(messageToast), seen: next }
}

/** An account's alarm level: exhausted, invalid or degraded by health, `high` past 90% of any window, else ok. */
export function accountKey(account: Account): string {
  if (account.health === 'exhausted' || account.health === 'invalid' || account.health === 'degraded') return account.health
  const worst = Math.max(0, ...account.windows.map(w => w.used_pct ?? 0))
  return worst >= 90 ? 'high' : 'ok'
}

/** prevKey undefined (first seen) never toasts; a change into a non-ok level does. Invalid names the repair, not the failure. */
export function accountToastFor(prevKey: string | undefined, account: Account): string | null {
  const key = accountKey(account)
  if (prevKey === undefined || prevKey === key || key === 'ok') return null
  // Modern feeds send an owner-gated account_invalid attention item; that is the sole invalid toast.
  // Older feeds have no attention flag: only personal accounts may use this fallback.
  if (key === 'invalid') return account.attention === undefined && account.owner === 'you'
    ? `Swarm2: ${account.provider} (${account.owner}) is invalid` : null

  return key === 'high'
    ? `Swarm2: ${account.provider} (${account.owner}) is past 90% of its limit`
    : `Swarm2: ${account.provider} (${account.owner}) is ${key}`
}

// Blocked runs already toast through their terminal status and deploy approvals through the deployment's phase.
const ATTENTION_TOASTED_ELSEWHERE = new Set(['deploy_approval', 'run_blocked', 'blocked'])

export function attentionKey(item: Attention): string {
  return JSON.stringify([item.kind, item.id ?? item.text])
}

/** seen null before the first load (records only); each new item of a kind no other rule covers toasts once. */
export function attentionToasts(seen: ReadonlySet<string> | null, items: Attention[]): { toasts: string[]; seen: Set<string> } {
  // Remember identified invalid transitions across temporary disappearance (bounded account list or role changes).
  const retained = [...(seen ?? [])].filter(key => key.startsWith('["account_invalid",') || key.startsWith('["notice",'))
  const next = new Set([...retained, ...items.map(attentionKey)])
  for (const key of next) {
    if (next.size <= 1000) break
    next.delete(key)
  }
  if (seen === null) return { toasts: [], seen: next }
  const emitted = new Set(seen)
  const toasts = items.filter(n => {
    const key = attentionKey(n)
    if (emitted.has(key) || ATTENTION_TOASTED_ELSEWHERE.has(n.kind)) return false
    emitted.add(key)
    return true
  }).map(n => n.kind === 'notice' ? `Swarm2: ${n.text}` : `Swarm2 needs you: ${n.text}`)
  return { toasts, seen: next }
}
