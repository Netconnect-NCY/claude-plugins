import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  aliasCandidate, appendAudit, BLOCK_MESSAGE, bashWriteTargets, envAllowsLocal, freshProjects, MAX_AUDIT, normalizeRemote, normalizeRemoteWithHost, parseLocalCommand, remoteHost,
  parseRemotes, projectsFromResult, PROJECTS_TTL_MS, remotesMatch, toolWriteTargets,
} from '../hooks/guard'
import type { LocalAuditEntry } from '../hooks/guard'
import { resetGuardMemory, setGuardTiming, setGuardWarn } from '../hooks/guard-hook'

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
  /** the store throws on every read */
  storeThrows?: boolean
  /** what swarm_projects answers (the fake core answers 'ran' to every other call) */
  projectsAnswer?: string
  /** POSTs the plugin made to Swarm2 (url, bearer, body) */
  posts?: { url: string; auth: string | undefined; body: unknown }[]
  /** the report endpoint fails (HTTP 500) or throws */
  reportFails?: 'status' | 'throw'
  /** `ssh -G <host>` answers: a hostname, 'fail' (exit 1) or 'throw' */
  ssh?: Record<string, string>
  /** `ssh -G` for these aliases never answers; others wait sshDelayMs first */
  sshHang?: string[]
  sshDelayMs?: number
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
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('http.fetch', (_, e) => {
    const init = e as unknown as { url: string; method?: string; headers?: Record<string, string>; body?: string }
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
  on('session.cwd', () => ({ value: h.cwd }))
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
  h.remotes['/repo'] = 'origin\thttps://gitlab.com/acme/app.git (fetch)\n'
  resetGuardMemory()
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  h.remotes['/repo'] = 'origin\thttps://github.com/me/app (fetch)\n'
  resetGuardMemory()
  expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
})

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

test('an ssh alias is resolved with ssh -G; github hostname blocks, another host does not, failures fail closed', async ($, on) => {
  const aliasRemote = 'origin\tgit@github-work:Acme/App.git (fetch)\norigin\tgit@github-work:Acme/App.git (push)\n'
  const edit = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
  for (const [ssh, expected] of [
    ['github.com', 'blocked'], ['ssh.github.com', 'blocked'], ['gitlab.example.org', 'ran'], ['fail', 'blocked'], ['throw', 'blocked'],
  ] as const) {
    const h = host({ remotes: { '/repo': aliasRemote }, ssh: { 'github-work': ssh } })
    engine(on, h)
    await start($)
    expect(await outcome($, edit)).toBe(expected)
    // cached per host: a second checkout verdict does not ask ssh again
    const asked = () => h.ran.filter(a => a[0] === 'ssh').length
    const n = asked()
    resetGuardMemory()
    expect(n).toBe(1)
  }
  // https remotes never trigger ssh
  const h = host({ remotes: { '/repo': 'origin\thttps://example.test/Acme/App (fetch)\n' } })
  engine(on, h)
  await start($)
  expect(await outcome($, edit)).toBe('ran')
  expect(h.ran.some(a => a[0] === 'ssh')).toBe(false)
})

test('no matching remote but a GitHub-like one warns once per verdict window', async ($, on) => {
  const h = host({ remotes: { '/repo': 'origin\thttps://github.com/me/other (fetch)\nalias\tgit@work:me/x.git (fetch)\n' }, ssh: { work: 'github.com' } })
  engine(on, h)
  const warnings: string[] = []
  setGuardWarn(m => warnings.push(m))
  await start($)
  const edit = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
  expect(await outcome($, edit)).toBe('ran')
  expect(await outcome($, edit)).toBe('ran')
  expect(warnings).toEqual(["swarm2 guard: no Swarm2 project matches this checkout's remotes (me/other, me/x); local edits are allowed"])
  // a gitlab-only checkout is not GitHub-like: silent
  const h2 = host({ remotes: { '/repo': 'origin\thttps://gitlab.com/acme/app (fetch)\n' } })
  engine(on, h2)
  setGuardWarn(m => warnings.push(m))
  await start($)
  expect(await outcome($, edit)).toBe('ran')
  expect(warnings.length).toBe(1)
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

test('a failing report never blocks the override', async ($, on) => {
  for (const reportFails of ['status', 'throw'] as const) {
    const h = host({ posts: [], reportFails })
    h.store.set('statusToken', 's2s_test')
    engine(on, h)
    await start($)
    expect((await command($, 'swarm2-local', 'on')).text).toContain('ON')
    expect(await outcome($, { tool: 'Bash', command: 'git commit -m x' })).toBe('ran')
    expect((h.store.get('localEditsAudit') as LocalAuditEntry[]).length).toBe(1)
  }
})

const twoAliases = 'origin\tgit@alias-a:Acme/App.git (fetch)\norigin\tgit@alias-b:Acme/App.git (fetch)\n'
const sshCalls = (h: Host) => h.ran.filter(a => a[0] === 'ssh').length

test('a successful ssh -G lookup is cached across checkout verdicts; a failed one is retried only after 60 s', async ($, on) => {
  let t = 1_000_000
  try {
    const h = host({ remotes: { '/repo': 'origin\tgit@alias-a:Acme/App.git (fetch)\n' }, ssh: { 'alias-a': 'gitlab.example.org' } })
    engine(on, h)
    setGuardTiming({ now: () => t })
    await start($)
    const edit = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
    await outcome($, edit)
    t += 61_000 // verdict expired, lookup cached for good
    await outcome($, edit)
    expect(sshCalls(h)).toBe(1)

    const f = host({ remotes: { '/repo': 'origin\tgit@alias-a:Acme/App.git (fetch)\n' }, ssh: { 'alias-a': 'fail' } })
    engine(on, f)
    setGuardTiming({ now: () => t })
    await start($)
    await outcome($, edit)
    expect(sshCalls(f)).toBe(1)
    t += 59_000 // verdict (60 s) still fresh, no lookup
    await outcome($, edit)
    expect(sshCalls(f)).toBe(1)
    t += 2_000 // both expired: retried
    await outcome($, edit)
    expect(sshCalls(f)).toBe(2)
  } finally { setGuardTiming(null) }
})

test('ssh -G lookups run concurrently and one overall deadline bounds the wall time', async ($, on) => {
  try {
    // concurrent: two 150 ms lookups finish in well under 300 ms
    const h = host({ remotes: { '/repo': twoAliases }, sshDelayMs: 150 })
    engine(on, h)
    setGuardTiming({ lookupDeadlineMs: 1000 })
    await start($)
    const t0 = Date.now()
    await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
    expect(Date.now() - t0).toBeLessThan(280)
    expect(sshCalls(h)).toBe(2)

    // hung lookups: the total cap (not per lookup) ends the wait, unresolved fails closed (blocked)
    const g = host({ remotes: { '/repo': twoAliases }, sshHang: ['alias-a', 'alias-b'] })
    engine(on, g)
    setGuardTiming({ lookupDeadlineMs: 200 })
    await start($)
    const t1 = Date.now()
    expect(await outcome($, { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('blocked')
    const took = Date.now() - t1
    expect(took).toBeGreaterThanOrEqual(190)
    expect(took).toBeLessThan(380)
  } finally { setGuardTiming(null) }
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
