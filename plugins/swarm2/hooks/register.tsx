import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { parseRouting, routingLine } from './routing'
import type { Account, Attention, Deployment, Feed, Message, ProjectRow, Run, UsageWindow } from '../types'
import {
  accountKey, accountToastFor, attentionToasts, visibleAttention, deploymentKey, deploymentPhase, deploymentToastFor, observationLabel, messageToasts, oneLine, runKey,
  TERMINAL, toastFor,
} from './toasts'

/** Keep equal to .claude-plugin/plugin.json `version` (a test checks it); shown in the pane's footer. */
export const PLUGIN_VERSION = '0.3.2'

/** PROD for the production host; custom servers show their configured host. */
export function environmentLabel(base: string): { name: string; host: string } {
  let host = base
  try { host = new URL(base).host } catch { /* shown as configured */ }
  if (host === 'swarm2-mcp.netconnect.ro') return { name: 'PROD', host }
  return { name: host, host }
}
const PANE = 'swarm2'
const TITLE = 'Swarm2'
const DEFAULT_BASE = 'https://swarm2-mcp.netconnect.ro'
const POLL_MS = 5000
const SPIN_MS = 120
const STALE_MS = 30_000
// an older server has no /me/control yet: try it again this often
const CONTROL_RETRY_MS = 5 * 60_000
const PHASES = ['queued', 'preparing', 'executing', 'verifying', 'pushing', 'publishing', 'merging', 'done']
const DEPLOY_DONE = new Set(['succeeded', 'failed', 'cancelled'])
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SHOWN_MESSAGES = 5

const EMPTY: Feed = {
  source: null, accounts: [], runs: [], others: [], attention: [], deployments: [], messages: [], capacity: null, pool: null,
  projects: null, error: null, checkedAt: null,
}
// 'feed-1' was the runs/deployments/messages feed of the earlier pane and 'feed-2' the control feed before pool and projects:
// a value stored under either is read as EMPTY.
const feed = atom({ plugin: 'swarm2', key: 'feed' } as const, EMPTY, { shape: 'feed-3' })
const frame = atom({ plugin: 'swarm2', key: 'frame' } as const, 0)

// The module's own memory of what it has shown; it starts over on reload, which only costs a missed toast.
const seenRuns = new Map<string, string>()
const seenDeployments = new Map<string, string>()
const seenAccounts = new Map<string, string>()
// null until the first successful load, which records what exists without toasting it.
let seenMessages: Set<number> | null = null
let seenAttention: Set<string> | null = null
// The legacy status fallback has no account attention; only a successful control load seeds this history.
let seenAccountAttention: Set<string> | null = null
let loaded = false
let lastMessages: Message[] = []
let spinner: { cancel: () => void } | null = null
let controlMissingAt = 0

function short(id: string): string {
  return id.slice(0, 8)
}

function phaseBar(phase: string, failed: boolean): string {
  if (failed) return '[ failed ]'
  if (phase === 'waiting_quota') return '[ paused ]'
  const i = Math.max(0, PHASES.indexOf(phase))
  const done = Math.round(((i + 1) / PHASES.length) * 8)
  return '[' + '#'.repeat(done) + '-'.repeat(8 - done) + ']'
}

function pctBar(pct: number, cells = 5): string {
  const full = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return '▓'.repeat(full) + '░'.repeat(cells - full)
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function clock(iso: string | null): string {
  if (!iso) return '?'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  const days = (d.getTime() - Date.now()) / 86_400_000
  if (days > 1) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] ?? '?'
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

function ago(iso: string | null): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.floor(s / 3600)}h${two(Math.round((s % 3600) / 60))}`
}

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function windowLabel(w: UsageWindow): string {
  if (w.name === '_quota') return 'quota cooldown'
  return w.name.replace(/^five_hour$|^5h$/, '5h').replace(/^seven_day$|^7d$/, '7d')
}

function accountColor(a: Account): string | undefined {
  if (a.health === 'exhausted' || a.health === 'invalid') return 'red'
  if (a.health === 'cooling' || a.health === 'degraded' || a.windows.some(w => (w.used_pct ?? 0) >= 80)) return 'yellow'
  if (a.health === 'ok') return 'green'
  return undefined
}

function isActive(r: Run): boolean {
  return !TERMINAL.has(r.status) && r.phase !== 'done'
}

function outcome(r: Run): string {
  if (r.merge_status === 'merged') return `merged${r.merge_sha ? ` ${short(r.merge_sha)}` : ''}`
  if (r.merge_status && r.merge_status !== 'pending') return `${r.status} · merge ${r.merge_status}`
  return r.status
}

// /me/runs/status, as every server version answers it
type StatusRun = {
  run_id: string; repo: string; status: string; status_reason: string | null; provider: string | null; attempt: number | null
  phase: string; updated_at: string; pr_url: string | null; merge_status?: string | null; merge_reason?: string | null
  merge_sha?: string | null; validation_tier?: string | null; quota_resume_at?: string | null
}
type StatusBody = { runs?: StatusRun[]; deployments?: Deployment[]; messages?: Message[] }

/** The basic feed mapped onto the pane's shape, for a server without /me/control. It carries no capabilities, so it raises no
 * approval items: a deployment awaiting approval is listed under DELIVERY only. */
function fromStatus(body: StatusBody): Pick<Feed, 'runs' | 'deployments' | 'attention'> {
  const runs: Run[] = (body.runs ?? []).map(r => ({
    run_id: r.run_id, repo: r.repo, requester: null, mine: true, goal: null, status: r.status, status_reason: r.status_reason,
    provider: r.provider, attempt: r.attempt, phase: r.phase, started_at: null, updated_at: r.updated_at, pr_url: r.pr_url,
    merge_status: r.merge_status ?? null, merge_reason: r.merge_reason ?? null, merge_sha: r.merge_sha ?? null,
    quota_resume_at: r.quota_resume_at ?? null, validation_tier: r.validation_tier ?? null, workers: [], tokens: null, cost_usd: null,
  }))
  const deployments = Array.isArray(body.deployments) ? body.deployments : []
  const attention: Attention[] = [
    ...runs.filter(r => r.status === 'waiting_quota')
      .map(r => ({ kind: 'run_quota', text: `${r.repo} ${short(r.run_id)}: waiting for quota; ${r.quota_resume_at ? `earliest retry ${r.quota_resume_at}` : 'automatic retry pending'}`, url: null })),
    ...runs.filter(r => r.status === 'blocked')
      .map(r => ({ kind: 'run_blocked', text: `${r.repo} ${short(r.run_id)}: ${r.status_reason ?? 'blocked'}`, url: null })),
  ]
  return { runs, deployments, attention }
}

/** The control feed's runs carry no merge reason or SHA: take them from the status feed's run of the same id. */
function withMergeDetail(runs: Run[], status: StatusBody | null): Run[] {
  const byId = new Map((status?.runs ?? []).map(r => [r.run_id, r]))
  return runs.map(r => {
    const s = byId.get(r.run_id)
    return { ...r, merge_reason: s?.merge_reason ?? r.merge_reason ?? null, merge_sha: s?.merge_sha ?? r.merge_sha ?? null, routing: parseRouting(r.routing) }
  })
}

type Answer = { status: number; body: unknown } | { status: 0; body: null; unreachable: true }

async function fetchJson($: EngineInterface, url: string, token: string): Promise<Answer> {
  try {
    const res = await $.http.fetch(url, { headers: { authorization: `Bearer ${token}` } })
    return { status: res.status, body: res.ok ? JSON.parse(res.text) : null }
  } catch {
    return { status: 0, body: null, unreachable: true }
  }
}

function toastChanges($: EngineInterface, f: Feed, messagesKnown: boolean): void {
  for (const r of f.runs) {
    const toast = toastFor(seenRuns.get(r.run_id), r)
    if (toast) $.ui.toast(toast)
    seenRuns.set(r.run_id, runKey(r))
  }
  for (const d of f.deployments) {
    const toast = deploymentToastFor(loaded ? (seenDeployments.get(d.deployment_id) ?? null) : undefined, d)
    if (toast) $.ui.toast(toast)
    seenDeployments.set(d.deployment_id, deploymentKey(d))
  }
  if (messagesKnown) {
    const result = messageToasts(seenMessages, f.messages)
    for (const toast of result.toasts) $.ui.toast(toast)
    seenMessages = result.seen
  }
  for (const a of f.accounts) {
    const toast = accountToastFor(seenAccounts.get(a.id), a)
    if (toast) $.ui.toast(toast)
    seenAccounts.set(a.id, accountKey(a))
  }
  const attention = attentionToasts(seenAttention, f.attention.filter(a => a.kind !== 'account_invalid'))
  for (const toast of attention.toasts) $.ui.toast(toast)
  seenAttention = attention.seen
  if (f.source === 'control') {
    const accounts = attentionToasts(seenAccountAttention, f.attention.filter(a => a.kind === 'account_invalid'))
    for (const toast of accounts.toasts) $.ui.toast(toast)
    seenAccountAttention = accounts.seen
  }
  loaded = true
}

function statusLine(f: Feed, env = ''): string | undefined {
  const waiting = f.runs.filter(r => r.status === 'waiting_quota').length
  const active = f.runs.filter(r => isActive(r) && r.status !== 'waiting_quota').length + f.others.reduce((n, o) => n + o.active_runs, 0)
  const deploying = f.deployments.filter(d => !DEPLOY_DONE.has(d.status) && deploymentPhase(d) !== 'awaiting_approval').length
  const tight = f.accounts
    .flatMap(a => a.windows.map(w => ({ a, w })))
    .filter(x => x.w.used_pct !== null)
    .sort((x, y) => (y.w.used_pct ?? 0) - (x.w.used_pct ?? 0))[0]
  const parts: string[] = []
  if (active) parts.push(`${active} running`)
  if (waiting) parts.push(`${waiting} waiting for quota`)
  if (deploying) parts.push(`${deploying} deploying`)
  if (f.attention.length) parts.push(`${f.attention.length} need you`)
  if (tight && active) parts.push(`${tight.a.provider} ${windowLabel(tight.w)} ${Math.round(tight.w.used_pct ?? 0)}%`)
  return parts.length ? `swarm2${env ? ` ${env}` : ''} · ${parts.join(' · ')}` : undefined
}

function anyActive(f: Feed): boolean {
  return f.runs.some(r => isActive(r) && r.status !== 'waiting_quota') || f.others.some(o => o.active_runs > 0) || f.accounts.some(a => a.in_use > 0)
    || f.deployments.some(d => !DEPLOY_DONE.has(d.status) && deploymentPhase(d) !== 'awaiting_approval')
}

function setSpinner($: EngineInterface, on: boolean): void {
  if (on && !spinner) spinner = $.clock.every(SPIN_MS, () => void update($, frame, n => (n + 1) % FRAMES.length)) ?? null
  if (!on && spinner) {
    spinner.cancel()
    spinner = null
  }
}

async function fail($: EngineInterface, error: string): Promise<void> {
  await update($, feed, f => ({ ...f, error, checkedAt: new Date().toISOString() }))
}

async function poll($: EngineInterface, configured: string, base: string): Promise<void> {
  // /config does not show secret fields, so the token is normally saved with /swarm2-token (the mod's local store)
  const token = configured || String((await $.store.get('statusToken')) ?? '')
  if (!token) {
    await update($, feed, f => ({ ...f, error: `No status token: run /swarm2-token s2s_… (create one at ${base}/me/status-tokens)` }))
    $.ui.status(undefined)
    setSpinner($, false)
    return
  }
  const askControl = Date.now() - controlMissingAt > CONTROL_RETRY_MS
  // The status feed is always read: it alone carries the project messages and each run's merge reason and SHA.
  const [control, status] = await Promise.all([
    askControl ? fetchJson($, `${base}/me/control`, token) : Promise.resolve(null),
    fetchJson($, `${base}/me/runs/status`, token),
  ])
  // before the control feed shipped the route is absent: 404, or 403 because a status token reaches only the feed paths
  if (control && (control.status === 404 || control.status === 403)) controlMissingAt = Date.now()
  const statusBody = status.status === 200 && status.body ? (status.body as StatusBody) : null
  const checkedAt = new Date().toISOString()
  let next: Feed
  if (control && control.status === 200 && control.body) {
    const body = control.body as Partial<Feed>
    next = {
      ...EMPTY, ...body, source: 'control', runs: withMergeDetail(body.runs ?? [], statusBody),
      attention: visibleAttention(body.attention ?? [], body.projects),
      messages: statusBody ? (Array.isArray(statusBody.messages) ? statusBody.messages : []) : lastMessages,
      error: null, checkedAt,
    }
  } else if (statusBody) {
    const controlFailed = control && control.status !== 404 && control.status !== 403
    next = {
      ...EMPTY, ...fromStatus(statusBody), messages: Array.isArray(statusBody.messages) ? statusBody.messages : [], source: 'status',
      error: controlFailed ? `Swarm2 control feed ${control.status ? `answered HTTP ${control.status}` : 'unreachable'}` : null,
      checkedAt,
    }
  } else {
    const failed = control && control.status !== 404 && control.status !== 403 ? control : status
    await fail($, failed.status ? `Swarm2 answered HTTP ${failed.status}` : 'Swarm2 unreachable')
    return
  }
  lastMessages = next.messages
  toastChanges($, next, statusBody !== null)
  await update($, feed, () => next)
  $.ui.status(statusLine(next, environmentLabel(base).name))
  setSpinner($, anyActive(next))
}

export const register: Register = (on, options) => {
  const token = typeof options.statusToken === 'string' ? options.statusToken.trim() : ''
  const base = String(options.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'swarm2', description: 'Show the Swarm2 control pane' })
    await $.command.register({ name: 'swarm2-token', description: 'Save the read-only Swarm2 status token (s2s_…), or "clear"' })
    void $.ui.open({ id: PANE, title: TITLE })
    void poll($, token, base)
    $.clock.every(POLL_MS, () => poll($, token, base))
    return next(e)
  })

  on('command.run', { command: 'swarm2-token' }, async ($, e) => {
    const value = e.args.trim()
    if (value === 'clear') {
      await $.store.delete('statusToken')
      await poll($, token, base)
      return { text: 'Swarm2 status token removed.' }
    }
    if (!/^s2s_[A-Za-z0-9_-]{16,}$/.test(value)) {
      return { text: `Usage: /swarm2-token s2s_… (create a read-only token at ${base}/me/status-tokens), or /swarm2-token clear` }
    }
    await $.store.set('statusToken', value)
    await poll($, token, base)
    return { text: 'Swarm2 status token saved; the Swarm2 pane now updates every 5 s.' }
  })

  on('command.run', { command: 'swarm2' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await poll($, token, base)
    return { text: 'Swarm2 pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const f = await read($, feed)
    const spin = FRAMES[(await read($, frame)) % FRAMES.length]
    const cols = e.props.bodyColumns
    const stale = f.checkedAt !== null && Date.now() - new Date(f.checkedAt).getTime() > STALE_MS
    const mine = f.runs.filter(isActive)
    const finished = f.runs.filter(r => !isActive(r)).slice(0, 5)
    const messages = (f.messages ?? []).slice(0, SHOWN_MESSAGES)

    const heading = (title: string, extra?: string) => (
      <Text weight="bold" color="cyan">
        {title}
        {extra ? <Text dimColor> {extra}</Text> : null}
      </Text>
    )

    // The feed marks pool entries with owner "pool · <contributor>"; everything else is the viewer's own.
    const isPool = (a: Account) => a.owner.startsWith('pool')
    const own = f.accounts.filter(a => !isPool(a))
    const pool = f.accounts.filter(isPool)
    const projects = f.projects
    const listed = new Set((projects ?? []).map(p => p.repo))

    const accountRow = (a: Account) => (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={accountColor(a)}>● </Text>
          <Text weight="semibold">{a.label ?? a.provider}</Text>
          {isPool(a) && <Text dimColor> ({a.owner.replace(/^pool · /, '')})</Text>}
          {a.in_use > 0 && (
            <Text color="magenta"> {spin} ⚙×{a.engine_workers || a.in_use}</Text>
          )}
        </Text>
        <Text wrap="truncate-end">
          {'  '}
          {a.windows.length === 0 && <Text dimColor>no usage figure yet</Text>}
          {a.windows.map(w => (
            <Text color={(w.used_pct ?? 0) >= 90 ? 'red' : (w.used_pct ?? 0) >= 80 ? 'yellow' : undefined}>
              {windowLabel(w)} {w.name === '_quota' ? '' : w.used_pct === null ? '?' : `${pctBar(w.used_pct)} ${Math.round(w.used_pct)}%`}
              {w.resets_at ? (w.name === '_quota' ? `until ${w.resets_at}` : ` ↻${clock(w.resets_at)}`) : ''}{'  '}
            </Text>
          ))}
          {a.health !== 'ok' && a.health !== 'unknown' && <Text color="red">{a.health} </Text>}
          {a.observed_at && <Text dimColor>seen {ago(a.observed_at)} ago</Text>}
        </Text>
        {(a.health === 'invalid' || a.health === 'degraded' || a.health === 'exhausted' || a.health === 'cooling') && (a.last_error || a.health_since) && (
          <Text wrap="truncate-end" color={a.health === 'invalid' ? 'red' : 'yellow'}>
            {'  ↯ '}{a.last_error ?? a.health}{a.health_since ? ` since ${ago(a.health_since)}` : ''}
            {a.attention ? ' — replace the credential to repair' : ''}
          </Text>
        )}
        {a.users.length > 0 && (
          <Text dimColor wrap="truncate-end">  used by {a.users.map(u => `${u.name}×${u.count}`).join(', ')}</Text>
        )}
      </Box>
    )

    /** One active run under its repo: who started it, the phase bar, then its workers. */
    const runDetail = (r: Run, indent: string) => (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {indent}<Text color="magenta">{r.status === 'waiting_quota' ? '⏸' : spin}</Text> {r.mine ? 'you' : (r.requester ?? 'someone')} · {phaseBar(r.phase, false)} {r.phase === 'waiting_quota' ? 'waiting for quota' : r.phase}
          <Text dimColor>
            {' '}{short(r.run_id)}
            {r.started_at ? ` · ${ago(r.started_at)}` : ''}
            {r.provider ? ` · ${r.provider}` : ''}
            {r.attempt && r.attempt > 1 ? ` #${r.attempt}` : ''}
            {r.validation_tier ? ` · tests ${r.validation_tier}` : ''}
            {r.cost_usd !== null ? ` · ${money(r.cost_usd)}` : ''}
          </Text>
        </Text>
        {r.status === 'waiting_quota' && <Text color="yellow" wrap="truncate-end">{indent}  {r.quota_resume_at ? `Earliest automatic retry ${r.quota_resume_at}` : 'Automatic retry pending'}</Text>}
        {r.routing && <Text dimColor wrap="truncate-end">{indent}  ⇢ {routingLine(r.routing)}</Text>}
        {r.goal && <Text dimColor wrap="truncate-end">{indent}  “{r.goal}”</Text>}
        {r.workers.map(w => (
          <Text dimColor wrap="truncate-end">
            {indent}  {w.model ?? w.vendor} ▸ {w.last_action ?? 'starting'}
          </Text>
        ))}
        {r.status_reason && <Text color="yellow" wrap="truncate-end">{indent}  {r.status_reason}</Text>}
        {r.pr_url && <Text dimColor wrap="truncate-end">{indent}  {r.pr_url}</Text>}
      </Box>
    )

    /** A run on a repo the project list does not name (or every run, from an older server): the repo heads it. */
    const runBlock = (r: Run) => (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="magenta">{spin} </Text>
          <Text weight="semibold">{r.repo}</Text>
        </Text>
        {runDetail(r, '  ')}
      </Box>
    )

    const repoBlock = (p: ProjectRow) => (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={p.active_runs > 0 ? 'magenta' : undefined} dimColor={p.active_runs === 0}>{p.active_runs > 0 ? spin : '·'} </Text>
          <Text weight="semibold">{p.repo}</Text>
          <Text dimColor> {p.role} · {p.active_runs > 0 ? `${p.active_runs} running` : 'idle'}</Text>
        </Text>
        {(p.members.length > 0 || p.more_members > 0 || (p.pending_invites ?? 0) > 0) && (
          <Text wrap="truncate-end">
            {'    '}
            {p.members.map((m, i) => (
              <Text>
                {i > 0 ? <Text dimColor> · </Text> : null}
                {m.active_runs > 0 && <Text color="magenta">{spin} </Text>}
                <Text color={m.active_runs > 0 ? 'magenta' : undefined}>{m.name}</Text>
                {m.you && <Text weight="bold"> (you)</Text>}
                <Text dimColor> {m.role}{m.branch_scope && m.branch_scope.length > 0 ? ` (${m.branch_scope.join(',')})` : ''}{m.active_runs > 1 ? ` ×${m.active_runs}` : ''}</Text>
              </Text>
            ))}
            {p.more_members > 0 && <Text dimColor>{p.members.length > 0 ? ' · ' : ''}+{p.more_members} more</Text>}
            {(p.pending_invites ?? 0) > 0 && <Text dimColor> · {p.pending_invites} invite{p.pending_invites === 1 ? '' : 's'} pending</Text>}
          </Text>
        )}
        {mine.filter(r => r.repo === p.repo).map(r => runDetail(r, '    '))}
      </Box>
    )

    const waitingCount = mine.filter(r => r.status === 'waiting_quota').length
    const executingCount = mine.length - waitingCount
    const runCounts = [executingCount ? `${executingCount} running` : '', waitingCount ? `${waitingCount} waiting for quota` : ''].filter(Boolean).join(' · ')
    const reposExtra = projects
      ? `${projects.length} repo${projects.length === 1 ? '' : 's'}${runCounts ? ` · ${runCounts}` : ''}`
      : (runCounts || 'idle')

    const env = environmentLabel(base)
    return (
      <Box flexDirection="column" width={cols}>
        <Text wrap="truncate-end">
          <Text weight="bold" color={env.name === 'PROD' ? undefined : env.name === 'DEV' ? 'green' : 'yellow'}>● {env.name}</Text>
          <Text dimColor> {env.host} · plugin v{PLUGIN_VERSION}</Text>
        </Text>
        {f.error && <Text color="yellow" wrap="wrap">{f.error}</Text>}

        {heading('MY ACCOUNTS')}
        {own.length === 0 && (
          <Text dimColor wrap="wrap">{f.source === 'status' ? 'Usage data needs a Swarm2 server with the control feed.' : 'No accounts of yours.'}</Text>
        )}
        {own.map(accountRow)}

        {f.source === 'control' && <Text> </Text>}
        {f.source === 'control' && (
          <Text weight="bold" color="cyan">
            ORG POOL
            {f.pool && <Text color={f.pool.enabled ? 'green' : 'red'}> — {f.pool.enabled ? 'ON' : 'OFF'}</Text>}
            {pool.length > 0 && <Text dimColor> {pool.length} account{pool.length === 1 ? '' : 's'}</Text>}
          </Text>
        )}
        {f.source === 'control' && pool.length === 0 && (
          <Text dimColor wrap="wrap">
            {f.pool ? 'No accounts in the pool yet.' : 'No pool accounts: the organisation pool is off or empty.'}
          </Text>
        )}
        {f.source === 'control' && pool.map(accountRow)}

        {f.attention.length > 0 && <Text> </Text>}
        {f.attention.length > 0 && heading('NEEDS YOU')}
        {f.attention.map(n => (
          <Text color={n.kind === 'notice' ? 'yellow' : n.kind.endsWith('blocked') ? 'red' : 'yellow'} wrap="wrap">
            ! {n.text}{n.url ? ` ${n.url}` : ''}
          </Text>
        ))}

        <Text> </Text>
        {heading('MY REPOS', reposExtra)}
        {!projects && mine.length === 0 && finished.length === 0 && <Text dimColor>Nothing on your repos in the last 24 h.</Text>}
        {projects && projects.length === 0 && <Text dimColor>You are not a member of any project yet.</Text>}
        {(projects ?? []).map(repoBlock)}
        {mine.filter(r => !listed.has(r.repo)).map(runBlock)}
        {finished.map(r => (
          <Text wrap="truncate-end">
            <Text color={r.status === 'succeeded' ? 'green' : r.status === 'failed' ? 'red' : 'yellow'}>
              {r.status === 'succeeded' ? '✓' : r.status === 'failed' ? '✗' : '•'}{' '}
            </Text>
            {r.repo}
            <Text dimColor>
              {' '}{short(r.run_id)} {outcome(r)}
              {r.pr_url ? ` ${r.pr_url}` : ''}
            </Text>
          </Text>
        ))}

        {f.others.length > 0 && <Text> </Text>}
        {f.others.length > 0 && heading('OTHERS')}
        {f.others.map(o => (
          <Text wrap="truncate-end">
            {o.name} <Text color="magenta">{o.active_runs ? spin : '·'}</Text> {o.active_runs} run{o.active_runs === 1 ? '' : 's'}
            <Text dimColor>
              {Object.entries(o.models).map(([m, n]) => ` · ${m}×${n}`).join('')}
            </Text>
          </Text>
        ))}

        {f.deployments.length > 0 && <Text> </Text>}
        {f.deployments.length > 0 && heading('DELIVERY')}
        {f.deployments.slice(0, 6).map(d => (
          <Text wrap="truncate-end">
            <Text color={d.status === 'succeeded' ? 'green' : d.status === 'failed' ? 'red' : 'yellow'}>
              {d.status === 'succeeded' ? '✓' : d.status === 'failed' ? '✗' : DEPLOY_DONE.has(d.status) ? '•' : spin}{' '}
            </Text>
            {d.repo} → {d.target}
            <Text dimColor>
              {' '}{d.source === 'external' ? `external · ${observationLabel(d)}` : d.status === 'succeeded' ? clock(d.updated_at) : deploymentPhase(d)}
              {d.reason ? ` · ${oneLine(d.reason, 200)}` : ''}
              {d.pipeline_url && !DEPLOY_DONE.has(d.status) ? ` · ${d.pipeline_url}` : ''}
            </Text>
          </Text>
        ))}

        {messages.length > 0 && <Text> </Text>}
        {messages.length > 0 && heading('MESSAGES', f.messages.length > SHOWN_MESSAGES ? `${f.messages.length} in 24 h` : undefined)}
        {messages.map(m => (
          <Text wrap="truncate-end">
            <Text dimColor>{clock(m.created_at)} </Text>
            {m.from}
            <Text dimColor> {m.repo}</Text> {oneLine(m.body, 200)}
          </Text>
        ))}

        {f.capacity && <Text> </Text>}
        {f.capacity && heading('CAPACITY & COST')}
        {f.capacity && (
          <Text wrap="wrap">
            org {f.capacity.org_active}/{f.capacity.org_limit} running
            {f.capacity.queued ? ` · ${f.capacity.queued} queued` : ''}
            {f.capacity.pods !== null ? ` · ${f.capacity.pods} pods` : ''}
          </Text>
        )}
        {f.capacity && f.capacity.today.length > 0 && (
          <Text dimColor wrap="wrap">
            today: {f.capacity.today.map(t => `${t.name} ${money(t.cost_usd)}`).join(' · ')}
            {f.capacity.models.length ? ` · ${f.capacity.models.map(m => `${m.model} ${tokens(m.tokens)} tok`).join(' · ')}` : ''}
          </Text>
        )}

        <Text> </Text>
        <Text dimColor color={stale ? 'yellow' : undefined}>
          {f.checkedAt ? `${stale ? 'stale · ' : ''}updated ${clock(f.checkedAt)}` : 'connecting…'}
          {f.source === 'status' ? ' · basic feed' : ''}
          {` · plugin v${PLUGIN_VERSION}`}
        </Text>
      </Box>
    )
  })
}
