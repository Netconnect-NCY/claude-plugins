// The local-edit guard's I/O half: where a path's checkout is, whether that checkout is a Swarm2 project (a remote named in
// the cached project list, or .swarm2/project.yaml at its root), the /swarm2-local override and its audit log. Every
// detection error lets the call through (fail open); only a positive match blocks.
import type { EngineInterface, ToolCallResult } from 'claude-code'

import {
  aliasCandidates, appendAudit, BLOCK_MESSAGE, envAllowsLocal, GUARDED_TOOLS, freshMeta, freshProjects, isInside, normalizePath, normalizeRepos, normalizeRemoteWithHost, parentDir, parseRemotes, parseSshHostname,
  PLAN_ONLY_BLOCK_MESSAGE, planOnlyRefuses, projectMeta, projectsFromResult, remotesMatch, toolWriteTargets,
} from './guard'
import type { LocalAuditEntry, ProjectMeta, ProjectsCache } from './guard'

export const PROJECTS_KEY = 'guardProjects'
export const AUDIT_KEY = 'localEditsAudit'

// The session's /swarm2-local override lives in the session's state ({ plugin: 'swarm2', key: 'localEdits' }; register.tsx
// draws it through an atom of the same key): it survives a hot reload of the plugin and starts off in every new session.

// a checkout's verdict, for a minute: one git call per checkout and minute, not per Bash command
const VERDICT_MS = 60_000
// registered: a Swarm2 checkout; refuses: plan_only project and the viewer is not its owner (the override cannot lift it);
// unknown: the remotes could not be read although the cache lists a project that would refuse (fail closed)
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
 * one looks like GitHub, warns once per verdict window. Git errors answer "not registered" (fail open) — except when the
 * cache lists a project that would refuse this viewer: then `unknown` is set and the caller denies. */
async function checkoutVerdict($: EngineInterface, root: string): Promise<Verdict> {
  const cached = verdicts.get(root)
  if (cached && clock() - cached.at < VERDICT_MS) return cached
  let registered = await exists($, `${root === '/' ? '' : root}/.swarm2/project.yaml`)
  let refuses = false
  let unknown = false
  let projects: string[] | null = null
  let meta: Record<string, ProjectMeta> = {}
  try {
    const stored = await $.store.get(PROJECTS_KEY)
    projects = freshProjects(stored, Date.now())
    meta = freshMeta(stored, Date.now())
  } catch { /* none cached */ }
  if (projects && projects.length) {
    const wouldRefuse = Object.values(meta).some(planOnlyRefuses)
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
        if (!registered && !remoteMatch && githubLike.length) {
          warn(`swarm2 guard: no Swarm2 project matches this checkout's remotes (${[...new Set(githubLike)].join(', ')}); local edits are allowed`)
        }
        registered = registered || remoteMatch
      } else unknown = wouldRefuse
    } catch { unknown = wouldRefuse } // git unavailable: fail open unless a plan-only project could be this one
  }
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

/** Reports an override to Swarm2 (set by register.tsx, which knows the base URL and token). Best-effort: it never blocks. */
export type OverrideReporter = ($: EngineInterface, entry: LocalAuditEntry) => Promise<void>
let reporter: OverrideReporter | null = null
export function setOverrideReporter(fn: OverrideReporter | null): void { reporter = fn }

/** Whether the checkout of the session's working directory is a plan_only project that refuses this viewer. Detection errors
 * count as "refused" only when the checkout is known (yaml or a cached plan_only project could not be ruled out). */
async function cwdRefuses($: EngineInterface): Promise<boolean> {
  try {
    const root = await checkoutRoot($, await $.session.cwd())
    if (!root) return false
    const v = await checkoutVerdict($, root)
    return v.refuses || v.unknown
  } catch { return false }
}

/** Sets this session's override, appends the local audit entry and reports it to Swarm2 (best-effort: a failed or slow
 * report never blocks the override). The hook is a safety net, not enforcement. Turning it ON in a plan_only project's
 * checkout is refused for everyone but the owner: nothing is set, the attempt is audited and reported with action 'refused'.
 * Returns 'refused' or 'applied'. */
export async function setLocal($: EngineInterface, value: 'on' | 'off', source: LocalAuditEntry['source'] = 'command'): Promise<'applied' | 'refused'> {
  const refused = value === 'on' && await cwdRefuses($)
  if (!refused && source === 'command') await $.state.set({ plugin: 'swarm2', key: 'localEdits' }, value === 'on')
  const entry: LocalAuditEntry = { at: new Date().toISOString(), session: await sessionId($), value, source, action: refused ? 'refused' : 'applied' }
  try { await $.store.set(AUDIT_KEY, appendAudit(await $.store.get(AUDIT_KEY), entry)) } catch { /* the local log is secondary */ }
  if (reporter) {
    try { await Promise.race([reporter($, entry), new Promise<void>(r => setTimeout(r, 4000))]) } catch { /* best-effort */ }
  }
  return refused ? 'refused' : 'applied'
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
}

export function isEnvOverride(): boolean {
  return envOverride
}

export type Blocked = { paths: string[]; planOnly: boolean }

/** The paths a call writes that land in a Swarm2 checkout; empty means let it run. The /swarm2-local override does not
 * apply to a plan_only project the viewer does not own (planOnly is then set). */
export async function blockedTargets($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<Blocked> {
  const none: Blocked = { paths: [], planOnly: false }
  if (!GUARDED_TOOLS.has(tool)) return none
  const cwd = await $.session.cwd()
  const targets = toolWriteTargets(tool, input, { cwd, home })
  if (!targets.length) return none
  const on = await isLocalOn($)
  const roots = new Map<string, Verdict>()
  const hits: string[] = []
  let planOnly = false
  for (const t of targets) {
    const root = await checkoutRoot($, t)
    if (!root) continue
    if (!roots.has(root)) roots.set(root, await checkoutVerdict($, root))
    const v = roots.get(root)!
    if (!isInside(t, root)) continue
    if (v.refuses || v.unknown) { hits.push(t); planOnly = true } // an override never lifts plan_only
    else if (v.registered && !on) hits.push(t)
  }
  return { paths: hits, planOnly }
}

/** After an internal error: deny when a target's checkout has .swarm2/project.yaml or the cache names a plan_only project
 * the viewer does not own (fail closed); otherwise let the call run as before. Every step here is itself guarded. */
async function failClosed($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<string | null> {
  try {
    if (!GUARDED_TOOLS.has(tool)) return null
    const targets = toolWriteTargets(tool, input, { cwd: await $.session.cwd(), home })
    let planOnlyKnown = false
    try { planOnlyKnown = Object.values(freshMeta(await $.store.get(PROJECTS_KEY), Date.now())).some(planOnlyRefuses) } catch { /* unknown */ }
    for (const t of targets) {
      const root = await checkoutRoot($, t)
      if (!root) continue
      if (await exists($, `${root === '/' ? '' : root}/.swarm2/project.yaml`)) return BLOCK_MESSAGE
      if (planOnlyKnown) return PLAN_ONLY_BLOCK_MESSAGE
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
  return blocked.paths.length ? { deny: blocked.planOnly ? PLAN_ONLY_BLOCK_MESSAGE : BLOCK_MESSAGE } : pass()
}
