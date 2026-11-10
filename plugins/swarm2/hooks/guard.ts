// The local-edit guard's pure half: which paths a tool call would write, how a git remote names a repository, and whether
// a checkout is a Swarm2 project. No I/O here; hooks/guard-hook.ts asks the file system, git and the plugin store.
//
// Owner decision (2026-11-10): code for Swarm2 projects is written only by Swarm2 on the server. Plan locally →
// swarm_plan_propose; implement only via Swarm2 runs (swarm_task_submit); review and steer.

export const BLOCK_MESSAGE = 'This repo is worked on through Swarm2 — submit a job (swarm_task_submit) or send a plan (swarm_plan_propose) instead'

/** How long the cached project list (from the control feed or a swarm_projects call) counts; older, remotes match nothing. */
export const PROJECTS_TTL_MS = 7 * 24 * 3_600_000

export type ProjectsCache = { repos: string[]; at: number }

/** One /swarm2-local change, appended to the plugin store and never edited. */
export type LocalAuditEntry = { at: string; session: string; value: 'on' | 'off'; source: 'command' | 'env' }

// ---------------------------------------------------------------------------------------------------------------------
// Remotes and projects

/** `owner/repo`, lower-cased, from any github.com git remote URL spelling (ssh scp-like, ssh://, https with credentials,
 * git://, trailing `.git` or `/`); null for something that names no GitHub repository (another host, a local path, an
 * empty line). */
export function normalizeRemote(url: string): string | null {
  let s = url.trim()
  if (!s) return null
  let path: string
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s)
  if (scheme) {
    if (/^file:/i.test(s)) return null
    s = s.slice(scheme[0].length)
    const slash = s.indexOf('/')
    if (slash < 0) return null
    const host = s.slice(0, slash).replace(/^[^@]*@/, '').replace(/:\d*$/, '')
    if (host.toLowerCase() !== 'github.com') return null
    path = s.slice(slash + 1)
  } else {
    // scp-like user@host:owner/repo; a bare local path has no colon before its first slash
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(s)
    if (!m || m[1]!.toLowerCase() !== 'github.com') return null // another host, or a Windows drive letter
    path = m[2]!
  }
  const parts = path.split(/[?#]/)[0]!.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[parts.length - 2]!
  const repo = parts[parts.length - 1]!
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null
  return `${owner}/${repo}`.toLowerCase()
}

/** The distinct GitHub repositories the `origin` remote of `git remote -v` names (upstream and fork remotes do not count). */
export function parseRemotes(output: string): string[] {
  const out = new Set<string>()
  for (const line of output.split('\n')) {
    const [name, url] = line.trim().split(/\s+/)
    if (name !== 'origin') continue
    const repo = url ? normalizeRemote(url) : null
    if (repo) out.add(repo)
  }
  return [...out]
}

/** Lower-cased `owner/name` of each project, as the feed or swarm_projects spells it. */
export function normalizeRepos(repos: readonly unknown[]): string[] {
  return [...new Set(repos.flatMap(r => (typeof r === 'string' && /^[^/\s]+\/[^/\s]+$/.test(r.trim()) ? [r.trim().toLowerCase()] : [])))]
}

/** The cached list when it is well-formed and younger than the TTL, else null (remotes then match nothing). */
export function freshProjects(value: unknown, now: number): string[] | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Partial<ProjectsCache>
  if (!Array.isArray(v.repos) || typeof v.at !== 'number' || now - v.at > PROJECTS_TTL_MS || v.at - now > 60_000) return null
  return normalizeRepos(v.repos)
}

export function remotesMatch(remotes: readonly string[], projects: readonly string[]): boolean {
  const set = new Set(projects.map(p => p.toLowerCase()))
  return remotes.some(r => set.has(r.toLowerCase()))
}

/** The repos of a swarm_projects result: its structured content or its JSON text (`{ projects: [{ repo }] }`). */
export function projectsFromResult(value: unknown): string[] | null {
  const tryParse = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { return null }
  }
  const pick = (v: unknown): string[] | null => {
    const o = tryParse(v)
    if (o === null || typeof o !== 'object') return null
    if (Array.isArray(o)) {
      for (const item of o) {
        const found = pick(item && typeof item === 'object' && 'text' in item ? (item as { text: unknown }).text : item)
        if (found) return found
      }
      return null
    }
    const rec = o as Record<string, unknown>
    if (Array.isArray(rec.projects)) {
      return normalizeRepos(rec.projects.map(p => (p && typeof p === 'object' ? (p as Record<string, unknown>).repo : null)))
    }
    for (const key of ['structuredContent', 'content', 'result', 'text']) {
      if (key in rec) {
        const found = pick(rec[key])
        if (found) return found
      }
    }
    return null
  }
  return pick(value)
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths

export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export function parentDir(path: string): string {
  const p = normalizePath(path)
  const cut = p.lastIndexOf('/')
  return cut <= 0 ? '/' : p.slice(0, cut)
}

export function isInside(path: string, root: string): boolean {
  const p = normalizePath(path)
  const r = normalizePath(root)
  return r === '/' || p === r || p.startsWith(r + '/')
}

export type PathContext = { cwd: string; home: string | null }

/** An absolute path for a word, or null when it depends on something unknown (an unset variable, a command's output). */
export function resolvePath(word: string, ctx: PathContext): string | null {
  let w = word
  if (w === '~' || w.startsWith('~/')) {
    if (!ctx.home) return null
    w = ctx.home + w.slice(1)
  }
  w = w.replace(/\$\{?(HOME|PWD|TMPDIR)\}?(?![A-Za-z0-9_])/g, (_, name: string) =>
    name === 'HOME' ? (ctx.home ?? '\u0000') : name === 'PWD' ? ctx.cwd : '/tmp')
  if (w.includes('\u0000') || /[$`]/.test(w) || /^~/.test(w)) return null
  return normalizePath(w.startsWith('/') ? w : `${ctx.cwd}/${w}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Shell

type Word = { kind: 'word'; value: string; dynamic: boolean }
type Op = { kind: 'op'; value: string }
type Redirect = { kind: 'redirect'; op: string; target: Word | null }
type Token = Word | Op | Redirect

type Lexed = { tokens: Token[]; nested: string[] }

/** The index just past the `)` that closes the `(` at `open`, quotes respected; s.length when unbalanced. */
function closeParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? s.length : j; continue }
    if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
  }
  return s.length
}

/** A small POSIX-ish lexer: quotes, escapes, operators, redirections, heredoc bodies skipped, and the text of every
 * command or process substitution collected in `nested` to be classified on its own. */
function lex(s: string): Lexed {
  const tokens: Token[] = []
  const nested: string[] = []
  const heredocs: { delim: string; strip: boolean }[] = []
  let i = 0
  let pendingRedirect: string | null = null
  let pendingHeredoc: boolean | null = null

  const pushWord = (w: Word) => {
    if (pendingHeredoc !== null) {
      heredocs.push({ delim: w.value, strip: pendingHeredoc })
      pendingHeredoc = null
      return
    }
    if (pendingRedirect !== null) {
      tokens.push({ kind: 'redirect', op: pendingRedirect, target: w })
      pendingRedirect = null
      return
    }
    tokens.push(w)
  }
  const pushOp = (value: string) => {
    if (pendingRedirect !== null) { tokens.push({ kind: 'redirect', op: pendingRedirect, target: null }); pendingRedirect = null }
    pendingHeredoc = null
    tokens.push({ kind: 'op', value })
  }

  while (i < s.length) {
    const c = s[i]!
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '\n') {
      pushOp(';')
      i++
      // heredoc bodies follow the line that opened them
      for (const h of heredocs.splice(0)) {
        while (i < s.length) {
          const end = s.indexOf('\n', i)
          const line = s.slice(i, end < 0 ? s.length : end)
          i = end < 0 ? s.length : end + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
        }
      }
      continue
    }
    // process substitution <( … ) / >( … ): its command is classified on its own; here it is one unknown word
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      const end = closeParen(s, i + 1)
      nested.push(s.slice(i + 2, end - 1))
      pushWord({ kind: 'word', value: '', dynamic: true })
      i = end
      continue
    }
    const rest = s.slice(i)
    const redir = /^(?:\d+|&)?(?:>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/.exec(rest)
    if (redir) {
      const op = redir[0]
      i += op.length
      if (pendingRedirect !== null) { tokens.push({ kind: 'redirect', op: pendingRedirect, target: null }); pendingRedirect = null }
      if (op.endsWith('<<') || op.endsWith('<<-')) pendingHeredoc = op.endsWith('-')
      else pendingRedirect = op
      continue
    }
    const op = /^(?:&&|\|\||;;|\|&|[;&|(){}])/.exec(rest)
    // braces only as words of their own; elsewhere they are part of a word ({a,b}, ${x})
    if (op && !((op[0] === '{' || op[0] === '}') && s[i + 1] !== undefined && !/[\s;]/.test(s[i + 1]!))) {
      pushOp(op[0])
      i += op[0].length
      continue
    }
    // a word
    let value = ''
    let dynamic = false
    while (i < s.length) {
      const ch = s[i]!
      if (/[\s;&|()<>]/.test(ch)) {
        // a > or < inside a word ends it, except as part of $( or a quoted run
        break
      }
      if (ch === '\\') { value += s[i + 1] ?? ''; i += 2; continue }
      if (ch === "'") {
        const j = s.indexOf("'", i + 1)
        value += s.slice(i + 1, j < 0 ? s.length : j)
        i = j < 0 ? s.length : j + 1
        continue
      }
      if (ch === '"') {
        i++
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && /["\\$`\n]/.test(s[i + 1] ?? '')) { value += s[i + 1]; i += 2; continue }
          if (s[i] === '$' && s[i + 1] === '(') {
            const end = closeParen(s, i + 1)
            nested.push(s.slice(i + 2, end - 1))
            value += '$()'
            dynamic = true
            i = end
            continue
          }
          if (s[i] === '`') {
            const j = s.indexOf('`', i + 1)
            nested.push(s.slice(i + 1, j < 0 ? s.length : j))
            value += '$()'
            dynamic = true
            i = j < 0 ? s.length : j + 1
            continue
          }
          if (s[i] === '$') dynamic = true
          value += s[i]
          i++
        }
        i++
        continue
      }
      if (ch === '$' && s[i + 1] === '(') {
        const end = closeParen(s, i + 1)
        nested.push(s.slice(i + 2, end - 1))
        value += '$()'
        dynamic = true
        i = end
        continue
      }
      if (ch === '`') {
        const j = s.indexOf('`', i + 1)
        nested.push(s.slice(i + 1, j < 0 ? s.length : j))
        value += '$()'
        dynamic = true
        i = j < 0 ? s.length : j + 1
        continue
      }
      if (ch === '$') dynamic = true
      value += ch
      i++
    }
    pushWord({ kind: 'word', value, dynamic })
  }
  if (pendingRedirect !== null) tokens.push({ kind: 'redirect', op: pendingRedirect, target: null })
  return { tokens, nested }
}

type Segment = { words: Word[]; redirects: Redirect[] }

const SEPARATORS = new Set([';', '&', '&&', '||', '|', '|&', ';;', '{', '}'])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'time', 'coproc'])

/** The simple commands in order, with '(' and ')' where a subshell opens and closes (a `cd` inside it stays inside). */
function segments(tokens: Token[]): (Segment | '(' | ')')[] {
  const out: (Segment | '(' | ')')[] = []
  let cur: Segment = { words: [], redirects: [] }
  for (const t of tokens) {
    if (t.kind === 'op' && (t.value === '(' || t.value === ')')) {
      if (cur.words.length || cur.redirects.length) out.push(cur)
      cur = { words: [], redirects: [] }
      out.push(t.value)
    } else if (t.kind === 'op' && SEPARATORS.has(t.value)) {
      if (cur.words.length || cur.redirects.length) out.push(cur)
      cur = { words: [], redirects: [] }
    } else if (t.kind === 'redirect') cur.redirects.push(t)
    else if (t.kind === 'word') {
      if (cur.words.length === 0 && KEYWORDS.has(t.value)) continue
      cur.words.push(t)
    }
  }
  if (cur.words.length || cur.redirects.length) out.push(cur)
  return out
}

/** The context one Bash command is classified in. `cwd` moves with each `cd` the command runs. */
type Ctx = PathContext & { targets: string[]; depth: number }

function target(ctx: Ctx, w: Word | string | null | undefined): void {
  if (w === null || w === undefined) { ctx.targets.push(ctx.cwd); return }
  const value = typeof w === 'string' ? w : w.value
  const dynamic = typeof w === 'string' ? false : w.dynamic
  // something unknown (a variable, a command's output) is written where the command runs, as far as the guard can tell
  ctx.targets.push((dynamic && value === '' ? null : resolvePath(value, ctx)) ?? ctx.cwd)
}

const basename = (cmd: string) => cmd.slice(cmd.lastIndexOf('/') + 1)

/** Positional arguments: flags dropped (and the values of `withValue` flags), everything after `--` kept. */
function positional(args: Word[], withValue: ReadonlySet<string> = new Set()): Word[] {
  const out: Word[] = []
  let rest = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (rest || a.dynamic || !a.value.startsWith('-') || a.value === '-') { out.push(a); continue }
    if (a.value === '--') { rest = true; continue }
    if (withValue.has(a.value)) i++
  }
  return out
}

/** The value of an option: `--long value`, `--long=value`, `-X value`, `-Xvalue`, or X ending a cluster of single letters
 * (`-czf out.tgz`, `-qO-`); undefined when absent, null when it has no value word. */
function optValue(args: Word[], letter: string | null, long: string[]): Word | null | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const v = a.value
    if (a.dynamic) continue
    if (v === '--') return undefined
    if (long.includes(v)) return args[i + 1] ?? null
    for (const l of long) if (v.startsWith(`${l}=`)) return { kind: 'word', value: v.slice(l.length + 1), dynamic: false }
    if (letter && v.startsWith('-') && !v.startsWith('--')) {
      const k = v.indexOf(letter, 1)
      if (k > 0 && /^[A-Za-z]*$/.test(v.slice(1, k))) {
        const rest = v.slice(k + 1)
        return rest ? { kind: 'word', value: rest, dynamic: false } : (args[i + 1] ?? null)
      }
    }
  }
  return undefined
}

const has = (args: Word[], ...flags: string[]) => args.some(a => flags.includes(a.value) || flags.some(f => f.startsWith('--') && a.value.startsWith(`${f}=`)))

// Git subcommands that change the work tree, the index, refs or a remote. Anything else (status, log, diff, show, blame,
// grep, fetch, ls-files, rev-parse, …) is read-only for the guard.
const GIT_WRITES = new Set([
  'commit', 'push', 'apply', 'am', 'cherry-pick', 'merge', 'rebase', 'revert', 'reset', 'checkout', 'switch', 'restore',
  'pull', 'clean', 'rm', 'mv', 'add', 'commit-tree', 'update-ref', 'update-index', 'filter-branch', 'filter-repo', 'init',
  'mergetool', 'format-patch', 'replace', 'read-tree', 'checkout-index', 'stage', 'citool', 'gui',
])

function gitTargets(args: Word[], ctx: Ctx): void {
  let dir: string | null = ctx.cwd
  let workTree: string | null | undefined
  let i = 0
  for (; i < args.length; i++) {
    const v = args[i]!.value
    if (v === '-C') { const d = args[++i]; dir = d && dir ? resolvePath(d.value, { ...ctx, cwd: dir }) : null; continue }
    if (v === '-c' || v === '--git-dir' || v === '--namespace' || v === '--exec-path' || v === '--super-prefix' || v === '--config-env') { i++; continue }
    if (v === '--work-tree') { const d = args[++i]; workTree = d ? resolvePath(d.value, ctx) : null; continue }
    if (v.startsWith('--work-tree=')) { workTree = resolvePath(v.slice('--work-tree='.length), ctx); continue }
    if (v.startsWith('-')) continue
    break
  }
  const sub = args[i]?.value
  if (!sub) return
  const rest = args.slice(i + 1)
  const pos = positional(rest).map(w => w.value)
  const where = workTree !== undefined ? workTree : dir
  const hit = () => { ctx.targets.push(where ?? ctx.cwd) }
  if (GIT_WRITES.has(sub)) {
    if (sub === 'apply' && has(rest, '--check', '--stat', '--numstat', '--summary') && !has(rest, '--apply', '--index', '--cached')) return
    if (sub === 'clean' && has(rest, '-n', '--dry-run')) return
    if (sub === 'push' && has(rest, '--dry-run', '-n')) return
    if (sub === 'format-patch' && has(rest, '--stdout')) return
    return hit()
  }
  switch (sub) {
    case 'stash': if (!['list', 'show'].includes(pos[0] ?? 'push')) hit(); return
    case 'notes': if (!['list', 'show', 'get-ref'].includes(pos[0] ?? 'list')) hit(); return
    case 'worktree': if (pos[0] !== 'list') hit(); return
    case 'submodule': if (!['status', 'summary', 'foreach'].includes(pos[0] ?? 'status')) hit(); return
    case 'sparse-checkout': if (pos[0] !== 'list') hit(); return
    case 'bisect': if (!['log', 'view', 'visualize', 'help'].includes(pos[0] ?? 'help')) hit(); return
    case 'remote': if (['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'].includes(pos[0] ?? '')) hit(); return
    case 'symbolic-ref': if (pos.length >= 2 || has(rest, '-d', '--delete')) hit(); return
    case 'config':
      // user, system or another file's settings are not the checkout
      if (has(rest, '--global', '--system', '--file', '-f', '--blob')) return
      if (has(rest, '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin') || pos[0] === 'get' || pos[0] === 'list') return
      if (pos.length >= 2 || has(rest, '--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit') || ['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(pos[0] ?? '')) hit()
      return
    case 'tag':
      if (has(rest, '-d', '--delete', '-a', '--annotate', '-s', '--sign', '-m', '--message', '-F', '--file', '-f', '--force', '-u')) return hit()
      if (pos.length > 0 && !has(rest, '-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '-v', '--verify')) hit()
      return
    case 'branch':
      if (has(rest, '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description')) return hit()
      if (pos.length > 0 && !has(rest, '-l', '--list', '-a', '--all', '-r', '--remotes', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current', '-v', '-vv', '--verbose')) hit()
      return
    default: return
  }
}

const INPLACE = /^-[A-Za-z]*i/
const inPlace = (args: Word[]) => args.some(a => !a.dynamic && ((INPLACE.test(a.value) && !a.value.startsWith('--')) || a.value.startsWith('--in-place')))

/** sed -i / perl -i / ruby -i: the files after the script (or every positional when the script came with -e/-f). */
function inPlaceTargets(args: Word[], ctx: Ctx, scriptFlags: string[]): void {
  const files: Word[] = []
  let sawScript = false
  let rest = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!rest && !a.dynamic && a.value.startsWith('-') && a.value !== '-') {
      if (a.value === '--') { rest = true; continue }
      if (scriptFlags.includes(a.value)) { sawScript = true; i++; continue }
      if (scriptFlags.some(f => f.startsWith('--') && a.value.startsWith(`${f}=`))) { sawScript = true; continue }
      // perl -pie '…' / -ne: a cluster ending in e takes the script next
      if (/^-[A-Za-z]*e$/.test(a.value) && !a.value.startsWith('--') && scriptFlags.includes('-e')) { sawScript = true; i++; continue }
      continue
    }
    files.push(a)
  }
  const list = sawScript ? files : files.slice(1)
  for (const f of list) target(ctx, f)
}

const FORMATTERS: Record<string, (args: Word[]) => boolean> = {
  prettier: a => has(a, '--write', '-w'),
  eslint: a => has(a, '--fix'),
  biome: a => has(a, '--write', '--apply', '--apply-unsafe', '--fix', '--unsafe'),
  gofmt: a => has(a, '-w'),
  goimports: a => has(a, '-w'),
  black: a => !has(a, '--check', '--diff', '--version', '-h', '--help'),
  isort: a => !has(a, '--check', '--check-only', '-c', '--diff', '--version', '-h', '--help'),
  ruff: a => (a[0]?.value === 'format' && !has(a, '--check', '--diff')) || has(a, '--fix'),
  rustfmt: a => !has(a, '--check', '--version', '-V', '-h', '--help'),
  'clang-format': a => has(a, '-i'),
  autopep8: a => has(a, '-i', '--in-place'),
  standard: a => has(a, '--fix'),
  stylelint: a => has(a, '--fix'),
}

const PKG_WRITES: Record<string, (pos: string[]) => boolean> = {
  npm: p => ['add', 'remove', 'rm', 'r', 'uninstall', 'un', 'unlink', 'update', 'up', 'upgrade', 'version', 'init', 'link', 'ln', 'dedupe', 'prune'].includes(p[0] ?? '')
    || (['install', 'i', 'in', 'isntall'].includes(p[0] ?? '') && p.length > 1) || (p[0] === 'pkg' && ['set', 'delete', 'fix'].includes(p[1] ?? '')),
  pnpm: p => ['add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'init', 'link', 'unlink', 'dedupe', 'prune'].includes(p[0] ?? '')
    || (['install', 'i'].includes(p[0] ?? '') && p.length > 1),
  yarn: p => ['add', 'remove', 'upgrade', 'up', 'init', 'link', 'unlink', 'dedupe'].includes(p[0] ?? ''),
  bun: p => ['add', 'a', 'remove', 'rm', 'update', 'link', 'unlink', 'init', 'create', 'patch', 'patch-commit'].includes(p[0] ?? '')
    || (['install', 'i'].includes(p[0] ?? '') && p.length > 1),
  cargo: p => ['add', 'remove', 'rm', 'new', 'init', 'fix'].includes(p[0] ?? ''),
  go: p => ['get', 'generate'].includes(p[0] ?? '') || (p[0] === 'mod' && ['tidy', 'edit', 'init', 'vendor'].includes(p[1] ?? '')) || (p[0] === 'work' && p[1] !== undefined),
  poetry: p => ['add', 'remove', 'lock', 'init', 'version'].includes(p[0] ?? ''),
  uv: p => ['add', 'remove', 'lock', 'init', 'version'].includes(p[0] ?? ''),
}

/** Commands that modify the files named by their positional arguments. */
const ALL_ARGS = new Set(['tee', 'touch', 'mkdir', 'rm', 'rmdir', 'unlink', 'shred', 'mv'])
/** Commands whose last positional argument (or -t DIR) is the destination. */
const DEST_LAST = new Set(['cp', 'install', 'ln', 'rsync', 'scp', 'link'])
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'ionice', 'stdbuf', 'timeout', 'chronic', 'unbuffer', 'time', 'npx', 'bunx', 'pnpx'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const WRAPPER_VALUE_FLAGS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'], doas: ['-u', '-C'], env: ['-u', '-C', '-S', '--chdir', '--unset', '--split-string'],
  nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p'], stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k', '--signal', '--kill-after'],
  npx: ['-p', '--package', '-c', '--call'], pnpx: [], bunx: ['-p', '--package'],
}

function commandTargets(words: Word[], ctx: Ctx): void {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.value) && !words[i]!.value.startsWith('=')) i++
  const head = words[i]
  if (!head) return
  const cmd = basename(head.value)
  const args = words.slice(i + 1)

  if (WRAPPERS.has(cmd)) {
    const valueFlags = WRAPPER_VALUE_FLAGS[cmd] ?? []
    let j = 0
    for (; j < args.length; j++) {
      const v = args[j]!.value
      if (cmd === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) continue
      if (v === '--') { j++; break }
      if (v.startsWith('-')) { if (valueFlags.includes(v)) j++; continue }
      if (cmd === 'timeout' || (cmd === 'nice' && /^-?\d+$/.test(v))) { j++ } // the duration
      break
    }
    if (cmd === 'command' && args.some(a => a.value === '-v' || a.value === '-V')) return
    return commandTargets(args.slice(j), ctx)
  }
  if (head.dynamic) { ctx.targets.push(ctx.cwd); return } // "$EDITOR" file, $(cmd) args: unknown
  if (SHELLS.has(cmd)) {
    const c = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.value))
    if (c >= 0 && args[c + 1]) classifyInto(args[c + 1]!.value, { ...ctx, depth: ctx.depth + 1 })
    return
  }
  if (cmd === 'eval') return classifyInto(args.map(a => a.value).join(' '), { ...ctx, depth: ctx.depth + 1 })
  if (cmd === 'cd' || cmd === 'pushd') {
    const to = positional(args)[0]
    if (!to) { if (ctx.home) ctx.cwd = ctx.home; return }
    if (to.value === '-') return
    const next = resolvePath(to.value, ctx)
    if (next) ctx.cwd = next
    return
  }
  if (cmd === 'xargs') {
    // the inner command's files arrive on stdin: unknown, so where it runs
    let j = 0
    const valued = ['-I', '-n', '-P', '-d', '-a', '-L', '-s', '-E', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace']
    for (; j < args.length && args[j]!.value.startsWith('-'); j++) if (valued.includes(args[j]!.value)) j++
    const inner = args.slice(j)
    if (!inner.length) return
    const probe: Ctx = { ...ctx, targets: [] }
    commandTargets([...inner, { kind: 'word', value: '\u0000stdin', dynamic: true }], probe)
    if (probe.targets.length) ctx.targets.push(...probe.targets)
    return
  }
  if (ALL_ARGS.has(cmd)) {
    const valued = cmd === 'mkdir' ? ['-m', '--mode'] : cmd === 'touch' ? ['-t', '-d', '-r', '--date', '--reference'] : cmd === 'shred' ? ['-n', '-s', '--iterations', '--size'] : []
    if (cmd === 'mv') { const dir = optValue(args, 't', ['--target-directory']); if (dir !== undefined) target(ctx, dir) }
    for (const p of positional(args, new Set(valued))) target(ctx, p)
    return
  }
  if (DEST_LAST.has(cmd)) {
    const dir = optValue(args, 't', ['--target-directory'])
    if (dir !== undefined) return target(ctx, dir)
    const pos = positional(args, new Set(['-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '-e', '--rsh']))
    const last = pos[pos.length - 1]
    // rsync/scp to host:path writes another machine
    if (last && !((cmd === 'rsync' || cmd === 'scp') && /^[^/]*:/.test(last.value))) target(ctx, last)
    return
  }
  switch (cmd) {
    case 'truncate': case 'chmod': case 'chown': case 'chgrp': case 'setfacl': case 'chattr': {
      const pos = positional(args, new Set(['-s', '--size', '-r', '--reference']))
      const files = cmd === 'truncate' || has(args, '--reference') ? pos : pos.slice(1)
      for (const f of files) target(ctx, f)
      return
    }
    case 'dd': for (const a of args) if (a.value.startsWith('of=')) target(ctx, a.value.slice(3)); return
    case 'sed': if (inPlace(args)) inPlaceTargets(args, ctx, ['-e', '--expression', '-f', '--file']); return
    case 'perl': case 'ruby': if (inPlace(args)) inPlaceTargets(args, ctx, ['-e', '-E']); return
    case 'git': return gitTargets(args, ctx)
    case 'patch': {
      const dir = optValue(args, 'd', ['--directory'])
      if (has(args, '--dry-run', '-C', '--check')) return
      const out = optValue(args, 'o', ['--output'])
      if (out !== undefined) return target(ctx, out)
      if (dir !== undefined) return target(ctx, dir)
      ctx.targets.push(ctx.cwd)
      return
    }
    case 'tar': {
      const mode = args[0] && !args[0].value.startsWith('-') ? args[0].value : ''
      const extract = mode.includes('x') || has(args, '-x', '--extract', '--get') || args.some(a => /^-[A-Za-z]*x/.test(a.value) && !a.value.startsWith('--'))
      const create = /[cru]/.test(mode) || has(args, '-c', '--create', '-r', '--append', '-u', '--update') || args.some(a => /^-[A-Za-z]*[cru]/.test(a.value) && !a.value.startsWith('--'))
      if (extract) { const d = optValue(args, 'C', ['--directory']); return target(ctx, d === undefined ? '.' : d) }
      if (create) {
        // tar czf out.tgz …: the archive is the word after a mode cluster holding f
        const f = mode.includes('f') ? (args[1] ?? null) : optValue(args, 'f', ['--file'])
        if (f !== undefined && f?.value !== '-') target(ctx, f)
      }
      return
    }
    case 'unzip': {
      if (has(args, '-l', '-t', '-v', '-Z', '-p')) return
      const d = optValue(args, 'd', [])
      return target(ctx, d === undefined ? '.' : d)
    }
    case 'zip': { const p = positional(args)[0]; if (p) target(ctx, p); return }
    case 'curl': {
      const o = optValue(args, 'o', ['--output'])
      if (o !== undefined && o?.value !== '-') target(ctx, o)
      if (has(args, '-O', '--remote-name', '-J', '--remote-name-all') || args.some(a => /^-[A-Za-z]*O/.test(a.value) && !a.value.startsWith('--'))) {
        const d = optValue(args, null, ['--output-dir'])
        target(ctx, d === undefined ? '.' : d)
      }
      return
    }
    case 'wget': {
      const o = optValue(args, 'O', ['--output-document'])
      if (o !== undefined) { if (o?.value !== '-') target(ctx, o); return }
      if (has(args, '--spider', '-h', '--help', '-V', '--version')) return
      const d = optValue(args, 'P', ['--directory-prefix'])
      target(ctx, d === undefined ? '.' : d)
      return
    }
    case 'find': {
      const writes = args.some((a, k) => ['-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a.value)
        || (['-exec', '-execdir', '-ok', '-okdir'].includes(a.value) && (() => {
          const end = args.findIndex((b, m) => m > k && (b.value === ';' || b.value === '+'))
          const probe: Ctx = { ...ctx, targets: [] }
          commandTargets(args.slice(k + 1, end < 0 ? undefined : end).map(w => (w.value === '{}' ? { ...w, dynamic: true } : w)), probe)
          return probe.targets.length > 0
        })()))
      if (!writes) return
      const starts = []
      for (const a of args) { if (a.value.startsWith('-') || a.value === '(' || a.value === '!') break; starts.push(a) }
      if (!starts.length) ctx.targets.push(ctx.cwd)
      for (const s of starts) target(ctx, s)
      return
    }
    case 'gh': {
      const pos = positional(args, new Set(['-R', '--repo']))
      if (pos[0]?.value === 'pr' && pos[1]?.value === 'checkout') ctx.targets.push(ctx.cwd)
      if (pos[0]?.value === 'repo' && pos[1]?.value === 'sync') ctx.targets.push(ctx.cwd)
      return
    }
    default: break
  }
  const pkg = PKG_WRITES[cmd]
  if (pkg) {
    const pos = positional(args, new Set(['-C', '--prefix', '--cwd', '--dir', '--filter', '-F', '-w', '--workspace'])).map(w => w.value)
    if (cmd === 'bun' && pos[0] === 'x') return commandTargets(args.slice(args.findIndex(a => a.value === 'x') + 1), ctx)
    if ((cmd === 'npm' || cmd === 'pnpm') && (pos[0] === 'exec' || pos[0] === 'dlx')) return commandTargets(positional(args.slice(args.findIndex(a => a.value === pos[0]) + 1)), ctx)
    if (cmd === 'yarn' && pos[0] === 'dlx') return commandTargets(args.slice(args.findIndex(a => a.value === 'dlx') + 1), ctx)
    if (pkg(pos)) ctx.targets.push(ctx.cwd)
    if (cmd === 'cargo' && pos[0] === 'fmt' && !has(args, '--check')) ctx.targets.push(ctx.cwd)
    if (cmd === 'go' && pos[0] === 'fmt') ctx.targets.push(ctx.cwd)
    return
  }
  const formatter = FORMATTERS[cmd]
  if (formatter && formatter(args)) {
    const pos = positional(args, new Set(['-c', '--config', '--ignore-path', '--plugin', '--parser', '--log-level', '--cache-location', '--line-length', '-l']))
      .filter(w => !['format', 'check', 'lint'].includes(w.value))
    if (!pos.length) ctx.targets.push(ctx.cwd)
    for (const p of pos) target(ctx, p)
  }
}

function classifyInto(command: string, ctx: Ctx): void {
  if (ctx.depth > 8) { ctx.targets.push(ctx.cwd); return }
  const { tokens, nested } = lex(command)
  // a substitution runs in a subshell: its cd stays there; targets is the same array
  for (const inner of nested) classifyInto(inner, { ...ctx, depth: ctx.depth + 1 })
  const saved: string[] = []
  for (const seg of segments(tokens)) {
    if (seg === '(') { saved.push(ctx.cwd); continue }
    if (seg === ')') { ctx.cwd = saved.pop() ?? ctx.cwd; continue }
    // [[ a > b ]] compares strings
    const test = seg.words[0]?.value === '[['
    for (const r of seg.redirects) {
      if (test || !r.op.includes('>')) continue
      // 2>&1, >&- : a file descriptor, not a file
      if (r.op.endsWith('>&') && r.target && /^(\d+|-)$/.test(r.target.value)) continue
      target(ctx, r.target)
    }
    commandTargets(seg.words, ctx)
  }
}

/** Every absolute path a Bash command would write, as far as a static reading can tell. Something it cannot place (a
 * variable, a command's output, xargs input) counts as the directory the command runs in. Reads, searches, tests, builds
 * and `gh pr view/diff/review` yield nothing. */
export function bashWriteTargets(command: string, ctx: PathContext): string[] {
  const c: Ctx = { cwd: normalizePath(ctx.cwd), home: ctx.home ? normalizePath(ctx.home) : null, targets: [], depth: 0 }
  classifyInto(command, c)
  // /dev/null, /dev/stderr, /dev/fd/N: never a checkout
  return [...new Set(c.targets)].filter(t => t !== '/dev' && !t.startsWith('/dev/'))
}

/** The tools the guard reads: the file editors and Bash. Everything else, MCP tools included, is never blocked. */
export const GUARDED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

/** The paths a tool call would write; empty for a tool the guard does not read or a read-only command. */
export function toolWriteTargets(tool: string, input: Record<string, unknown>, ctx: PathContext): string[] {
  if (!GUARDED_TOOLS.has(tool)) return []
  if (tool === 'Bash') return typeof input.command === 'string' ? bashWriteTargets(input.command, ctx) : []
  const path = tool === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : input.file_path
  if (typeof path !== 'string' || !path) return []
  return [resolvePath(path, ctx) ?? normalizePath(`${ctx.cwd}/${path}`)]
}

// ---------------------------------------------------------------------------------------------------------------------
// /swarm2-local

export type LocalCommand = { kind: 'set'; value: 'on' | 'off' } | { kind: 'show' } | { kind: 'usage' }

export function parseLocalCommand(args: string): LocalCommand {
  const v = args.trim().toLowerCase()
  if (v === '') return { kind: 'show' }
  if (v === 'on' || v === 'off') return { kind: 'set', value: v }
  return { kind: 'usage' }
}

/** The audit log with one entry appended; never rewrites an earlier entry. The store caps the file, so the log keeps the
 * newest MAX_AUDIT entries. */
export const MAX_AUDIT = 1000
export function appendAudit(log: unknown, entry: LocalAuditEntry): LocalAuditEntry[] {
  const prior = Array.isArray(log) ? (log as LocalAuditEntry[]) : []
  return [...prior, entry].slice(-MAX_AUDIT)
}

/** A truthy SWARM2_LOCAL_EDITS value (1, on, true, yes) lets an automated environment opt out of the guard. */
export function envAllowsLocal(value: string | null | undefined): boolean {
  return /^(1|on|true|yes)$/i.test((value ?? '').trim())
}
