import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'swarm2',
  component: 'Pane',
  requestId: 'swarm2',
  props: {
    title: 'Swarm2',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const RUN_ID = '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function controlRun(over: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID, repo: 'acme/app', requester: null, mine: true, goal: 'fix login', status: 'running',
    status_reason: null, provider: 'claude', attempt: 1, phase: 'executing', started_at: null, updated_at: '2026-11-05T00:00:00Z',
    pr_url: null, merge_status: null, validation_tier: 'affected',
    workers: [{ id: 'w-01', vendor: 'claude', model: 'claude-opus-5-5', last_action: 'Bash: bun test', since: null }],
    tokens: null, cost_usd: 1.5, ...over,
  }
}

function statusRun(over: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID, repo: 'acme/app', status: 'running', status_reason: null, provider: 'claude', attempt: 1,
    phase: 'executing', updated_at: '2026-11-05T00:00:00Z', pr_url: null, merge_status: null, merge_reason: null, merge_sha: null,
    ...over,
  }
}

function deployment(over: Record<string, unknown> = {}) {
  return {
    deployment_id: 'd0000000-0000-4000-8000-000000000001', repo: 'acme/app', target: 'dev', status: 'deploying',
    phase: 'deploying', pipeline_url: null, reason: null, updated_at: '2026-11-05T00:00:00Z', ...over,
  }
}

function message(id: number, body = `hello ${id}`) {
  return { id, repo: 'acme/app', from: 'dana@example.com', from_run_id: null, body, created_at: '2026-11-05T10:15:00Z' }
}

const CONTROL = {
  accounts: [{
    id: 'c1', provider: 'anthropic', kind: 'subscription_token', label: 'Claude', owner: 'you', health: 'ok',
    windows: [{ name: '5h', used_pct: 34, resets_at: null }, { name: '7d', used_pct: 61, resets_at: null }],
    observed_at: null, in_use: 1, engine_workers: 2, users: [],
  }],
  runs: [controlRun()],
  others: [{ name: 'Dana', active_runs: 2, models: { 'claude-opus-5-5': 2 } }],
  attention: [{ kind: 'deploy_approval', text: 'acme/app → prod waits for approval', url: null }],
  deployments: [deployment()],
  capacity: { org_active: 3, org_limit: 3, queued: 1, pods: 3, today: [{ name: 'you', tokens: 1000, cost_usd: 3.1 }], models: [] },
}

/** What the fake Swarm2 answers; a test changes it between polls. `control: null` is a server without /me/control. */
type Server = {
  control: Record<string, unknown> | null
  status: Record<string, unknown>
  /** Every request the pane made, when the test wants them. */
  calls?: { url: string; authorization: unknown }[]
}

function json(body: unknown, status = 200) {
  return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(body) : '' } }
}

type Answerer = (url: string, authorization: string, store: Map<string, unknown>) => ReturnType<typeof json> | undefined

function engine(
  on: On, server: Server, toasts: string[] = [], stored: string | null = 's2s_testtokentesttokentest',
  answer?: Answerer, store = new Map<string, unknown>(stored ? [['statusToken', stored]] : []),
) {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: (store.get(e.key) ?? null) as never }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    server.calls?.push({ url: e.url, authorization: (e.init?.headers as Record<string, string> | undefined)?.authorization })
    const custom = answer?.(e.url, String((e.init?.headers as Record<string, string> | undefined)?.authorization), store)
    if (custom) return custom
    if (e.url.endsWith('/me/control')) return server.control ? json(server.control) : json(null, 403)
    if (e.url.endsWith('/me/runs/status')) return json(server.status)
    return json(null, 404)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

/** Runs a slash command as the person typing it at the prompt does. */
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const has = async (ui: { find: (q: { type: string; text: RegExp }) => Promise<unknown> }, text: RegExp) =>
  expect((await ui.find({ type: 'Text', text })) ? 'found' : `missing ${text}`).toBe('found')

test('the control feed fills every section, messages from the status feed', async ($, on) => {
  engine(on, { control: CONTROL, status: { runs: [statusRun()], deployments: [deployment()], messages: [message(1, 'ship it')] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const text of [/ACCOUNTS/, /34%/, /⚙×2/, /NEEDS YOU/, /waits for approval/, /MY REPOS/, /claude-opus-5-5 ▸ Bash: bun test/,
      /OTHERS/, /Dana/, /DELIVERY/, /MESSAGES/, /ship it/, /dana@example\.com/, /CAPACITY/, /org 3\/3 running/]) {
      await has(ui, text)
    }
    expect(await ui.find({ type: 'Text', text: /basic feed/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a run shows its routing decision (requested, not observed); a run without one, or an older server, shows none', async ($, on) => {
  const routing = {
    difficulty: 5, classification_source: 'heuristic', provider: 'claude', model: 'claude-opus-5-5', effort: 'high',
    why: 'lowest expected cost; policy hard frontier high', reasons: ['Whole-repository scope'],
  }
  engine(on, { control: { ...CONTROL, runs: [controlRun({ routing }), controlRun({ run_id: '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', routing: { difficulty: 99 } })] },
    status: { runs: [statusRun()], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /d5 \(heuristic\) → claude \/ claude-opus-5-5 \/ high requested/)
  await has(ui, /policy hard frontier high/)
  // The malformed decision on the second run is dropped, not rendered.
  expect(await ui.find({ type: 'Text', text: /d99/ })).toBeUndefined()
  await ui.unmount()
})

const POOL_ACCOUNT = {
  id: 'p1', provider: 'openai', kind: 'api_key', label: 'Codex team key', owner: 'pool · Edi', health: 'ok',
  windows: [], observed_at: null, in_use: 0, engine_workers: 0, users: [],
}

const PROJECTS = [
  { repo: 'acme/app', role: 'owner', active_runs: 1, more_members: 3, members: [
    { name: 'Alex', role: 'owner', you: true, active_runs: 1 }, { name: 'Edi', role: 'maintainer', you: false, active_runs: 2 }] },
  { repo: 'acme/idle-repo', role: 'maintainer', active_runs: 0, more_members: 0, members: [
    { name: 'Alex', role: 'maintainer', you: true, active_runs: 0 }, { name: 'Ion', role: 'viewer', you: false, active_runs: 0 }] },
]

test('pool and projects: MY ACCOUNTS, ORG POOL on, every member repo with its members and runs', async ($, on) => {
  const UNLISTED = '99990000-eeee-4eee-8eee-eeeeeeeeeeee'
  const control = {
    ...CONTROL, accounts: [...CONTROL.accounts, POOL_ACCOUNT], pool: { enabled: true }, projects: PROJECTS,
    runs: [controlRun(), controlRun({ run_id: UNLISTED, repo: 'acme/other', mine: false, requester: 'Edi', workers: [] })],
  }
  engine(on, { control, status: { runs: [], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const text of [/MY ACCOUNTS/, /ORG POOL/, /— ON/, /1 account$/, /Codex team key/, /\(Edi\)/, /MY REPOS/, /2 repos · 2 running/,
      /owner · 1 running/, /idle-repo/, /maintainer · idle/, /\(you\)/, /Ion/, /viewer/, /×2/, /\+3 more/,
      /you · \[#+-*\] executing/, /claude-opus-5-5 ▸ Bash: bun test/, /acme\/other/, /Edi · \[#+-*\] executing/]) {
      await has(ui, text)
    }
    expect(await ui.find({ type: 'Text', text: /— OFF/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Nothing on your repos/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('pool off with no pool accounts, and an empty project list', async ($, on) => {
  engine(on, { control: { ...CONTROL, runs: [], pool: { enabled: false }, projects: [] }, status: { runs: [], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await has(ui, /— OFF/)
    await has(ui, /No accounts in the pool yet\./)
    await has(ui, /You are not a member of any project yet\./)
    await ui.unmount()
  }
})

test('a control feed without pool or projects keeps the run-based layout', async ($, on) => {
  engine(on, { control: CONTROL, status: { runs: [], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await has(ui, /ORG POOL/)
    await has(ui, /the organisation pool is off or empty/)
    await has(ui, /MY REPOS 1 running/)
    await has(ui, /acme\/app/)
    await has(ui, /claude-opus-5-5 ▸ Bash: bun test/)
    expect(await ui.find({ type: 'Text', text: /— ON|— OFF/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /\(you\)/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('an older server falls back to the status feed, messages included', async ($, on) => {
  const status = { runs: [statusRun({ status: 'blocked', status_reason: 'no Claude account', phase: 'queued' })], deployments: [],
    messages: [message(2, 'please review')] }
  engine(on, { control: null, status })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await has(ui, /no Claude account/)
    await has(ui, /basic feed/)
    await has(ui, /MESSAGES/)
    await has(ui, /please review/)
    await has(ui, /MY ACCOUNTS/)
    await has(ui, /Usage data needs a Swarm2 server with the control feed/)
    expect(await ui.find({ type: 'Text', text: /ORG POOL/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('no token asks for /swarm2-token, and /swarm2-token saves one', async ($, on) => {
  const toasts: string[] = []
  engine(on, { control: CONTROL, status: { runs: [], deployments: [], messages: [] } }, toasts, null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /No status token: run \/swarm2-token/)
  await ui.unmount()
  expect((await command($, 'swarm2-token', 'nope')).text).toContain('Usage: /swarm2-token')
  expect((await command($, 'swarm2-token', 's2s_abcdefghijklmnopqrst')).text).toContain('token saved')
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /ACCOUNTS/)
  expect(await ui.find({ type: 'Text', text: /No status token/ })).toBeUndefined()
  await ui.unmount()
})

test('run toasts: no replay on the first poll; PR, merge with SHA from the status feed, merge outcome, terminal status', async ($, on) => {
  const toasts: string[] = []
  const server: Server = {
    control: { ...CONTROL, attention: [], deployments: [], runs: [controlRun({ status: 'succeeded', phase: 'done', merge_status: 'merged' })] },
    status: { runs: [statusRun({ status: 'succeeded', phase: 'done', merge_status: 'merged', merge_sha: 'f'.repeat(40) })], deployments: [], messages: [] },
  }
  engine(on, server, toasts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(toasts).toEqual([])

  const poll = async (control: Record<string, unknown>, status: Record<string, unknown>) => {
    server.control = { ...CONTROL, attention: [], deployments: [], runs: [controlRun(control)] }
    server.status = { runs: [statusRun(status)], deployments: [], messages: [] }
    await command($, 'swarm2')
  }
  const OTHER = '87654321-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  // a second run, first seen now: it only records
  await poll({ run_id: OTHER, phase: 'executing' }, { run_id: OTHER })
  await poll({ run_id: OTHER, phase: 'publishing', pr_url: 'https://github.com/x/y/pull/7' },
    { run_id: OTHER, pr_url: 'https://github.com/x/y/pull/7' })
  // entering the merging phase announces nothing
  await poll({ run_id: OTHER, phase: 'merging', pr_url: 'https://github.com/x/y/pull/7', merge_status: 'pending' },
    { run_id: OTHER, pr_url: 'https://github.com/x/y/pull/7', merge_status: 'pending' })
  await poll({ run_id: OTHER, status: 'succeeded', phase: 'done', pr_url: 'https://github.com/x/y/pull/7', merge_status: 'merged' },
    { run_id: OTHER, status: 'succeeded', pr_url: 'https://github.com/x/y/pull/7', merge_status: 'merged', merge_sha: 'abcdef0123456789' })
  // merged again on the next poll: no second toast
  await poll({ run_id: OTHER, status: 'succeeded', phase: 'done', pr_url: 'https://github.com/x/y/pull/7', merge_status: 'merged' },
    { run_id: OTHER, status: 'succeeded', pr_url: 'https://github.com/x/y/pull/7', merge_status: 'merged', merge_sha: 'abcdef0123456789' })
  expect(toasts).toEqual([
    'Swarm2 87654321 opened a PR: https://github.com/x/y/pull/7',
    'Swarm2 87654321 merged (acme/app) · abcdef01',
  ])

  toasts.length = 0
  const THIRD = '11112222-cccc-4ccc-8ccc-cccccccccccc'
  await poll({ run_id: THIRD, phase: 'merging', merge_status: 'pending' }, { run_id: THIRD, merge_status: 'pending' })
  await poll({ run_id: THIRD, status: 'succeeded', phase: 'done', merge_status: 'merge_blocked' },
    { run_id: THIRD, status: 'succeeded', merge_status: 'merge_blocked', merge_reason: 'checks require attention' })
  expect(toasts).toEqual(['Swarm2 11112222 merge merge_blocked: checks require attention'])

  toasts.length = 0
  const FOURTH = '33334444-dddd-4ddd-8ddd-dddddddddddd'
  await poll({ run_id: FOURTH }, { run_id: FOURTH })
  await poll({ run_id: FOURTH, status: 'failed', status_reason: 'tests failed' }, { run_id: FOURTH, status: 'failed', status_reason: 'tests failed' })
  expect(toasts).toEqual(['Swarm2 33334444 failed: tests failed'])
})

test('deployment toasts: done, failed and a new prod request awaiting approval, never on the first poll', async ($, on) => {
  const toasts: string[] = []
  const server: Server = {
    control: { ...CONTROL, runs: [], attention: [], deployments: [deployment({ status: 'succeeded', phase: 'done' })] },
    status: { runs: [], deployments: [], messages: [] },
  }
  engine(on, server, toasts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(toasts).toEqual([])

  const set = (deployments: Record<string, unknown>[]) => {
    server.control = { ...CONTROL, runs: [], attention: [], deployments: deployments.map(deployment) }
  }
  const D2 = 'd0000000-0000-4000-8000-000000000002'
  const D3 = 'd0000000-0000-4000-8000-000000000003'
  const D4 = 'd0000000-0000-4000-8000-000000000004'
  set([{ deployment_id: D2 }])
  await command($, 'swarm2')
  set([{ deployment_id: D2, status: 'verifying', phase: 'verifying' }])
  await command($, 'swarm2')
  set([{ deployment_id: D2, status: 'succeeded', phase: 'done' }])
  await command($, 'swarm2')
  await command($, 'swarm2')
  set([{ deployment_id: D3, status: 'failed', phase: 'failed', reason: 'health check\nfailed' }])
  await command($, 'swarm2')
  set([{ deployment_id: D4, target: 'prod', status: 'awaiting_approval', phase: 'awaiting_approval' }])
  await command($, 'swarm2')
  expect(toasts).toEqual([
    'Swarm2 deploy acme/app → dev deployed',
    'Swarm2 deploy acme/app → dev failed (failed): health check failed',
    'Swarm2 deploy acme/app → prod awaiting approval',
  ])
})

test('message toasts: each new message once, more than three collapse, none on the first poll', async ($, on) => {
  const toasts: string[] = []
  const server: Server = { control: { ...CONTROL, runs: [], attention: [], deployments: [] }, status: { runs: [], deployments: [], messages: [message(1)] } }
  engine(on, server, toasts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(toasts).toEqual([])

  server.status = { runs: [], deployments: [], messages: [message(3), message(2), message(1)] }
  await command($, 'swarm2')
  await command($, 'swarm2')
  expect(toasts).toEqual([
    'Swarm2 message acme/app · dana@example.com: hello 2',
    'Swarm2 message acme/app · dana@example.com: hello 3',
  ])

  toasts.length = 0
  server.status = { runs: [], deployments: [], messages: [4, 5, 6, 7, 8].map(id => message(id)).concat([message(3)]) }
  await command($, 'swarm2')
  expect(toasts).toEqual(['Swarm2: 5 new project messages (acme/app)'])
})

test('a feed an earlier version stored is read as empty', async ($, on) => {
  on('state.get', () => ({ value: { value: { runs: [], error: null, checkedAt: null }, version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await has(ui, /connecting…/)
  await ui.unmount()
})

test('the userConfig status token is used against the prod URL by default', { options: { statusToken: 's2s_configuredconfiguredtoken' } }, async ($, on) => {
  const server: Server = { control: null, status: { runs: [], deployments: [], messages: [] }, calls: [] }
  engine(on, server, [], null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const urls = server.calls!.map(c => c.url)
  expect(urls).toContain('https://swarm2-mcp.netconnect.ro/me/control')
  expect(urls).toContain('https://swarm2-mcp.netconnect.ro/me/runs/status')
  for (const c of server.calls!) expect(c.authorization).toBe('Bearer s2s_configuredconfiguredtoken')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /● PROD/ })) ? 'found' : 'missing ● PROD').toBe('found')
  expect((await ui.find({ type: 'Text', text: /plugin v0\.4\.0/ })) ? 'found' : 'missing plugin version').toBe('found')
  await ui.unmount()
})

test('a custom base URL is labelled with its host in the pane', { options: { statusToken: 's2s_configuredconfiguredtoken', baseUrl: 'https://swarm2.example' } }, async ($, on) => {
  const server: Server = { control: null, status: { runs: [], deployments: [], messages: [] }, calls: [] }
  engine(on, server, [], null)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /● swarm2\.example/ })) ? 'found' : 'missing custom host').toBe('found')
  await ui.unmount()
})

test('quota waits show NEEDS YOU, paused phase and retry time on control feed', async ($, on) => {
  const retry = '2026-11-07T12:00:00Z'
  const waiting = { status: 'waiting_quota', phase: 'waiting_quota', quota_resume_at: retry, workers: [] }
  engine(on, { control: { ...CONTROL, runs: [controlRun(waiting)],
    accounts: [{ ...CONTROL.accounts[0]!, health: 'cooling', windows: [{ name: '_quota', used_pct: null, resets_at: retry }] }],
    attention: [{ kind: 'run_quota', text: `Waiting for quota; earliest retry ${retry}`, url: null }] },
    status: { runs: [statusRun(waiting)] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const text of [/NEEDS YOU/, /\[ paused \]/, /waiting for quota/, /Earliest automatic retry 2026-11-07T12:00:00Z/, /quota cooldown/, /until 2026-11-07T12:00:00Z/]) await has(ui, text)
  await ui.unmount()
})

test('status fallback synthesizes quota attention with unknown retry time', async ($, on) => {
  engine(on, { control: null, status: { runs: [statusRun({ status: 'waiting_quota', phase: 'waiting_quota' })] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const text of [/NEEDS YOU/, /waiting for quota/, /Automatic retry pending/]) await has(ui, text)
  await ui.unmount()
})


test('external observations render and toast through control and legacy status fallback', async ($, on) => {
  const toasts: string[] = []
  const observation = { source: 'external', outcome: null, merge_sha: 'abcdef12' + 'a'.repeat(32), status: 'verifying', phase: 'verifying' }
  const server: Server = { control: { ...CONTROL, runs: [], attention: [], deployments: [deployment(observation)] },
    status: { runs: [], deployments: [], messages: [] } }
  engine(on, server, toasts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /external · observing · merged abcdef12/)
  expect(toasts).toEqual([])
  for (const [status, outcome, label] of [['succeeded', 'ok', 'ok'], ['failed', 'failed', 'failed'],
    ['failed', 'timeout', 'timeout'], ['cancelled', null, 'cancelled']] as const) {
    const row = deployment({ ...observation, status, outcome, phase: status === 'succeeded' ? 'done' : 'failed' })
    server.control = { ...CONTROL, runs: [], attention: [], deployments: [row] }
    await command($, 'swarm2')
    await has(ui, new RegExp(`external · observed · ${label} · merged abcdef12`))
    expect(toasts[toasts.length - 1]).toBe(`Swarm2 observation acme/app → dev observed · ${label} · merged abcdef12`)
    await command($, 'swarm2')
  }
  expect(toasts.length).toBe(4)
  server.control = null
  server.status = { runs: [], deployments: [deployment(observation)], messages: [] }
  await command($, 'swarm2')
  await has(ui, /external · observing · merged abcdef12/)
  await ui.unmount()
})

// ---- status token: precedence, 401 recovery ----
const EMPTY_STATUS = { runs: [], deployments: [], messages: [] }
const bearers = (calls: Server['calls']) => calls!.map(c => String(c.authorization))

test('401, then the token is rotated in the store: one retry with the new token, the pane shows data', async ($, on) => {
  const OLD = 's2s_oldoldoldoldoldoldold'
  const NEW = 's2s_newnewnewnewnewnewnew'
  const calls: NonNullable<Server['calls']> = []
  // the server rejects the old token; a rotation (as another session's /swarm2-token would do) lands in the store mid-poll
  engine(on, { control: CONTROL, status: EMPTY_STATUS, calls }, [], OLD, (_, auth, store) => {
    if (auth !== `Bearer ${OLD}`) return undefined
    store.set('statusToken', NEW)
    return json(null, 401)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // clock.every is a no-op here, so the only poll so far is the session's own: a NEW-token request proves the in-poll retry
  for (let i = 0; i < 50 && !bearers(calls).includes(`Bearer ${NEW}`); i++) await new Promise(r => (globalThis as unknown as { setTimeout: (f: (v?: unknown) => void, ms: number) => unknown }).setTimeout(r, 20))
  expect(bearers(calls)).toContain(`Bearer ${NEW}`)
  await command($, 'swarm2')
  calls.length = 0
  await command($, 'swarm2') // settled: the stored token is now the new one
  expect(bearers(calls).length).toBe(2)
  expect(bearers(calls).every(b => b === `Bearer ${NEW}`)).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /ACCOUNTS/)
  expect(await ui.find({ type: 'Text', text: /rejected|HTTP 401/ })).toBeUndefined()
  await ui.unmount()
})

test('401 with an unchanged token: no retry, a clear message with the link, never the token', async ($, on) => {
  const TOKEN = 's2s_rejectedrejectedrejected'
  const server: Server = { control: CONTROL, status: EMPTY_STATUS, calls: [] }
  const toasts: string[] = []
  engine(on, server, toasts, TOKEN, () => json(null, 401))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2') // let the session's own poll settle
  const before = server.calls!.length
  await command($, 'swarm2')
  const made = server.calls!.slice(before)
  expect(made.length).toBe(2) // one control + one status request, no retry
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /status token rejected/)
  await has(ui, /https:\/\/swarm2-mcp\.netconnect\.ro\/me\/status-tokens/)
  expect(await ui.find({ type: 'Text', text: new RegExp(TOKEN) })).toBeUndefined()
  expect(toasts.join('\n')).not.toContain(TOKEN)
  await ui.unmount()
})

test('/swarm2-token overrides a stale configured option, and clear falls back to it', { options: { statusToken: 's2s_staleconfiguredstaleconfigured' } }, async ($, on) => {
  const server: Server = { control: CONTROL, status: EMPTY_STATUS, calls: [] }
  engine(on, server, [], null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(bearers(server.calls).every(b => b === 'Bearer s2s_staleconfiguredstaleconfigured')).toBe(true)
  server.calls!.length = 0
  await command($, 'swarm2-token', 's2s_freshsavedfreshsavedfresh')
  expect(bearers(server.calls).length).toBeGreaterThan(0)
  expect(bearers(server.calls).every(b => b === 'Bearer s2s_freshsavedfreshsavedfresh')).toBe(true)
  server.calls!.length = 0
  expect((await command($, 'swarm2-token', 'clear')).text).toContain('removed')
  expect(bearers(server.calls).length).toBeGreaterThan(0)
  expect(bearers(server.calls).every(b => b === 'Bearer s2s_staleconfiguredstaleconfigured')).toBe(true)
})

test('a stale stored token from an earlier session never shadows a valid configured setting', { options: { statusToken: 's2s_validconfiguredvalidconfigured' } }, async ($, on) => {
  const STALE = 's2s_stalestoredstalestoredstale'
  const server: Server = { control: CONTROL, status: EMPTY_STATUS, calls: [] }
  engine(on, server, [], STALE, (_, auth) => auth === `Bearer ${STALE}` ? json(null, 401) : undefined)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(bearers(server.calls).every(b => b === 'Bearer s2s_validconfiguredvalidconfigured')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /ACCOUNTS/)
  expect(await ui.find({ type: 'Text', text: /rejected/ })).toBeUndefined()
  await ui.unmount()
})

test('a token saved in this session is tried first; when rejected, the configured setting is tried once', { options: { statusToken: 's2s_validconfiguredvalidconfigured' } }, async ($, on) => {
  const BAD = 's2s_badsavedbadsavedbadsaved'
  const server: Server = { control: CONTROL, status: EMPTY_STATUS, calls: [] }
  engine(on, server, [], null, (_, auth) => auth === `Bearer ${BAD}` ? json(null, 401) : undefined)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  server.calls!.length = 0
  await command($, 'swarm2-token', BAD)
  const used = bearers(server.calls)
  expect(used[0]).toBe(`Bearer ${BAD}`)
  expect(used).toContain('Bearer s2s_validconfiguredvalidconfigured')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /rejected/ })).toBeUndefined()
  await ui.unmount()
})

test('every candidate rejected: the message points at /swarm2-token clear', { options: { statusToken: 's2s_rejectedconfiguredrejected' } }, async ($, on) => {
  const server: Server = { control: CONTROL, status: EMPTY_STATUS, calls: [] }
  engine(on, server, [], 's2s_rejectedstoredrejectedstored', () => json(null, 401))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /status token rejected/)
  await has(ui, /swarm2-token clear/)
  await ui.unmount()
})

test('a 401 on the control feed alone keeps the status-feed render', async ($, on) => {
  const server: Server = { control: CONTROL, status: EMPTY_STATUS, calls: [] }
  engine(on, server, [], 's2s_testtokentesttokentest', (url) => url.endsWith('/me/control') ? json(null, 401) : undefined)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /status token rejected/ })).toBeUndefined()
  await has(ui, /control feed answered HTTP 401/)
  await ui.unmount()
})
