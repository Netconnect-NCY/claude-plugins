import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  aliasCandidate, appendAudit, BLOCK_MESSAGE, bashWriteTargets, envAllowsLocal, freshProjects, MAX_AUDIT, normalizeRemote, normalizeRemoteWithHost, parseLocalCommand, remoteHost,
  parseRemotes, projectsFromResult, PROJECTS_TTL_MS, remotesMatch, toolWriteTargets,
} from '../hooks/guard'
import { PLAN_ONLY_BLOCK_MESSAGE, PLAN_ONLY_REFUSED_MESSAGE, PLAN_ONLY_UNKNOWN_BLOCK_MESSAGE, PLAN_ONLY_UNKNOWN_REFUSED_MESSAGE, PROJECTS_TTL_MS as TTL } from '../hooks/guard'
import type { LocalAuditEntry } from '../hooks/guard'
import { resetGuardMemory, setGuardTiming, setGuardWarn } from '../hooks/guard-hook'
import { resetPluginReports } from '../hooks/plugin-report'

const ctx = { cwd: '/repo', home: '/home/u' }
const writes = (command: string, c = ctx) => bashWriteTargets(command, c)
/** Whether a command writes anything inside /repo. */
const intoRepo = (command: string, c = ctx) => writes(command, c).some(t => t === '/repo' || t.startsWith('/repo/'))

// ---- remote matching ----

test('remote URLs normalize to lower-case owner/repo across ssh, https and .git spellings', () => {
  for (const url of [
    'git@github.com:Acme/App.git', 'git@github.com:acme/app', 'ssh://git@github.com/Acme/App.git', 'ssh://git@github.com:22/acme/app',
    'https://github.com/Acme/App', 'https://github.com/Acme/App.git', 'https://github.com/Acme/App/', 'https://x-access-token:abc@github.com/acme/APP.git',
    'git://github.com/acme/app.git', 'github.com:acme/app.git',
  ]) expect(normalizeRemote(url)).toBe('acme/app')
  for (const url of ['https://gitlab.com/acme/app.git', 'git@bitbucket.org:acme/app.git', 'https://github.com.evil.test/acme/app', 'https://evil.test/github.com/acme/app', '', '/srv/git/app', './app', 'file:///srv/git/acme/app.git', 'C:/repos/app', 'https://github.com/']) expect(normalizeRemote(url)).toBe(null)
})

test('git remote -v output yields the distinct repositories, matched case-insensitively against the project list', () => {
  const out = 'origin\tgit@github.com:Acme/App.git (fetch)\norigin\tgit@github.com:Acme/App.git (push)\nfork\thttps://github.com/me/app (fetch)\n'
  expect(parseRemotes(out)).toEqual(['acme/app', 'me/app'])
  expect(remotesMatch(parseRemotes(out), ['ACME/app'])).toBe(true)
  expect(remotesMatch(parseRemotes(out), ['acme/other'])).toBe(false)
  expect(remotesMatch([], ['acme/app'])).toBe(false)
})

test('the cached project list counts only while fresh and well-formed', () => {
  const now = 1_000_000_000_000
  expect(freshProjects({ repos: ['Acme/App'], at: now - 1000 }, now)).toEqual(['acme/app'])
  expect(freshProjects({ repos: ['acme/app'], at: now - PROJECTS_TTL_MS - 1 }, now)).toBe(null)
  expect(freshProjects({ repos: 'acme/app', at: now }, now)).toBe(null)
  expect(freshProjects(null, now)).toBe(null)
})

test('a swarm_projects answer teaches the repos, from structured content or its JSON text', () => {
  const body = { projects: [{ id: '1', repo: 'Acme/App' }, { id: '2', repo: 'acme/lib' }], home_url: 'x' }
  expect(projectsFromResult(JSON.stringify(body))).toEqual(['acme/app', 'acme/lib'])
  expect(projectsFromResult({ structuredContent: body })).toEqual(['acme/app', 'acme/lib'])
  expect(projectsFromResult({ content: [{ type: 'text', text: JSON.stringify(body) }] })).toEqual(['acme/app', 'acme/lib'])
  expect(projectsFromResult('not json')).toBe(null)
})

// ---- tool classification ----

test('file tools write their path, relative paths against the cwd; other tools write nothing', () => {
  expect(toolWriteTargets('Edit', { file_path: '/repo/src/a.ts' }, ctx)).toEqual(['/repo/src/a.ts'])
  expect(toolWriteTargets('Write', { file_path: 'src/../b.ts' }, ctx)).toEqual(['/repo/b.ts'])
  expect(toolWriteTargets('MultiEdit', { file_path: '/repo/c.ts' }, ctx)).toEqual(['/repo/c.ts'])
  expect(toolWriteTargets('NotebookEdit', { notebook_path: '/repo/n.ipynb' }, ctx)).toEqual(['/repo/n.ipynb'])
  expect(toolWriteTargets('Write', { file_path: '~/.claude/plans/p.md' }, ctx)).toEqual(['/home/u/.claude/plans/p.md'])
  expect(toolWriteTargets('Read', { file_path: '/repo/a.ts' }, ctx)).toEqual([])
  expect(toolWriteTargets('mcp__plugin_swarm2_swarm2__swarm_plan_propose', { repo: 'acme/app' }, ctx)).toEqual([])
})

test('Bash: reads, searches, tests and reviews write nothing', () => {
  for (const cmd of [
    'ls -la', 'cat src/a.ts', 'grep -rn foo src | head', 'rg "a > b" src', 'find . -name "*.ts"', 'git status', 'git log --oneline -5',
    'git diff HEAD~1', 'git show HEAD', 'git blame src/a.ts', 'git fetch origin', 'git branch -a', 'git tag -l', 'git remote -v',
    'git config --get user.name', 'git stash list', 'git apply --check x.patch', 'bun test', 'npm test', 'npx vitest run', 'make test',
    'gh pr view 12', 'gh pr diff 12', 'gh pr review 12 --approve', 'gh pr checks 12', 'echo hi 2>&1', 'cat a 2>/dev/null', 'ls > /dev/null',
    'sed -n 1,20p src/a.ts', 'sed "s/a/b/" src/a.ts', 'npm install', 'npm ci', 'prettier --check .', 'tsc --noEmit', 'wget -qO- https://x | head',
    'curl -s https://x', 'jq . package.json', 'echo "rm -rf src"', "echo 'git commit -m x'", 'git config --global user.name x',
    '[[ a > b ]] && echo yes', 'find . -type f | xargs grep x', 'git worktree list', 'command -v git',
  ]) expect(writes(cmd)).toEqual([])
})

test('Bash: git commit, push and the other history-changing commands are writes into the checkout', () => {
  for (const cmd of [
    'git commit -m x', 'git commit -am "x"', 'git push', 'git push origin HEAD', 'git apply x.patch', 'git am < x.mbox', 'git cherry-pick abc',
    'git merge main', 'git rebase main', 'git revert HEAD', 'git reset --hard', 'git checkout -- src/a.ts', 'git switch -c x', 'git restore .',
    'git stash', 'git pull', 'git clean -fd', 'git rm a', 'git mv a b', 'git add .', 'git -c user.name=x commit -m y', 'git --no-pager commit',
    'git tag v1', 'git branch -D old', 'git config user.name x', 'git worktree add ../w', 'git remote add up https://x',
    'cd src && git commit -m x', 'FOO=1 git push', 'sudo git push', 'git status && git commit -m x', 'bash -c "git commit -m x"',
  ]) expect(intoRepo(cmd) ? 'blocked' : `allowed: ${cmd}`).toBe('blocked')
  // git -C elsewhere writes that checkout, not this one
  expect(writes('git -C /tmp/other commit -m x')).toEqual(['/tmp/other'])
  expect(intoRepo('git push --dry-run')).toBe(false)
})

test('Bash: redirections and file commands write their targets; /tmp and home stay outside the checkout', () => {
  expect(writes('echo hi > out.txt')).toEqual(['/repo/out.txt'])
  expect(writes('echo hi >> /repo/src/a.ts')).toEqual(['/repo/src/a.ts'])
  expect(writes('echo hi > /tmp/out.txt')).toEqual(['/tmp/out.txt'])
  expect(writes('echo hi > ~/notes.md')).toEqual(['/home/u/notes.md'])
  expect(writes('cd /tmp && echo hi > x')).toEqual(['/tmp/x'])
  expect(writes('(cd /tmp && echo > x); echo > y')).toEqual(['/tmp/x', '/repo/y'])
  expect(writes('cat <<EOF > /tmp/plan.md\nrm -rf src\ngit commit -m x\nEOF\n')).toEqual(['/tmp/plan.md'])
  expect(writes('git diff > /tmp/x.patch')).toEqual(['/tmp/x.patch'])
  for (const cmd of [
    'tee src/a.ts < x', 'ls | tee -a log.txt', 'sed -i "s/a/b/" src/a.ts', 'sed -i.bak -e s/a/b/ src/a.ts', "perl -pi -e 's/a/b/' src/a.ts",
    'mv a.ts b.ts', 'cp /tmp/x src/x', 'rm -rf src', 'touch new.ts', 'mkdir -p src/new', 'ln -s /tmp/x link', 'chmod +x run.sh',
    'truncate -s 0 a.ts', 'dd if=/dev/zero of=blob bs=1 count=1', 'find . -name "*.orig" -delete', 'find src -exec sed -i s/a/b/ {} +',
    'ls | xargs rm', 'tar xzf /tmp/x.tgz', 'unzip /tmp/x.zip', 'curl -sSLo vendor.js https://x', 'wget https://x/f',
    'npm install left-pad', 'bun add zod', 'prettier --write .', 'eslint --fix src', 'gofmt -w .', 'black .', 'cargo fmt', 'patch -p1 < /tmp/x.diff',
    'echo $(touch a) ok', 'out=$(date); echo $out > "$out"', 'echo x > "$TARGET"', 'gh pr checkout 12', 'eval "rm a"',
  ]) expect(intoRepo(cmd) ? 'blocked' : `allowed: ${cmd}`).toBe('blocked')
  for (const cmd of [
    'tee /tmp/a < x', 'sed -i s/a/b/ /tmp/f', 'cp src/a.ts /tmp/', 'rm -rf /tmp/scratch', 'mkdir -p /tmp/w', 'touch ~/.claude/x',
    'mv /tmp/a /tmp/b', 'tar czf /tmp/src.tgz src', 'rsync -a src/ host:/srv/app/', 'curl -o /tmp/f https://x', 'wget -O /tmp/f https://x',
    'cp -r src ~/backup', 'echo > $TMPDIR/x',
  ]) expect(intoRepo(cmd) ? `blocked: ${cmd}` : 'allowed').toBe('allowed')
})

// ---- /swarm2-local parsing and audit ----

test('/swarm2-local takes on or off; nothing shows the setting; anything else is usage', () => {
  expect(parseLocalCommand('on')).toEqual({ kind: 'set', value: 'on' })
  expect(parseLocalCommand(' OFF ')).toEqual({ kind: 'set', value: 'off' })
  expect(parseLocalCommand('')).toEqual({ kind: 'show' })
  expect(parseLocalCommand('maybe')).toEqual({ kind: 'usage' })
  expect(envAllowsLocal('1')).toBe(true)
  expect(envAllowsLocal('')).toBe(false)
  expect(envAllowsLocal(undefined)).toBe(false)
})

test('the audit log only appends, keeping the newest entries', () => {
  const e = (n: number): LocalAuditEntry => ({ at: `t${n}`, session: 's', value: n % 2 ? 'on' : 'off', source: 'command' })
  const one = appendAudit(undefined, e(1))
  expect(appendAudit(one, e(2))).toEqual([e(1), e(2)])
  expect(one).toEqual([e(1)])
  const full = Array.from({ length: MAX_AUDIT }, (_, n) => e(n))
  const next = appendAudit(full, e(MAX_AUDIT))
  expect(next.length).toBe(MAX_AUDIT)
  expect(next[next.length - 1]).toEqual(e(MAX_AUDIT))
})

// ---- the hook, against a fake host ----

const PANE = {
  plugin: 'swarm2', component: 'Pane', requestId: 'swarm2',
  props: { title: 'Swarm2', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Host = {
  files: Set<string>
  remotes: Record<string, string>
  store: Map<string, unknown>
  ran: string[][]
  cwd: string
  env?: string
  /** git fails to start: detection must fail open */
  gitThrows?: boolean
  /** `git remote -v` exits with this non-zero code (e.g. 128: not a usable repository) */
  gitExit?: number
  /** the store throws on every read */
  storeThrows?: boolean
  /** what swarm_projects answers (the fake core answers 'ran' to every other call) */
  projectsAnswer?: string
  /** override reports the plugin POSTed to Swarm2 (url, bearer, body) */
  posts?: { url: string; auth: string | undefined; body: unknown }[]
  /** plugin reports (POST /me/plugin/report) the plugin sent */
  reports?: { auth: string | undefined; body: unknown }[]
  /** the plugin report endpoint answers this status (default 202) */
  reportStatus?: number
  /** the report endpoint fails (HTTP 500) or throws */
  reportFails?: 'status' | 'throw'
  /** `ssh -G <host>` answers: a hostname, 'fail' (exit 1) or 'throw' */
  ssh?: Record<string, string>
  /** `ssh -G` for these aliases never answers; others wait sshDelayMs first */
  sshHang?: string[]
  sshDelayMs?: number
  /** session.cwd throws on its first call after the session started (an internal error inside the guard) */
  cwdThrowsOnce?: boolean
}

function host(over: Partial<Host> = {}): Host {
  const files = new Set([
    '/', '/repo', '/repo/.git', '/repo/src', '/repo/src/a.ts', '/tmp', '/home', '/home/u', '/home/u/.claude',
    '/yaml', '/yaml/.git', '/yaml/.swarm2', '/yaml/.swarm2/project.yaml', '/other', '/other/.git',
  ])
  return {
    files, ran: [], cwd: '/repo',
    remotes: { '/repo': 'origin\tgit@github.com:Acme/App.git (fetch)\n', '/other': 'origin\thttps://github.com/acme/unrelated (fetch)\n', '/yaml': '' },
    store: new Map<string, unknown>([['guardProjects', { repos: ['acme/app'], at: Date.now() }]]),
    ...over,
  }
}

function engine(on: On, h: Host) {
  resetGuardMemory()
  resetPluginReports()
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('http.fetch', (_, e) => {
    const raw = e as unknown as { url: string; init?: Record<string, unknown> } & Record<string, unknown>
    const init = { url: raw.url, ...(raw.init ?? raw) } as { url: string; method?: string; headers?: Record<string, string>; body?: string }
    if (init.method === 'POST' && init.url.endsWith('/me/plugin/report')) {
      h.reports?.push({ auth: init.headers?.authorization, body: JSON.parse(init.body ?? 'null') })
      const status = h.reportStatus ?? 202
      return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: '{"ok":true}' } }
    }
    if (init.method === 'POST') {
      if (h.reportFails === 'throw') throw new Error('network down')
      h.posts?.push({ url: init.url, auth: init.headers?.authorization, body: JSON.parse(init.body ?? 'null') })
      if (h.reportFails === 'status') return { value: { status: 500, ok: false, headers: {}, text: '' } }
      return { value: { status: 202, ok: true, headers: {}, text: '{"ok":true}' } }
    }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  on('store.get', (_, e) => {
    if (h.storeThrows) throw new Error('store broken')
    return { value: (h.store.get(e.key) ?? null) as never }
  })
  on('store.set', (_, e) => { h.store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { h.store.delete(e.key); return { value: undefined } })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => {
    if (h.cwdThrowsOnce) { h.cwdThrowsOnce = false; throw new Error('boom') }
    return { value: h.cwd }
  })
  on('fs.exists', (_, e) => ({ value: h.files.has(e.path) }))
  on('fs.stat', (_, e) => {
    if (!h.files.has(e.path)) throw new Error('ENOENT')
    const isFile = /\.[a-z]+$/.test(e.path) && !e.path.endsWith('.git')
    return { value: { kind: isFile ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('process.run', (_, e) => {
    h.ran.push([...e.argv])
    if (e.argv[0] === 'sh') return { value: { exitCode: 0, stdout: `/home/u\n${h.env ?? ''}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'ssh') {
      if (h.sshHang?.includes(e.argv[2] ?? '')) return new Promise(() => {}) as never
      if (h.sshDelayMs) return new Promise(r => setTimeout(() => r({ value: { exitCode: 0, stdout: `hostname gitlab.example.org\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }), h.sshDelayMs)) as never
      const a = h.ssh?.[e.argv[2] ?? ''] ?? 'throw'
      if (a === 'throw') throw new Error('ssh: not found')
      if (a === 'fail') return { value: { exitCode: 1, stdout: '', stderr: 'x', isStdoutTruncated: false, isStderrTruncated: false } }
      return { value: { exitCode: 0, stdout: `user git\nhostname ${a}\nport 22\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (h.gitThrows) throw new Error('git: not found')
    if (h.gitExit) return { value: { exitCode: h.gitExit, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }
    const root = e.argv[2] ?? ''
    return { value: { exitCode: 0, stdout: h.remotes[root] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the fake core: a call that gets this far ran
  on('tool.call', (_, e) => {
    const text = e.tool.endsWith('__swarm_projects') && h.projectsAnswer ? h.projectsAnswer : 'ran'
    return { result: text as never, text } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

async function outcome($: Engine, input: Record<string, unknown>): Promise<'ran' | 'blocked'> {
  const r = (await $.tool.call(input as never)) as { text?: string; isError?: boolean; deny?: string }
  if (r.deny === BLOCK_MESSAGE || (r.isError && r.text?.includes(BLOCK_MESSAGE))) return 'blocked'
  expect(r.text).toBe('ran')
  return 'ran'
}

test('a checkout whose remote is a cached Swarm2 project: edits and git commit are blocked with the exact message', async ($, on) => {
  const h = host()
  engine(on, h)
  await start($)
  const r = (await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)) as { text?: string; deny?: string }
  expect(r.deny ?? r.text).toBe(BLOCK_MESSAGE)
  expect(await outcome($, { tool: 'Write', file_path: '/repo/src/new.ts', content: 'x' })).toBe('blocked')
  expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('blocked')
  expect(await outcome($, { tool: 'Bash', command: 'git push origin HEAD' })).toBe('blocked')
  expect(await outcome($, { tool: 'Bash', command: 'echo x > src/a.ts' })).toBe('blocked')
  // reads, tests, writes outside the checkout, and MCP calls go through
  expect(await outcome($, { tool: 'Bash', command: 'git status && bun test' })).toBe('ran')
  expect(await outcome($, { tool: 'Bash', command: 'echo x > /tmp/notes.md' })).toBe('ran')
  expect(await outcome($, { tool: 'Write', file_path: '/home/u/.claude/plans/plan.md', content: 'x' })).toBe('ran')
  expect(await outcome($, { tool: 'Read', file_path: '/repo/src/a.ts' })).toBe('ran')
  expect(await outcome($, { tool: 'mcp__plugin_swarm2_swarm2__swarm_plan_propose', repo: 'acme/app', plan: 'x' })).toBe('ran')
})

test('.swarm2/project.yaml at the root marks a checkout without any cached list; an unregistered checkout is free', async ($, on) => {
  const h = host({ store: new Map() })
  engine(on, h)
  await start($)
  expect(await outcome($, { tool: 'Write', file_path: '/yaml/src/x.ts', content: 'x' })).toBe('blocked')
  // no cached list: the remote cannot match, so /repo is free
  expect(await outcome($, { tool: 'Write', file_path: '/repo/src/x.ts', content: 'x' })).toBe('ran')
  expect(await outcome($, { tool: 'Write', file_path: '/other/x.ts', content: 'x' })).toBe('ran')
})

test('a stale cached list matches nothing; a swarm_projects answer refreshes it', async ($, on) => {
  const h = host({ store: new Map([['guardProjects', { repos: ['acme/app'], at: Date.now() - PROJECTS_TTL_MS - 1000 }]]) })
  engine(on, h)
  await start($)
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  const answer = JSON.stringify({ projects: [{ id: '1', repo: 'Acme/App' }] })
  await $.tool.call({ tool: 'mcp__plugin_swarm2_swarm2__swarm_projects' } as never)
  // the fake core answered 'ran': nothing learned yet
  expect((h.store.get('guardProjects') as { at: number }).at).toBeLessThan(Date.now() - PROJECTS_TTL_MS)
  h.projectsAnswer = answer
  await $.tool.call({ tool: 'mcp__plugin_swarm2_swarm2__swarm_projects' } as never)
  expect((h.store.get('guardProjects') as { repos: string[] }).repos).toEqual(['acme/app'])
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('blocked')
})

test('/swarm2-local on allows local edits for the session, is audited, and shows in the pane; off blocks again', async ($, on) => {
  const h = host()
  engine(on, h)
  await start($)
  expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('blocked')
  expect((await command($, 'swarm2-local')).text).toContain('OFF')
  expect((await command($, 'swarm2-local', 'sideways')).text).toContain('Usage')
  expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
  expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('ran')
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /local edits ON/ })) ? 'found' : 'missing indicator').toBe('found')
    await ui.unmount()
  }
  expect((await command($, 'swarm2-local', 'off')).text).toContain('OFF')
  expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('blocked')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /local edits ON/ })).toBeUndefined()
  await ui.unmount()
  const audit = h.store.get('localEditsAudit') as LocalAuditEntry[]
  expect(audit.map(a => [a.session, a.value, a.source])).toEqual([['sess-1', 'on', 'command'], ['sess-1', 'off', 'command']])
  for (const a of audit) expect(Number.isNaN(Date.parse(a.at))).toBe(false)
})

test('SWARM2_LOCAL_EDITS=1 in the environment turns the guard off for the session and is audited', async ($, on) => {
  const h = host({ env: '1' })
  engine(on, h)
  await start($)
  expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('ran')
  expect((h.store.get('localEditsAudit') as LocalAuditEntry[]).map(a => a.source)).toEqual(['env'])
})

test('detection errors fail open: git that cannot start, a store that throws', async ($, on) => {
  const h = host({ gitThrows: true })
  engine(on, h)
  await start($)
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  // project.yaml needs no git and still blocks
  expect(await outcome($, { tool: 'Write', file_path: '/yaml/x.ts', content: 'x' })).toBe('blocked')
})

test('a store that throws on read fails open', async ($, on) => {
  const h = host({ storeThrows: true })
  engine(on, h)
  await start($)
  expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('ran')
})

test('any remote on a GitHub host can match; an unrelated fork under another owner does not', async ($, on) => {
  const out = 'upstream\tgit@github.com:Acme/App.git (fetch)\nfork\thttps://github.com/acme/app (fetch)\norigin\thttps://github.com/me/other (fetch)\n'
  expect(parseRemotes(out)).toEqual(['acme/app', 'me/other'])
  expect(parseRemotes('origin\thttps://gitlab.com/acme/app.git (fetch)\n')).toEqual([])
  const h = host({ remotes: { '/repo': out } })
  engine(on, h)
  await start($)
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('blocked')
})

// (one engine per test: the testing kit registers the fake host's hooks once, before the first call on $)
for (const [label, remote] of [['a GitLab remote of the same name', 'origin\thttps://gitlab.com/acme/app.git (fetch)\n'], ['a fork under another owner', 'origin\thttps://github.com/me/app (fetch)\n']] as const) {
  test(`${label} does not match a Swarm2 project`, async ($, on) => {
    const h = host({ remotes: { '/repo': remote } })
    engine(on, h)
    await start($)
    expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  })
}

test('GitHub host spellings: ssh.github.com:443, www.github.com, scp-like', () => {
  expect(normalizeRemote('ssh://git@ssh.github.com:443/Org/repo.git')).toBe('org/repo')
  expect(normalizeRemote('https://www.github.com/Org/repo')).toBe('org/repo')
  expect(normalizeRemote('git@GitHub.com:Org/repo.git')).toBe('org/repo')
  expect(normalizeRemote('git@ssh.github.com:Org/repo.git')).toBe('org/repo')
  expect(normalizeRemote('git@github-work:Org/repo.git')).toBe(null)
})

test('alias helpers: host, ssh-only candidates, resolved hostname', () => {
  expect(remoteHost('git@github-work:Org/repo.git')).toBe('github-work')
  expect(remoteHost('/srv/git/x')).toBe(null)
  expect(aliasCandidate('git@github-work:Org/Repo.git')).toEqual({ url: 'git@github-work:Org/Repo.git', host: 'github-work', path: 'org/repo' })
  expect(aliasCandidate('ssh://git@work/Org/repo')?.host).toBe('work')
  for (const u of ['https://gitlab.com/Org/repo', 'git://x.test/Org/repo', 'file:///a/b/c', '/srv/a/b', 'git@github.com:Org/repo']) expect(aliasCandidate(u)).toBe(null)
  expect(normalizeRemoteWithHost('git@github-work:Org/repo.git', 'GitHub.com')).toBe('org/repo')
  expect(normalizeRemoteWithHost('git@github-work:Org/repo.git', 'gitlab.example')).toBe(null)
})

const aliasRemote = 'origin\tgit@github-work:Acme/App.git (fetch)\norigin\tgit@github-work:Acme/App.git (push)\n'
for (const [ssh, expected] of [
  ['github.com', 'blocked'], ['ssh.github.com', 'blocked'], ['gitlab.example.org', 'ran'], ['fail', 'blocked'], ['throw', 'blocked'],
] as const) {
  test(`an ssh alias is resolved with ssh -G: ${ssh} -> ${expected} (failures fail closed), asked once`, async ($, on) => {
    const edit = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
    const h = host({ remotes: { '/repo': aliasRemote }, ssh: { 'github-work': ssh } })
    engine(on, h)
    await start($)
    expect(await outcome($, edit)).toBe(expected)
    expect(await outcome($, edit)).toBe(expected) // the verdict is cached: ssh is not asked again
    expect(h.ran.filter(a => a[0] === 'ssh').length).toBe(1)
  })
}

test('https remotes never trigger ssh -G', async ($, on) => {
  const h = host({ remotes: { '/repo': 'origin\thttps://example.test/Acme/App (fetch)\n' } })
  engine(on, h)
  await start($)
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  expect(h.ran.some(a => a[0] === 'ssh')).toBe(false)
})

// The warning itself goes to stderr of the plugin's own module instance, which a test of this kit cannot swap (setGuardWarn
// reaches only the test's copy of the module): the outcome is what is checked here.
test('no matching remote but a GitHub-like one lets local edits run', async ($, on) => {
  const h = host({ remotes: { '/repo': 'origin\thttps://github.com/me/other (fetch)\nalias\tgit@work:me/x.git (fetch)\n' }, ssh: { work: 'github.com' } })
  engine(on, h)
  await start($)
  const edit = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
  expect(await outcome($, edit)).toBe('ran')
  expect(await outcome($, edit)).toBe('ran')
})

test('a /swarm2-local override is reported to Swarm2 as an audit event, best-effort', async ($, on) => {
  const h = host({ posts: [] })
  h.store.set('statusToken', 's2s_test')
  engine(on, h)
  await start($)
  await command($, 'swarm2-local', 'on')
  await command($, 'swarm2-local', 'off')
  expect(h.posts!.map(p => [p.url.endsWith('/me/guard/override'), p.auth, (p.body as LocalAuditEntry).session, (p.body as LocalAuditEntry).value, (p.body as LocalAuditEntry).source]))
    .toEqual([[true, 'Bearer s2s_test', 'sess-1', 'on', 'command'], [true, 'Bearer s2s_test', 'sess-1', 'off', 'command']])
  // local audit still written
  expect((h.store.get('localEditsAudit') as LocalAuditEntry[]).length).toBe(2)
})

for (const reportFails of ['status', 'throw'] as const) {
  test(`a failing report (${reportFails}) never blocks the override`, async ($, on) => {
    const h = host({ posts: [], reportFails })
    h.store.set('statusToken', 's2s_test')
    engine(on, h)
    await start($)
    expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
    expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('ran')
    expect((h.store.get('localEditsAudit') as LocalAuditEntry[]).length).toBe(1)
  })
}

const twoAliases = 'origin\tgit@alias-a:Acme/App.git (fetch)\norigin\tgit@alias-b:Acme/App.git (fetch)\n'
const sshCalls = (h: Host) => h.ran.filter(a => a[0] === 'ssh').length

// A new project list drops every checkout verdict (the plugin's clock cannot be moved from a test of this kit): the next
// verdict needs the alias again and must take it from the lookup cache, a success for the session, a failure for 60 s.
for (const [answer, expected] of [['gitlab.example.org', 'ran'], ['fail', 'blocked']] as const) {
  test(`an ssh -G lookup (${answer}) is cached across checkout verdicts`, async ($, on) => {
    const h = host({ remotes: { '/repo': 'origin\tgit@alias-a:Acme/App.git (fetch)\n' }, ssh: { 'alias-a': answer } })
    engine(on, h)
    await start($)
    const edit = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
    expect(await outcome($, edit)).toBe(expected)
    h.projectsAnswer = JSON.stringify({ projects: [{ repo: 'acme/app' }, { repo: 'acme/other' }] })
    await $.tool.call({ tool: 'mcp__plugin_swarm2_swarm2__swarm_projects' } as never)
    expect((h.store.get('guardProjects') as { repos: string[] }).repos).toEqual(['acme/app', 'acme/other'])
    expect(await outcome($, edit)).toBe(expected)
    expect(sshCalls(h)).toBe(1)
  })
}

test('ssh -G lookups run concurrently', async ($, on) => {
  // two 150 ms lookups finish in well under 300 ms
  const h = host({ remotes: { '/repo': twoAliases }, sshDelayMs: 150 })
  engine(on, h)
  await start($)
  const t0 = Date.now()
  await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  expect(Date.now() - t0).toBeLessThan(280)
  expect(sshCalls(h)).toBe(2)
})

test('hung ssh -G lookups: one overall deadline (3 s) ends the wait, and unresolved fails closed', { timeoutMs: 10_000 }, async ($, on) => {
  const g = host({ remotes: { '/repo': twoAliases }, sshHang: ['alias-a', 'alias-b'] })
  engine(on, g)
  await start($)
  const t1 = Date.now()
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('blocked')
  const took = Date.now() - t1
  expect(took).toBeGreaterThanOrEqual(2900)
  expect(took).toBeLessThan(3600) // the total cap, not one cap per lookup (two would be 6 s)
})

test('a hung ssh -G is not started again when the failed-lookup and verdict TTLs expire', async ($, on) => {
  let t = 1_000_000
  try {
    const h = host({ remotes: { '/repo': 'origin\tgit@alias-a:Acme/App.git (fetch)\n' }, sshHang: ['alias-a'] })
    engine(on, h)
    setGuardTiming({ now: () => t, lookupDeadlineMs: 200 })
    await start($)
    const edit = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
    expect(await outcome($, edit)).toBe('blocked')
    expect(sshCalls(h)).toBe(1)
    t += 61_000 // verdict and failed lookup both expired; the first ssh -G is still pending
    expect(await outcome($, edit)).toBe('blocked')
    expect(sshCalls(h)).toBe(1)
  } finally { setGuardTiming(null) }
})

// ---- plan_only (plugin 0.5.0) ----


const planOnlyStore = (role: string | undefined, plan_only = true) =>
  new Map<string, unknown>([['guardProjects', { repos: ['acme/app'], at: Date.now(), meta: { 'acme/app': { ...(role ? { role } : {}), plan_only } } }]])

const edit = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
async function verdictText($: Engine, input: Record<string, unknown>): Promise<string> {
  const r = (await $.tool.call(input as never)) as { text?: string; deny?: string }
  return r.deny ?? r.text ?? ''
}

for (const role of ['viewer', 'developer', 'maintainer', undefined]) {
  test(`plan_only: /swarm2-local on is refused for ${role ?? 'an unknown role'}, edits stay blocked and the refusal is reported`, async ($, on) => {
    const h = host({ store: planOnlyStore(role), posts: [] })
    h.store.set('statusToken', 's2s_test')
    engine(on, h)
    await start($)
    expect((await command($, 'swarm2-local', 'on')).text).toBe(PLAN_ONLY_REFUSED_MESSAGE)
    expect(await verdictText($, edit)).toBe(PLAN_ONLY_BLOCK_MESSAGE)
    expect(await verdictText($, { tool: 'Bash', command: 'git commit -m x' })).toBe(PLAN_ONLY_BLOCK_MESSAGE)
    const body = h.posts![0]!.body as LocalAuditEntry
    expect(h.posts!.length).toBe(1)
    expect([body.value, body.source, body.action]).toEqual(['on', 'command', 'refused'])
    expect((h.store.get('localEditsAudit') as LocalAuditEntry[])[0]!.action).toBe('refused')
  })
}

test('plan_only: the owner may turn the override on; accepted reports say action applied', async ($, on) => {
  const h = host({ store: planOnlyStore('owner'), posts: [] })
  h.store.set('statusToken', 's2s_test')
  engine(on, h)
  await start($)
  expect(await verdictText($, edit)).toBe(BLOCK_MESSAGE)
  expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
  expect(await verdictText($, edit)).toBe('ran')
  expect((h.posts![0]!.body as LocalAuditEntry).action).toBe('applied')
})

for (const role of ['viewer', 'developer', 'maintainer', 'owner']) {
  test(`a project without plan_only is unchanged for ${role}`, async ($, on) => {
    const h = host({ store: planOnlyStore(role, false), posts: [] })
    engine(on, h)
    await start($)
    expect(await verdictText($, edit)).toBe(BLOCK_MESSAGE)
    expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
    expect(await verdictText($, edit)).toBe('ran')
  })
}

test('a project listed without plan_only (an older server) is unchanged', async ($, on) => {
  const h = host({ store: new Map([['guardProjects', { repos: ['acme/app'], at: Date.now() }]]) })
  engine(on, h)
  await start($)
  expect(await verdictText($, edit)).toBe(BLOCK_MESSAGE)
  expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
  expect(await verdictText($, edit)).toBe('ran')
})

test('plan_only: SWARM2_LOCAL_EDITS=1 is refused for a non-owner and reported as refused', async ($, on) => {
  const h = host({ store: planOnlyStore('developer'), env: '1', posts: [] })
  h.store.set('statusToken', 's2s_test')
  engine(on, h)
  await start($)
  expect(await verdictText($, edit)).toBe(PLAN_ONLY_BLOCK_MESSAGE)
  expect(h.posts!.map(p => [(p.body as LocalAuditEntry).source, (p.body as LocalAuditEntry).action])).toEqual([['env', 'refused']])
})

test('plan_only: SWARM2_LOCAL_EDITS=1 is honoured for the owner', async ($, on) => {
  const h = host({ store: planOnlyStore('owner'), env: '1', posts: [] })
  h.store.set('statusToken', 's2s_test')
  engine(on, h)
  await start($)
  expect(await verdictText($, edit)).toBe('ran')
  expect(h.posts!.map(p => [(p.body as LocalAuditEntry).source, (p.body as LocalAuditEntry).action])).toEqual([['env', 'applied']])
})

test('plan_only: an override set elsewhere in the session does not lift the guard for a non-owner', async ($, on) => {
  const h = host({ store: planOnlyStore('developer'), cwd: '/other' }) // the session works in an unrelated checkout
  engine(on, h)
  await start($)
  expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
  expect(await verdictText($, edit)).toBe(PLAN_ONLY_BLOCK_MESSAGE)
})

// B3: a git error hides the remotes, so outside a .swarm2/project.yaml checkout nothing ties the directory to the plan_only
// project in the cache: fail open (a plan_only project elsewhere no longer blocks unrelated directories).
for (const failure of [{ gitThrows: true }, { gitExit: 128 }]) {
  test(`fail open: a git error (${Object.keys(failure)[0]}) in a checkout without .swarm2/project.yaml runs, even with a plan_only cache`, async ($, on) => {
    const h = host({ store: planOnlyStore('viewer'), ...failure })
    engine(on, h)
    await start($)
    expect(await verdictText($, edit)).toBe('ran')
    expect(await verdictText($, { tool: 'Write', file_path: '/other/x.ts', content: 'x' })).toBe('ran')
  })
}

test('fail closed: a .swarm2/project.yaml checkout stays blocked when the store throws', async ($, on) => {
  const h = host({ storeThrows: true })
  engine(on, h)
  await start($)
  expect(await verdictText($, { tool: 'Write', file_path: '/yaml/src/x.ts', content: 'x' })).toBe(BLOCK_MESSAGE)
})

test('a git error without plan_only or yaml still fails open', async ($, on) => {
  const h = host({ gitThrows: true })
  engine(on, h)
  await start($)
  expect(await verdictText($, edit)).toBe('ran')
})

test('fail closed: an unexpected error inside the guard denies for a yaml checkout', async ($, on) => {
  const h = host({ store: new Map(), cwdThrowsOnce: false })
  engine(on, h)
  await start($)
  h.cwdThrowsOnce = true
  expect(await verdictText($, { tool: 'Write', file_path: '/yaml/src/x.ts', content: 'x' })).toBe(BLOCK_MESSAGE)
})

test('fail closed: an unexpected error inside the guard denies for a plan_only non-owner cache', async ($, on) => {
  const h = host({ store: planOnlyStore('developer') })
  engine(on, h)
  await start($)
  h.cwdThrowsOnce = true
  expect(await verdictText($, edit)).toBe(PLAN_ONLY_BLOCK_MESSAGE)
})

test('an unexpected error inside the guard fails open elsewhere', async ($, on) => {
  const h = host()
  engine(on, h)
  await start($)
  h.cwdThrowsOnce = true
  expect(await verdictText($, { tool: 'Write', file_path: '/other/x.ts', content: 'x' })).toBe('ran')
})

test('fail closed: an unexpected error inside the guard runs in an unrelated checkout even with a plan_only cache', async ($, on) => {
  const h = host({ store: planOnlyStore('developer') })
  engine(on, h)
  await start($)
  h.cwdThrowsOnce = true
  expect(await verdictText($, { tool: 'Write', file_path: '/other/x.ts', content: 'x' })).toBe('ran')
})

test('fail closed: an unexpected error plus a git error in a plan_only cache checkout without yaml runs (nothing ties it to the project)', async ($, on) => {
  const h = host({ store: planOnlyStore('developer'), gitThrows: true })
  engine(on, h)
  await start($)
  h.cwdThrowsOnce = true
  expect(await verdictText($, edit)).toBe('ran')
})

// ---- a .swarm2/project.yaml checkout whose plan_only is unknown (B3/B4, plugin 0.5.1) ----

/** /yp: a checkout with .swarm2/project.yaml and an acme/app remote (or the remote given). */
function yamlHost(over: Partial<Host> = {}, remote = 'origin\tgit@github.com:Acme/App.git (fetch)\n'): Host {
  const h = host({ cwd: '/yp', posts: [], ...over })
  for (const f of ['/yp', '/yp/.git', '/yp/.swarm2', '/yp/.swarm2/project.yaml', '/yp/src', '/yp/src/a.ts']) h.files.add(f)
  h.remotes['/yp'] = remote
  h.store.set('statusToken', 's2s_test')
  return h
}
const ypEdit = { tool: 'Edit', file_path: '/yp/src/a.ts', old_string: 'a', new_string: 'b' }
const overrideReports = (h: Host) => h.posts!.filter(p => p.url.endsWith('/me/guard/override')).map(p => p.body as LocalAuditEntry)
const staleStore = (meta?: Record<string, unknown>) =>
  new Map<string, unknown>([['guardProjects', { repos: ['acme/app'], at: Date.now() - TTL - 60_000, ...(meta ? { meta } : {}) }]])

for (const [label, store] of [
  ['an empty project cache', new Map<string, unknown>()],
  ['a stale project cache', staleStore({ 'acme/app': { role: 'developer', plan_only: false } })],
  ['a stale cache that named the viewer owner', staleStore({ 'acme/app': { role: 'owner', plan_only: true } })],
] as const) {
  test(`plan_only unknown: ${label} in a .swarm2/project.yaml checkout refuses /swarm2-local on and says how to fix it`, async ($, on) => {
    const h = yamlHost({ store: new Map(store) })
    engine(on, h)
    await start($)
    expect(await verdictText($, ypEdit)).toBe(BLOCK_MESSAGE)
    const text = (await command($, 'swarm2-local', 'on')).text ?? ''
    expect(text).toBe(PLAN_ONLY_UNKNOWN_REFUSED_MESSAGE)
    expect(text).toContain('/swarm2-token')
    expect(text).toContain('git remote -v')
    expect(await verdictText($, ypEdit)).toBe(BLOCK_MESSAGE)
    expect(overrideReports(h).map(b => [b.value, b.source, b.action])).toEqual([['on', 'command', 'refused']])
    expect((h.store.get('localEditsAudit') as LocalAuditEntry[])[0]!.action).toBe('refused')
  })
}

test('plan_only unknown: a fork or renamed remote while the fresh feed holds a plan_only project the viewer does not own is refused', async ($, on) => {
  const h = yamlHost({ store: planOnlyStore('developer') }, 'origin\thttps://github.com/me/app-renamed (fetch)\n')
  engine(on, h)
  await start($)
  expect((await command($, 'swarm2-local', 'on')).text).toBe(PLAN_ONLY_UNKNOWN_REFUSED_MESSAGE)
  expect(await verdictText($, ypEdit)).toBe(BLOCK_MESSAGE)
  expect(overrideReports(h).map(b => b.action)).toEqual(['refused'])
})

test('plan_only unknown: a git error in a .swarm2/project.yaml checkout stays fail-closed (override refused)', async ($, on) => {
  const h = yamlHost({ store: planOnlyStore('developer'), gitThrows: true })
  engine(on, h)
  await start($)
  expect(await verdictText($, ypEdit)).toBe(BLOCK_MESSAGE)
  expect((await command($, 'swarm2-local', 'on')).text).toBe(PLAN_ONLY_UNKNOWN_REFUSED_MESSAGE)
  expect(await verdictText($, ypEdit)).toBe(BLOCK_MESSAGE)
})

test('a fork remote is accepted once a fresh feed holds no plan_only project the viewer does not own', async ($, on) => {
  const h = yamlHost({ store: planOnlyStore('owner') }, 'origin\thttps://github.com/me/app-renamed (fetch)\n')
  engine(on, h)
  await start($)
  expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
  expect(await verdictText($, ypEdit)).toBe('ran')
  expect(overrideReports(h).map(b => b.action)).toEqual(['applied'])
})

test('a fresh feed saying plan_only false for the project accepts the override in a .swarm2/project.yaml checkout', async ($, on) => {
  const h = yamlHost({ store: planOnlyStore('developer', false) })
  engine(on, h)
  await start($)
  expect(await verdictText($, ypEdit)).toBe(BLOCK_MESSAGE)
  expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
  expect(await verdictText($, ypEdit)).toBe('ran')
})

test('a fresh feed saying plan_only true refuses a non-owner in a .swarm2/project.yaml checkout (plan-only message)', async ($, on) => {
  const h = yamlHost({ store: planOnlyStore('maintainer') })
  engine(on, h)
  await start($)
  expect((await command($, 'swarm2-local', 'on')).text).toBe(PLAN_ONLY_REFUSED_MESSAGE)
  expect(await verdictText($, ypEdit)).toBe(PLAN_ONLY_BLOCK_MESSAGE)
})

test('the owner of a plan_only project may override in its .swarm2/project.yaml checkout', async ($, on) => {
  const h = yamlHost({ store: planOnlyStore('owner') })
  engine(on, h)
  await start($)
  expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
  expect(await verdictText($, ypEdit)).toBe('ran')
})

test('plan_only unknown: SWARM2_LOCAL_EDITS=1 is refused and reported as refused', async ($, on) => {
  const h = yamlHost({ store: new Map(), env: '1' })
  engine(on, h)
  await start($)
  expect(await verdictText($, ypEdit)).toBe(BLOCK_MESSAGE)
  expect(overrideReports(h).map(b => [b.source, b.action])).toEqual([['env', 'refused']])
})

test('an unrelated directory keeps today\'s behaviour; an override set there never lifts a plan_only-unknown checkout', async ($, on) => {
  const h = yamlHost({ store: new Map(), cwd: '/other' })
  engine(on, h)
  await start($)
  expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
  expect(await verdictText($, { tool: 'Write', file_path: '/other/x.ts', content: 'x' })).toBe('ran')
  expect(await verdictText($, { tool: 'Write', file_path: '/repo/x.ts', content: 'x' })).toBe('ran') // no cache: /repo is not known
  expect(await verdictText($, ypEdit)).toBe(PLAN_ONLY_UNKNOWN_BLOCK_MESSAGE)
})

// ---- the plugin report (POST /me/plugin/report) ----

const sleep = (ms: number) => new Promise(r => (globalThis as unknown as { setTimeout: (f: (v?: unknown) => void, ms: number) => unknown }).setTimeout(r, ms))
async function settle(h: Host, n: number): Promise<void> {
  for (let i = 0; i < 100 && (h.reports?.length ?? 0) < n; i++) await sleep(10)
  await sleep(30) // anything more that was going to arrive
}

test('the plugin reports version and guard state at session start, once per window, at once when the guard changes', async ($, on) => {
  const h = host({ reports: [], posts: [] })
  h.store.set('statusToken', 's2s_test')
  engine(on, h)
  await start($)
  await settle(h, 1)
  expect(h.reports).toEqual([{ auth: 'Bearer s2s_test', body: { client: 'claude-code', plugin_version: '0.5.2', guard: 'on', session: 'sess-1' } }])
  for (let i = 0; i < 3; i++) await outcome($, { tool: 'Read', file_path: '/repo/src/a.ts' })
  await command($, 'swarm2')
  await settle(h, 2)
  expect(h.reports!.length).toBe(1) // throttled: tool calls and pane polls inside the window send nothing more
  await command($, 'swarm2-local', 'on')
  await settle(h, 2)
  expect(h.reports!.map(r => (r.body as { guard: string }).guard)).toEqual(['on', 'off'])
  await command($, 'swarm2-local', 'off')
  await settle(h, 3)
  expect(h.reports!.map(r => (r.body as { guard: string }).guard)).toEqual(['on', 'off', 'on'])
  // the override report is separate and unchanged
  expect(overrideReports(h).map(b => b.value)).toEqual(['on', 'off'])
})

test('SWARM2_LOCAL_EDITS reports the guard off from the start', async ($, on) => {
  const h = host({ reports: [], env: '1' })
  h.store.set('statusToken', 's2s_test')
  engine(on, h)
  await start($)
  await settle(h, 1)
  expect(h.reports!.map(r => (r.body as { guard: string }).guard)).toEqual(['off'])
})

test('a refused override leaves the reported guard on', async ($, on) => {
  const h = host({ store: planOnlyStore('developer'), reports: [], posts: [] })
  h.store.set('statusToken', 's2s_test')
  engine(on, h)
  await start($)
  await settle(h, 1)
  await command($, 'swarm2-local', 'on')
  await settle(h, 2)
  expect(h.reports!.map(r => (r.body as { guard: string }).guard)).toEqual(['on'])
})

test('without a status token nothing is reported and nothing breaks', async ($, on) => {
  const h = host({ reports: [] })
  engine(on, h)
  await start($)
  await settle(h, 1)
  expect(h.reports).toEqual([])
  expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('blocked')
})

for (const reportStatus of [500, 400]) {
  test(`a report the server rejects (HTTP ${reportStatus}) never blocks edits or the override`, async ($, on) => {
    const h = host({ reports: [], reportStatus })
    h.store.set('statusToken', 's2s_test')
    engine(on, h)
    await start($)
    await settle(h, 1)
    expect(h.reports!.length).toBe(1)
    expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
    expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('ran')
  })
}
