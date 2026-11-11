// The local-edit guard's I/O half: where a path's checkout is, whether that checkout is a Swarm2 project (a remote named in
// the cached project list, or .swarm2/project.yaml at its root), the /swarm2-local override and its audit log. Every
// detection error lets the call through (fail open); only a positive match blocks — except in a checkout that has
// .swarm2/project.yaml or whose remote names a plan_only project the viewer does not own: there the guard fails closed.
import type { EngineInterface, ToolCallResult } from 'claude-code'

import {
  aliasCandidates, appendAudit, BLOCK_MESSAGE, envAllowsLocal, GUARDED_TOOLS, freshMeta, freshProjects, isInside, normalizePath, normalizeRepos, normalizeRemoteWithHost, parentDir, parseRemotes, parseSshHostname,
  PLAN_ONLY_BLOCK_MESSAGE, PLAN_ONLY_UNKNOWN_BLOCK_MESSAGE, planOnlyRefuses, projectMeta, projectsFromResult, remotesMatch, toolWriteTargets,
} from './guard'
import type { LocalAuditEntry, ProjectMeta, ProjectsCache } from './guard'
import { postToSwarm2 } from './connection'
import { reportPluginState } from './plugin-report'

export const PROJECTS_KEY = 'guardProjects'
export const AUDIT_KEY = 'localEditsAudit'

// The session's /swarm2-local override lives in the session's state ({ plugin: 'swarm2', key: 'localEdits' }; register.tsx
// draws it through an atom of the same key): it survives a hot reload of the plugin and starts off in every new session.

// a checkout's verdict, for a minute: one git call per checkout and minute, not per Bash command
const VERDICT_MS = 60_000
// registered: a Swarm2 checkout; refuses: plan_only project and the viewer is not its owner (the override cannot lift it);
// unknown: .swarm2/project.yaml is present but no fresh project list identifies the project (no list, a stale one, no
// matching remote — a fork or a renamed repo —, or git failed) and the list does not rule plan_only out: the override is
// refused and does not lift the guard there (plan_only unknown, fail closed)
type Verdict = { registered: boolean; refuses: boolean; unknown: boolean; at: number }
const verdicts = new Map<string, Verdict>()
// the last list written to the store, so a poll every 5 s writes only on a change or once an hour
let lastWritten: { key: string; at: number } | null = null
const REWRITE_MS = 3_600_000
let home: string | null = null
let envOverride = false
// `ssh -G` answers per host alias: the hostname, or null when it could not be resolved
// (a failed lookup is remembered only for FAILED_LOOKUP_MS, a successful one for the session)
const hostnames = new Map<string, { hostname: string | null; at: number }>()
const FAILED_LOOKUP_MS = 60_000
// the `ssh -G` lookups still running, per alias: a lookup that outlives its deadline is not started again
const lookups = new Map<string, Promise<string | null>>()
let lookupDeadlineMs = 3000
let clock: () => number = () => Date.now()
/** For tests: the clock (verdict and lookup TTLs) and the total `ssh -G` deadline in ms; null restores the defaults. */
export function setGuardTiming(t: { now?: (() => number) | null; lookupDeadlineMs?: number | null } | null): void {
  clock = t?.now ?? (() => Date.now())
  lookupDeadlineMs = t?.lookupDeadlineMs ?? 3000
}

/** Where the guard's warnings go (stderr); a test swaps it. */
export type Warn = (message: string) => void
const defaultWarn: Warn = m => { try { process.stderr.write(`${m}\n`) } catch { /* no stderr */ } }
let warn: Warn = defaultWarn
export function setGuardWarn(fn: Warn | null): void { warn = fn ?? defaultWarn }

/** For tests: forget the module's memory (a reload does the same). */
export function resetGuardMemory(): void {
  verdicts.clear()
  lastWritten = null
  home = null
  envOverride = false
  hostnames.clear()
  lookups.clear()
  warn = defaultWarn
}

/** Saves the project list (from the control feed or swarm_projects) with the time it was seen. An entry is a repo string or a
 * feed project { repo, role, plan_only }; a plain string keeps what the cache already knew of that repo (role, plan_only). */
export async function rememberProjects($: EngineInterface, entries: readonly unknown[]): Promise<void> {
  const list = normalizeRepos(entries.map(e => (e !== null && typeof e === 'object' ? (e as { repo?: unknown }).repo : e))).sort()
  const fresh = projectMeta(entries)
  let prior: Record<string, ProjectMeta> = {}
  try { prior = freshMeta(await $.store.get(PROJECTS_KEY), Date.now()) } catch { /* nothing known */ }
  const meta: Record<string, ProjectMeta> = {}
  for (const r of list) { const m = fresh[r] ?? prior[r]; if (m) meta[r] = m }
  const key = list.map(r => `${r}|${meta[r]?.role ?? ''}|${meta[r]?.plan_only ? 1 : 0}`).join('\n')
  const now = Date.now()
  if (lastWritten && lastWritten.key === key && now - lastWritten.at < REWRITE_MS) return
  const value: ProjectsCache = { repos: list, at: now, meta }
  await $.store.set(PROJECTS_KEY, value)
  lastWritten = { key, at: now }
  verdicts.clear()
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try { return await $.fs.exists(path) } catch { return false }
}

/** The root of the git checkout holding `path` (its nearest existing ancestor, symlinks resolved), or null. */
export async function checkoutRoot($: EngineInterface, path: string): Promise<string | null> {
  let p = normalizePath(path)
  for (let n = 0; n < 128 && !(await exists($, p)); n++) {
    if (p === '/') return null
    p = parentDir(p)
  }
  let dir = p
  try {
    const st = await $.fs.stat(p, { resolve: true })
    const real = st.realPath ?? p
    dir = st.kind === 'dir' ? real : parentDir(real)
  } catch { /* walk the spelling as given */ }
  for (let n = 0; n < 128; n++) {
    if (await exists($, `${dir === '/' ? '' : dir}/.git`)) return dir
    if (dir === '/') return null
    dir = parentDir(dir)
  }
  return null
}

/** The hostname `ssh -G <host>` reports for an ssh alias; null when it cannot be told (error, timeout, non-zero exit,
 * no hostname line). A success is cached for the session, a failure for FAILED_LOOKUP_MS. */
async function resolveHostname($: EngineInterface, host: string): Promise<string | null> {
  const hit = hostnames.get(host)
  if (hit && (hit.hostname !== null || clock() - hit.at < FAILED_LOOKUP_MS)) return hit.hostname
  // a lookup still running (e.g. a hung ssh -G past its deadline) is joined, never doubled
  const running = lookups.get(host)
  if (running) return running
  const pending = (async () => {
    let hostname: string | null = null
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) {
      try {
        const out = await $.process.run(['ssh', '-G', host], { timeoutMs: lookupDeadlineMs })
        if (out.exitCode === 0) hostname = parseSshHostname(out.stdout)
      } catch { /* unresolved */ }
    }
    hostnames.set(host, { hostname, at: clock() })
    return hostname
  })()
  lookups.set(host, pending)
  try { return await pending } finally { if (lookups.get(host) === pending) lookups.delete(host) }
}

/** Resolves several aliases in parallel under ONE overall deadline; a lookup still pending at the deadline counts as
 * unresolved (null) and is remembered as failed unless it finishes later. */
async function resolveHostnames($: EngineInterface, hosts: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(hosts)]
  const out = new Map<string, string | null>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, lookupDeadlineMs) })
  try {
    await Promise.all(unique.map(async h => {
      const r = await Promise.race([
        resolveHostname($, h),
        deadline.then(() => {
          if (!hostnames.has(h)) hostnames.set(h, { hostname: null, at: clock() })
          return null
        }),
      ])
      out.set(h, r)
    }))
  } finally { clearTimeout(timer) }
  return out
}

/** What the guard knows of the checkout at `root`: a Swarm2 project (.swarm2/project.yaml at its root, or any git remote in
 * the cached project list), and whether a plan_only project in the cache refuses this viewer (not the owner). An ssh alias is
 * resolved with `ssh -G`; when that fails the remote's owner/repo path alone decides (fail closed). When no remote matches but
 * one looks like GitHub, warns once per verdict window. Git errors answer "not registered" (fail open) outside a checkout
 * with .swarm2/project.yaml; with the yaml, a project the list cannot identify is plan_only-unknown (see Verdict). */
async function checkoutVerdict($: EngineInterface, root: string): Promise<Verdict> {
  const cached = verdicts.get(root)
  if (cached && clock() - cached.at < VERDICT_MS) return cached
  const yaml = await exists($, `${root === '/' ? '' : root}/.swarm2/project.yaml`)
  let registered = yaml
  let refuses = false
  let identified = false
  let projects: string[] | null = null
  let meta: Record<string, ProjectMeta> = {}
  try {
    const stored = await $.store.get(PROJECTS_KEY)
    projects = freshProjects(stored, Date.now())
    meta = freshMeta(stored, Date.now())
  } catch { /* none cached */ }
  if (projects && projects.length) {
    try {
      const out = await $.process.run(['git', '-C', root, 'remote', '-v'], { timeoutMs: 3000 })
      if (out.exitCode === 0) {
        const repos = parseRemotes(out.stdout)
        const githubLike = [...repos]
        const candidates = aliasCandidates(out.stdout)
        const resolvedHosts = await resolveHostnames($, candidates.map(c => c.host))
        for (const c of candidates) {
          const resolved = resolvedHosts.get(c.host) ?? null
          if (resolved === null) { repos.push(c.path); githubLike.push(c.path) } // fail closed: it might be GitHub
          else {
            const r = normalizeRemoteWithHost(c.url, resolved)
            if (r) { repos.push(r); githubLike.push(r) }
          }
        }
        const matched = repos.map(r => r.toLowerCase()).filter(r => projects!.includes(r))
        const remoteMatch = remotesMatch(repos, projects)
        refuses = matched.some(r => planOnlyRefuses(meta[r]))
        identified = remoteMatch
        if (!registered && !remoteMatch && githubLike.length) {
          warn(`swarm2 guard: no Swarm2 project matches this checkout's remotes (${[...new Set(githubLike)].join(', ')}); local edits are allowed`)
        }
        registered = registered || remoteMatch
      }
    } catch { /* git unavailable: fail open unless the checkout has .swarm2/project.yaml (below) */ }
  }
  // A fresh list without any plan_only project that refuses this viewer rules plan_only out for every project the viewer
  // can reach, so an unidentified yaml checkout is only "unknown" while the list is missing, stale or names such a project.
  // A list entry without role/plan_only (learnt from swarm_projects alone, before the control feed) rules nothing out.
  const ruledOut = projects !== null && projects.every(r => meta[r] !== undefined) && !Object.values(meta).some(planOnlyRefuses)
  const unknown = yaml && !identified && !ruledOut
  const verdict: Verdict = { registered: registered || refuses, refuses, unknown, at: clock() }
  verdicts.set(root, verdict)
  return verdict
}

/** Whether the checkout at `root` is a Swarm2 project (see checkoutVerdict). */
export async function isSwarm2Checkout($: EngineInterface, root: string): Promise<boolean> {
  return (await checkoutVerdict($, root)).registered
}

async function sessionId($: EngineInterface): Promise<string> {
  try { return await $.session.id() } catch { return 'unknown' }
}

export async function isLocalOn($: EngineInterface): Promise<boolean> {
  if (envOverride) return true
  try { return (await $.state.get({ plugin: 'swarm2', key: 'localEdits' })).value === true } catch { return false }
}

export const GUARD_OVERRIDE_PATH = '/me/guard/override'

/** Why the session's working directory refuses the override: 'plan_only' (a plan_only project this viewer does not own),
 * 'unknown' (a .swarm2/project.yaml checkout whose plan_only cannot be ruled out, see Verdict), or null. A detection error
 * answers null (fail open). */
async function cwdRefuses($: EngineInterface): Promise<'plan_only' | 'unknown' | null> {
  try {
    const root = await checkoutRoot($, await $.session.cwd())
    if (!root) return null
    const v = await checkoutVerdict($, root)
    return v.refuses ? 'plan_only' : v.unknown ? 'unknown' : null
  } catch { return null }
}

/** The guard state the plugin reports to Swarm2: off while an override is in effect. Best-effort, in the background. */
export async function reportGuard($: EngineInterface): Promise<void> {
  try { void reportPluginState($, !(await isLocalOn($))) } catch { /* best-effort */ }
}

/** Sets this session's override, appends the local audit entry and reports it to Swarm2 (best-effort: a failed or slow
 * report never blocks the override). The hook is a safety net, not enforcement. Turning it ON in a plan_only project's
 * checkout is refused for everyone but the owner, and in a .swarm2/project.yaml checkout whose plan_only is unknown for
 * everyone until a fresh feed rules it out: nothing is set, the attempt is audited and reported with action 'refused'.
 * Returns 'applied', 'refused' (plan_only) or 'refused_unknown'. */
export async function setLocal(
  $: EngineInterface, value: 'on' | 'off', source: LocalAuditEntry['source'] = 'command',
): Promise<'applied' | 'refused' | 'refused_unknown'> {
  const why = value === 'on' ? await cwdRefuses($) : null
  const refused = why !== null
  if (!refused && source === 'command') await $.state.set({ plugin: 'swarm2', key: 'localEdits' }, value === 'on')
  const entry: LocalAuditEntry = { at: new Date().toISOString(), session: await sessionId($), value, source, action: refused ? 'refused' : 'applied' }
  try { await $.store.set(AUDIT_KEY, appendAudit(await $.store.get(AUDIT_KEY), entry)) } catch { /* the local log is secondary */ }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([postToSwarm2($, GUARD_OVERRIDE_PATH, entry), new Promise<boolean>(r => { timer = setTimeout(() => r(false), 4000) })])
  } catch { /* best-effort */ } finally { clearTimeout(timer) }
  if (!refused && source === 'command') await reportGuard($) // the guard state changed: report it now
  return why === 'plan_only' ? 'refused' : why === 'unknown' ? 'refused_unknown' : 'applied'
}

/** At session start: the home directory (for `~` in commands) and the SWARM2_LOCAL_EDITS opt-out of an automated
 * environment, which is audited like the command. */
export async function initGuard($: EngineInterface): Promise<void> {
  try {
    const out = await $.process.run(['sh', '-c', 'printf "%s\\n%s" "$HOME" "${SWARM2_LOCAL_EDITS:-}"'], { timeoutMs: 3000 })
    if (out.exitCode === 0) {
      const [h, env] = out.stdout.split('\n')
      home = h && h.startsWith('/') ? normalizePath(h) : null
      if (envAllowsLocal(env) && !envOverride) {
        // a plan_only project refuses the env override for non-owners; setLocal reports the refusal
        envOverride = (await setLocal($, 'on', 'env')) === 'applied'
      }
    }
  } catch { /* no process runner (a non-CLI surface): no ~ expansion, no env opt-out */ }
  await reportGuard($) // session start: tell Swarm2 which plugin runs and whether the guard is on
}

export function isEnvOverride(): boolean {
  return envOverride
}

/** planOnly: a target is in a plan_only project the viewer does not own; unknown: the override is on but a target is in a
 * .swarm2/project.yaml checkout whose plan_only cannot be ruled out. */
export type Blocked = { paths: string[]; planOnly: boolean; unknown: boolean }

/** The deny message for a non-empty Blocked. */
export function blockedMessage(b: Blocked): string {
  return b.planOnly ? PLAN_ONLY_BLOCK_MESSAGE : b.unknown ? PLAN_ONLY_UNKNOWN_BLOCK_MESSAGE : BLOCK_MESSAGE
}

/** The paths a call writes that land in a Swarm2 checkout; empty means let it run. The /swarm2-local override does not
 * apply to a plan_only project the viewer does not own (planOnly is then set), nor to a .swarm2/project.yaml checkout whose
 * plan_only is unknown (unknown is then set). */
export async function blockedTargets($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<Blocked> {
  const none: Blocked = { paths: [], planOnly: false, unknown: false }
  if (!GUARDED_TOOLS.has(tool)) return none
  const cwd = await $.session.cwd()
  const targets = toolWriteTargets(tool, input, { cwd, home })
  if (!targets.length) return none
  const on = await isLocalOn($)
  const roots = new Map<string, Verdict>()
  const hits: string[] = []
  let planOnly = false
  let unknown = false
  for (const t of targets) {
    const root = await checkoutRoot($, t)
    if (!root) continue
    if (!roots.has(root)) roots.set(root, await checkoutVerdict($, root))
    const v = roots.get(root)!
    if (!isInside(t, root)) continue
    if (v.refuses) { hits.push(t); planOnly = true } // an override never lifts plan_only
    else if (v.unknown && on) { hits.push(t); unknown = true } // nor a plan_only that cannot be ruled out
    else if (v.registered && !on) hits.push(t)
  }
  return { paths: hits, planOnly, unknown }
}

/** The lower-cased owner/repo paths `git remote -v` names, without any ssh alias lookup (an alias counts by its path alone,
 * as when its lookup fails); null when git fails. */
async function remotePaths($: EngineInterface, root: string): Promise<string[] | null> {
  try {
    const out = await $.process.run(['git', '-C', root, 'remote', '-v'], { timeoutMs: 3000 })
    if (out.exitCode !== 0) return null
    return [...parseRemotes(out.stdout), ...aliasCandidates(out.stdout).map(c => c.path)].map(r => r.toLowerCase())
  } catch { return null }
}

/** After an internal error: deny only inside a checkout that belongs to a Swarm2 project the guard must not guess about —
 * one with .swarm2/project.yaml (BLOCK_MESSAGE), or one whose remote names a cached plan_only project the viewer does not
 * own (PLAN_ONLY_BLOCK_MESSAGE). Anywhere else, including a checkout whose remotes cannot be read, the call runs (fail
 * open). Every step here is itself guarded. */
async function failClosed($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<string | null> {
  try {
    if (!GUARDED_TOOLS.has(tool)) return null
    const targets = toolWriteTargets(tool, input, { cwd: await $.session.cwd(), home })
    let refusing: string[] = []
    try {
      refusing = Object.entries(freshMeta(await $.store.get(PROJECTS_KEY), Date.now())).filter(([, m]) => planOnlyRefuses(m)).map(([r]) => r)
    } catch { /* unknown: only the yaml can tell */ }
    for (const t of targets) {
      const root = await checkoutRoot($, t)
      if (!root || !isInside(t, root)) continue
      if (await exists($, `${root === '/' ? '' : root}/.swarm2/project.yaml`)) return BLOCK_MESSAGE
      if (!refusing.length) continue
      const remotes = await remotePaths($, root)
      if (remotes && remotes.some(r => refusing.includes(r))) return PLAN_ONLY_BLOCK_MESSAGE
    }
  } catch { /* nothing more can be told */ }
  return null
}

const isProjectsTool = (tool: string) => /^mcp__.+__swarm_projects$/.test(tool)

/** The `tool.call` hook: learns the project list from swarm_projects, refuses writes into a Swarm2 checkout. MCP tools
 * (plans and decisions sent to Swarm2 included) are never refused. */
export async function guardToolCall(
  $: EngineInterface, tool: string, input: Record<string, unknown>, pass: () => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  void reportGuard($) // throttled to once per few minutes per session; never awaited
  if (isProjectsTool(tool)) {
    const answered = await pass()
    try {
      const repos = answered.isError ? null : (projectsFromResult(answered.result) ?? projectsFromResult(answered.text))
      if (repos) await rememberProjects($, repos)
    } catch { /* an unreadable answer teaches nothing */ }
    return answered
  }
  let blocked: Blocked
  try { blocked = await blockedTargets($, tool, input) } catch {
    // fail open, except in a checkout with .swarm2/project.yaml or one of a plan_only project the viewer does not own
    const denied = await failClosed($, tool, input)
    return denied ? { deny: denied } : pass()
  }
  return blocked.paths.length ? { deny: blockedMessage(blocked) } : pass()
}
