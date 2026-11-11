// The local-edit guard's I/O half: where a path's checkout is, whether that checkout is a Swarm2 project (a remote named in
// the cached project list, or .swarm2/project.yaml at its root), the /swarm2-local override and its audit log. Every
// detection error lets the call through (fail open); only a positive match blocks.
import type { EngineInterface, ToolCallResult } from 'claude-code'

import {
  aliasCandidates, appendAudit, BLOCK_MESSAGE, envAllowsLocal, GUARDED_TOOLS, freshProjects, isInside, normalizePath, normalizeRepos, normalizeRemoteWithHost, parentDir, parseRemotes, parseSshHostname,
  projectsFromResult, remotesMatch, toolWriteTargets,
} from './guard'
import type { LocalAuditEntry, ProjectsCache } from './guard'

export const PROJECTS_KEY = 'guardProjects'
export const AUDIT_KEY = 'localEditsAudit'

// The session's /swarm2-local override lives in the session's state ({ plugin: 'swarm2', key: 'localEdits' }; register.tsx
// draws it through an atom of the same key): it survives a hot reload of the plugin and starts off in every new session.

// a checkout's verdict, for a minute: one git call per checkout and minute, not per Bash command
const VERDICT_MS = 60_000
const verdicts = new Map<string, { registered: boolean; at: number }>()
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

/** Saves the project list (from the control feed or swarm_projects) with the time it was seen. */
export async function rememberProjects($: EngineInterface, repos: readonly unknown[]): Promise<void> {
  const list = normalizeRepos(repos).sort()
  const key = list.join('\n')
  const now = Date.now()
  if (lastWritten && lastWritten.key === key && now - lastWritten.at < REWRITE_MS) return
  const value: ProjectsCache = { repos: list, at: now }
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

/** Whether the checkout at `root` is a Swarm2 project: .swarm2/project.yaml at its root, or any git remote in the cached
 * project list. An ssh alias is resolved with `ssh -G`; when that fails the remote's owner/repo path alone decides (fail
 * closed). When no remote matches but one looks like GitHub, warns once per verdict window. Git errors answer false. */
export async function isSwarm2Checkout($: EngineInterface, root: string): Promise<boolean> {
  const cached = verdicts.get(root)
  if (cached && clock() - cached.at < VERDICT_MS) return cached.registered
  let registered = await exists($, `${root === '/' ? '' : root}/.swarm2/project.yaml`)
  if (!registered) {
    let projects: string[] | null = null
    try { projects = freshProjects(await $.store.get(PROJECTS_KEY), Date.now()) } catch { /* none cached */ }
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
          registered = remotesMatch(repos, projects)
          if (!registered && githubLike.length) {
            warn(`swarm2 guard: no Swarm2 project matches this checkout's remotes (${[...new Set(githubLike)].join(', ')}); local edits are allowed`)
          }
        }
      } catch { /* git unavailable: fail open */ }
    }
  }
  verdicts.set(root, { registered, at: clock() })
  return registered
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

/** Sets this session's override, appends the local audit entry and reports it to Swarm2 (best-effort: a failed or slow
 * report never blocks the override). The hook is a safety net, not enforcement. */
export async function setLocal($: EngineInterface, value: 'on' | 'off', source: LocalAuditEntry['source'] = 'command'): Promise<void> {
  if (source === 'command') await $.state.set({ plugin: 'swarm2', key: 'localEdits' }, value === 'on')
  const entry: LocalAuditEntry = { at: new Date().toISOString(), session: await sessionId($), value, source }
  try { await $.store.set(AUDIT_KEY, appendAudit(await $.store.get(AUDIT_KEY), entry)) } catch { /* the local log is secondary */ }
  if (reporter) {
    try { await Promise.race([reporter($, entry), new Promise<void>(r => setTimeout(r, 4000))]) } catch { /* best-effort */ }
  }
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
        envOverride = true
        await setLocal($, 'on', 'env')
      }
    }
  } catch { /* no process runner (a non-CLI surface): no ~ expansion, no env opt-out */ }
}

export function isEnvOverride(): boolean {
  return envOverride
}

/** The paths a call writes that land in a Swarm2 checkout; empty means let it run. */
export async function blockedTargets($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<string[]> {
  if (!GUARDED_TOOLS.has(tool)) return []
  const cwd = await $.session.cwd()
  const targets = toolWriteTargets(tool, input, { cwd, home })
  if (!targets.length) return []
  if (await isLocalOn($)) return []
  const roots = new Map<string, boolean>()
  const hits: string[] = []
  for (const t of targets) {
    const root = await checkoutRoot($, t)
    if (!root) continue
    if (!roots.has(root)) roots.set(root, await isSwarm2Checkout($, root))
    if (roots.get(root) && isInside(t, root)) hits.push(t)
  }
  return hits
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
  let hits: string[] = []
  try { hits = await blockedTargets($, tool, input) } catch { hits = [] } // fail open
  return hits.length ? { deny: BLOCK_MESSAGE } : pass()
}
