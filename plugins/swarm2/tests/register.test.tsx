import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ConfigRow, On } from 'claude-code'

import { flushPluginReports } from '../hooks/plugin-report'
import { PLUGIN_VERSION, consumptionLine } from '../hooks/register'

// the host test runtime's timer, reached through globalThis (the plugin's type contract declares no ambient globals)
const sleep = (ms: number) => new Promise(r => (globalThis as unknown as { setTimeout: (f: (v?: unknown) => void, ms: number) => unknown }).setTimeout(r, ms))

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
  /** Every plugin report (/me/plugin/report) the plugin sent, when the test wants them. */
  reports?: { url: string; authorization: unknown }[]
}

function json(body: unknown, status = 200) {
  return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(body) : '' } }
}

type Answerer = (url: string, authorization: string, store: Map<string, unknown>) => ReturnType<typeof json> | undefined

/** The `/config` row of the sensitive statusToken field as the host keeps it: `$.config.set` writes it, `list` reads it back. */
function statusTokenRow(value = ''): ConfigRow {
  return { key: 'swarm2.statusToken', label: 'Swarm2 status token', kind: 'text', value, provider: { plugin: 'swarm2', tier: 'user' }, isLocked: false }
}

function engine(
  on: On, server: Server, toasts: string[] = [], stored: string | null = 's2s_testtokentesttokentest',
  answer?: Answerer, store = new Map<string, unknown>(stored ? [['statusToken', stored]] : []),
  config = new Map<string, ConfigRow>([['swarm2.statusToken', statusTokenRow()]]),
  /** true: the test's mock.clock answers $.clock; otherwise every clock.every is a no-op */
  mockClock = false,
) {
  const seen = { registered: [] as string[], opened: [] as string[] }
  on('config.list', () => ({ value: [...config.values()] }))
  on('config.set', (_, e) => {
    const row = config.get(e.key)
    if (!row) return { deny: `no row ${e.key}` }
    config.set(e.key, { ...row, value: e.value })
    return { value: e.value }
  })
  on('command.register', (_, e) => { seen.registered.push(e.name); return { value: { command: e.name } } })
  on('ui.open', (_, e) => { seen.opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  if (!mockClock) on('clock.every', () => ({ value: undefined }))
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
    // the plugin report (plan_only client gate) runs in the background; pane tests count only the feed requests
    if (e.url.endsWith('/me/plugin/report')) {
      server.reports?.push({ url: e.url, authorization: (e.init?.headers as Record<string, string> | undefined)?.authorization })
      return json({ ok: true })
    }
    server.calls?.push({ url: e.url, authorization: (e.init?.headers as Record<string, string> | undefined)?.authorization })
    const custom = answer?.(e.url, String((e.init?.headers as Record<string, string> | undefined)?.authorization), store)
    if (custom) return custom
    if (e.url.endsWith('/me/control')) return server.control ? json(server.control) : json(null, 403)
    if (e.url.endsWith('/me/runs/status')) return json(server.status)
    return json(null, 404)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return seen
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

// The host lifecycle end to end: the poll and the spinner run on $.clock (the kit's clock here), and session.end leaves none.
test('session.start registers /swarm2, the command opens and draws the pane, the feed polls on the clock, session.end cancels it', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const server: Server = { control: CONTROL, status: { runs: [statusRun()], deployments: [], messages: [] }, calls: [] }
  const { registered, opened } = engine(on, server, [], undefined, undefined, undefined, undefined, true)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toContain('swarm2')
  expect((await command($, 'swarm2')).text).toBe('Swarm2 pane opened.')
  expect(opened.filter(id => id === 'swarm2').length).toBeGreaterThanOrEqual(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /ACCOUNTS/)
  // each period is one control + one status request
  await clock.settle()
  let before = server.calls!.length
  await clock.advance(5000)
  expect(server.calls!.length - before).toBe(2)
  before = server.calls!.length
  await clock.advance(5000)
  expect(server.calls!.length - before).toBe(2)
  await ui.unmount()
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  before = server.calls!.length
  await clock.advance(60_000)
  expect(server.calls!.length).toBe(before)
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

test('a run waiting for paths shows the blocking run and says it starts by itself', async ($, on) => {
  const BLOCKER = '0b1c2d3e-0000-4000-8000-000000000001'
  const waiting = controlRun({ status: 'queued', status_reason: 'waiting_for_paths', phase: 'queued', workers: [],
    waiting_for_paths: { blocking_run_id: BLOCKER, blocking_pattern: 'src/auth/**' } })
  engine(on, { control: { ...CONTROL, runs: [waiting] }, status: { runs: [], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /waiting for paths/)
  await has(ui, /Waiting for paths src\/auth\/\*\* held by run 0b1c2d3e; it starts automatically, do not resubmit/)
  expect(await ui.find({ type: 'Text', text: /^\s*waiting_for_paths$/ })).toBeUndefined()
  await ui.unmount()
})

test('an older server without waiting_for_paths still shows a queued waiting run', async ($, on) => {
  const status = { runs: [statusRun({ status: 'queued', status_reason: 'waiting_for_paths', phase: 'queued' })], deployments: [], messages: [] }
  engine(on, { control: null, status })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /Waiting for paths held by another run; it starts automatically/)
  await ui.unmount()
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
  expect((await ui.find({ type: 'Text', text: new RegExp(`plugin v${PLUGIN_VERSION.replace(/\./g, '\\.')}`) })) ? 'found' : 'missing plugin version').toBe('found')
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
  for (const text of [/NEEDS YOU/, /\[ paused \]/, /waiting for quota/, /Earliest automatic retry 2026-11-07T12:00:00Z/, /cooldown ↻\d\d:\d\d/]) await has(ui, text)
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
  // the server rejects the old token; a rotation (as an older version's /swarm2-token would do) lands in the store mid-poll.
  // Secure storage is unavailable here (no sensitive row), so the plain copy stays the only credential and is never moved.
  engine(on, { control: CONTROL, status: EMPTY_STATUS, calls }, [], OLD, (_, auth, store) => {
    if (auth !== `Bearer ${OLD}`) return undefined
    store.set('statusToken', NEW)
    return json(null, 401)
  }, undefined, new Map())
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

// ---- secure migration of a plain token from an older version ----
const PROD = 'https://swarm2-mcp.netconnect.ro'
const LEGACY = 's2s_legacylegacylegacylegacy'

function migrationEngine(on: On, scope: unknown, config = new Map<string, ConfigRow>([['swarm2.statusToken', statusTokenRow()]]), toasts: string[] = []) {
  const server: Server = { control: CONTROL, status: EMPTY_STATUS, calls: [] }
  const store = new Map<string, unknown>([['statusToken', LEGACY], ...(scope ? [['statusTokenScope', scope] as [string, unknown]] : [])])
  engine(on, server, toasts, null, undefined, store, config)
  return { server, store, config, toasts }
}

test('a plain token of this origin and profile moves to secure storage, is used, and the plain copy goes', async ($, on) => {
  const m = migrationEngine(on, { origin: PROD, profile: 'default' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(m.config.get('swarm2.statusToken')?.value).toBe(LEGACY)
  expect(m.store.has('statusToken')).toBe(false)
  expect(m.store.has('statusTokenScope')).toBe(false)
  expect(bearers(m.server.calls).length).toBeGreaterThan(0)
  expect(bearers(m.server.calls).every(b => b === `Bearer ${LEGACY}`)).toBe(true)
  expect(m.toasts).toEqual([])
})

for (const scope of [{ origin: 'https://other.example', profile: 'default' }, { origin: PROD, profile: 'work' }]) {
  test(`a plain token saved for ${scope.origin} profile ${scope.profile} never migrates and is never sent`, async ($, on) => {
    const m = migrationEngine(on, scope)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await command($, 'swarm2')
    expect(m.config.get('swarm2.statusToken')?.value).toBe('')
    expect(m.store.get('statusToken')).toBe(LEGACY)
    expect(m.store.get('statusTokenScope')).toEqual(scope)
    expect(bearers(m.server.calls)).toEqual([])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await has(ui, /No status token/)
    await ui.unmount()
  })
}

for (const scope of ['https://other.example#work', { origin: PROD }, { origin: PROD, profile: 7 }]) {
  test(`a malformed plain-token scope ${JSON.stringify(scope)} is never legacy: never migrated and never sent`, async ($, on) => {
    const m = migrationEngine(on, scope)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await command($, 'swarm2')
    expect(m.config.get('swarm2.statusToken')?.value).toBe('')
    expect(m.store.get('statusToken')).toBe(LEGACY)
    expect(m.store.get('statusTokenScope')).toEqual(scope)
    expect(bearers(m.server.calls)).toEqual([])
  })
}

test('a session that starts again never overwrites a token saved with /swarm2-token by a leftover plain one', async ($, on) => {
  const NEW = 's2s_newnewnewnewnewnewnewnew'
  const m = migrationEngine(on, null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(m.config.get('swarm2.statusToken')?.value).toBe(LEGACY)
  expect((await command($, 'swarm2-token', NEW)).text).toContain('saved')
  expect(m.config.get('swarm2.statusToken')?.value).toBe(NEW)
  m.store.set('statusToken', LEGACY) // a plain copy left behind (an older version in another session wrote it again)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }) // /clear or resume
  expect(m.config.get('swarm2.statusToken')?.value).toBe(NEW)
  expect(m.store.get('statusToken')).toBe(LEGACY)
  expect(m.toasts).toEqual([])
})

test('a token saved with /swarm2-token over a configured one is still used by the next session: report and both feeds', { options: { statusToken: 's2s_old-token-1-fixture' } }, async ($, on) => {
  const OLD = 's2s_old-token-1-fixture'
  const NEW = 's2s_new-token-2-fixture'
  const server: Server = { control: CONTROL, status: EMPTY_STATUS, calls: [], reports: [] }
  const config = new Map([['swarm2.statusToken', statusTokenRow(OLD)]])
  engine(on, server, [], null, undefined, undefined, config)
  let sessionId = 'sess-1'
  on('session.id', () => ({ value: sessionId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(bearers(server.calls).length).toBeGreaterThan(0)
  expect(bearers(server.calls).every(b => b === `Bearer ${OLD}`)).toBe(true)
  expect((await command($, 'swarm2-token', NEW)).text).toContain('saved')
  expect(config.get('swarm2.statusToken')?.value).toBe(NEW) // written to secure storage and read back
  await flushPluginReports()
  await sleep(10)
  // the second session (/clear or resume) in the same module and configuration: only its requests count
  server.calls!.length = 0
  server.reports!.length = 0
  sessionId = 'sess-2' // a new session id: its plugin report is due at once
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  await flushPluginReports()
  await sleep(10)
  // per path: how many requests session 2 made, and how many carried a bearer other than the new one (an empty list fails)
  const seen = (path: string) => {
    const used = [...server.calls!, ...server.reports!].filter(c => c.url.endsWith(path)).map(c => String(c.authorization))
    return { requests: used.length > 0, notNew: used.filter(b => b !== `Bearer ${NEW}`).length, old: used.filter(b => b === `Bearer ${OLD}`).length }
  }
  expect({ report: seen('/me/plugin/report'), control: seen('/me/control'), status: seen('/me/runs/status') }).toEqual({
    report: { requests: true, notNew: 0, old: 0 }, control: { requests: true, notNew: 0, old: 0 }, status: { requests: true, notNew: 0, old: 0 },
  })
  expect(config.get('swarm2.statusToken')?.value).toBe(NEW)
})

test('a configured token is never overwritten to migrate a different plain one; the plain copy stays its fallback', { options: { statusToken: 's2s_configuredconfiguredtoken' } }, async ($, on) => {
  const m = migrationEngine(on, null, new Map([['swarm2.statusToken', statusTokenRow('s2s_configuredconfiguredtoken')]]))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(m.config.get('swarm2.statusToken')?.value).toBe('s2s_configuredconfiguredtoken')
  expect(m.store.get('statusToken')).toBe(LEGACY)
  expect(bearers(m.server.calls).every(b => b === 'Bearer s2s_configuredconfiguredtoken')).toBe(true)
  expect(m.toasts).toEqual([])
})

test('secure storage refusing the token keeps the plain copy in use and asks for /config', async ($, on) => {
  const m = migrationEngine(on, null, new Map())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  expect(m.store.get('statusToken')).toBe(LEGACY)
  expect(m.toasts.some(t => t.includes('migration_required'))).toBe(true)
  expect(m.toasts.join('\n')).not.toContain(LEGACY)
  expect(bearers(m.server.calls).every(b => b === `Bearer ${LEGACY}`)).toBe(true)
})

test('/swarm2-token clear without a save in this session removes the plain copy and never the configured setting', { options: { statusToken: 's2s_configuredconfiguredtoken' } }, async ($, on) => {
  const m = migrationEngine(on, null, new Map([['swarm2.statusToken', statusTokenRow('s2s_configuredconfiguredtoken')]]))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  m.server.calls!.length = 0
  expect((await command($, 'swarm2-token', 'clear')).text).toContain('removed')
  expect(m.store.has('statusToken')).toBe(false)
  expect(m.config.get('swarm2.statusToken')?.value).toBe('s2s_configuredconfiguredtoken')
  expect(bearers(m.server.calls).length).toBeGreaterThan(0)
  expect(bearers(m.server.calls).every(b => b === 'Bearer s2s_configuredconfiguredtoken')).toBe(true)
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

test('the control feed projects are cached with role and plan_only (plan_only absent = false)', async ($, on) => {
  const store = new Map<string, unknown>([['statusToken', 's2s_testtokentesttokentest']])
  const projects = [
    { ...PROJECTS[0]!, repo: 'Acme/Plan', role: 'developer', plan_only: true },
    { ...PROJECTS[1]!, repo: 'acme/legacy', role: 'owner' }, // an older server sends no plan_only
  ]
  engine(on, { control: { ...CONTROL, runs: [], projects }, status: { runs: [], deployments: [], messages: [] } }, [], null, undefined, store)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const c = store.get('guardProjects') as { repos: string[]; meta: Record<string, unknown> }
  expect(c.repos).toEqual(['acme/legacy', 'acme/plan'])
  expect(c.meta).toEqual({ 'acme/plan': { role: 'developer', plan_only: true }, 'acme/legacy': { role: 'owner', plan_only: false } })
})

// ---- usage figures that stopped being true ----

async function paneHas(ui: Parameters<typeof has>[0], text: RegExp, present = true) {
  expect(Boolean(await ui.find({ type: 'Text', text }))).toBe(present)
}

test('expired window, stale account, not-measured and no-figure-yet strings; an old server without the new fields still renders', async ($, on) => {
  const ago3h = new Date(Date.now() - 3 * 3_600_000).toISOString()
  const base = CONTROL.accounts[0]!
  const control = {
    ...CONTROL,
    accounts: [
      { ...base, id: 'e1', label: 'Expired', windows: [{ name: '5h', used_pct: null, resets_at: ago3h, expired: true, observed_at: ago3h }, { name: '7d', used_pct: 61, resets_at: null }] },
      { ...base, id: 'e2', label: 'Stale one', stale: true, observed_at: ago3h, windows: [{ name: 'primary', used_pct: 20, resets_at: null }] },
      { ...base, id: 'e3', label: 'Deep', provider: 'deepseek', kind: 'api_key', measurement: 'not_measurable', windows: [] },
      { ...base, id: 'e4', label: 'Fresh', measurement: 'measured', windows: [] },
      { ...base, id: 'e5', label: 'Old server', windows: [] },
      { ...base, id: 'e6', label: 'No time', observed_at: null, windows: [{ name: '7d', used_pct: null, resets_at: ago3h, expired: true }] },
    ],
  }
  engine(on, { control, status: { runs: [], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // an expired window has reset (#213): a 5 h one starts again on the next use, so no next reset is invented for it
  await has(ui, /5h ✓ reset/)
  await paneHas(ui, /5h ✓ reset · next/, false)
  await has(ui, /7d ✓ reset · next ↻/)
  await paneHas(ui, /5h ▓|5h \?/, false)
  await has(ui, /7d .* 61%/)
  await has(ui, /stale/)
  await has(ui, /primary window/)
  await has(ui, /usage not measured for this provider/)
  expect((await ui.findAll({ type: 'Text', text: /^no usage figure yet$/ })).length).toBe(2) // the inner Text, not the row around it
  await ui.unmount()
})

test('a not_measurable account with consumption shows what it used (runs, tokens), never a percentage; malformed or absent falls back', async ($, on) => {
  const ago2h = new Date(Date.now() - 2 * 3_600_000).toISOString()
  const base = CONTROL.accounts[0]!
  const consumption = { usage_kind: 'consumed', last_24h: { runs: 12, input_tokens: 1_200_000, output_tokens: 200_000, cached_input_tokens: 90_000 },
    last_7d: { runs: 40, input_tokens: 4_000_000, output_tokens: 1_000_000, cached_input_tokens: null }, last_used_at: ago2h }
  const control = {
    ...CONTROL,
    accounts: [
      { ...base, id: 'g1', label: 'Agy', provider: 'antigravity', kind: 'subscription_token', measurement: 'not_measurable', windows: [], consumption },
      { ...base, id: 'g2', label: 'Agy bad', provider: 'antigravity', kind: 'subscription_token', measurement: 'not_measurable', windows: [],
        consumption: { usage_kind: 'consumed', last_24h: { runs: -1 }, last_7d: null, last_used_at: null } },
    ],
  }
  engine(on, { control, status: { runs: [], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /Antigravity: 12 runs · 1\.4M tok \(24 h\) · 40 runs · 5\.0M tok \(7 d\) · last 2h00 ago/)
  await has(ui, /usage not measured for this provider/) // the malformed one
  await paneHas(ui, /Antigravity: .*%/, false)
  await ui.unmount()
  expect(consumptionLine({ provider: 'antigravity', consumption: { ...consumption, last_24h: { ...consumption.last_24h, runs: 1 }, last_used_at: null } } as never))
    .toBe('Antigravity: 1 run · 1.4M tok (24 h) · 40 runs · 5.0M tok (7 d)')
  expect(consumptionLine({ provider: 'antigravity' } as never)).toBeNull()
  expect(consumptionLine({ provider: 'x', consumption: { ...consumption, usage_kind: 'pct' } } as never)).toBeNull()
})

test('cost: a run shows tokens and API-equivalent cost (~ when partial, cost unknown when null), today shows unknown not $0.00, the label is the footnote', async ($, on) => {
  const label = 'API-equivalent at list price — subscriptions are not billed per token'
  const control = {
    ...CONTROL,
    runs: [controlRun({ tokens: 12_000, cost_usd: 1.5, cost_partial: true, cost_label: label }), controlRun({ run_id: '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa', goal: 'other', tokens: 500, cost_usd: null, cost_partial: null, cost_label: label })],
    capacity: { ...CONTROL.capacity, today_total: { tokens: 15_000, cost_usd: null, unknown_cost_executions: 2, partial: true, cost_label: label } },
  }
  engine(on, { control, status: { runs: [statusRun()], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /12k tok · ~\$1\.50 API-eq/)
  await has(ui, /500 tok · cost unknown/)
  await has(ui, /today unknown · 15k tok/)
  await paneHas(ui, /today \$0\.00/, false)
  await has(ui, /Costs: API-equivalent at list price/)
  await ui.unmount()
})

async function footer(latest: unknown, attention: unknown[] = []) {
  return { ...CONTROL, runs: [], attention, deployments: [], ...(latest === undefined ? {} : { plugin_latest: latest }) }
}

test('the footer shows the latest version only when the plugin is older', async ($, on) => {
  const server: Server = { control: await footer('99.0.0'), status: { runs: [], deployments: [], messages: [] } }
  engine(on, server)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /\(latest v99\.0\.0\)/)
  await ui.unmount()
})

for (const latest of ['0.0.1', PLUGIN_VERSION, 'banana', null, undefined]) {
  test(`no latest-version suffix for plugin_latest ${String(latest)}`, async ($, on) => {
    engine(on, { control: await footer(latest), status: { runs: [], deployments: [], messages: [] } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await command($, 'swarm2')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await has(ui, /plugin v/)
    expect(await ui.find({ type: 'Text', text: /\(latest v/ })).toBeFalsy()
    await ui.unmount()
  })
}

test('a plugin_outdated attention item shows its text with the update command', async ($, on) => {
  // a latest version strictly newer than this artifact's, whatever version staging wrote into PLUGIN_VERSION
  const [major, minor] = PLUGIN_VERSION.split('.').map(Number)
  const latest = `${major}.${minor! + 1}.0`
  const text = `Swarm2 plugin v${PLUGIN_VERSION} is out of date (latest v${latest}). Update: claude plugin update swarm2@netconnect, then /reload-plugins.`
  engine(on, { control: await footer(latest, [{ kind: 'plugin_outdated', id: 'plugin_outdated', text, url: null }]), status: { runs: [], deployments: [], messages: [] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /NEEDS YOU/)
  await has(ui, /claude plugin update swarm2@netconnect/)
  await ui.unmount()
})

// ---- run speed ----

const TIMINGS = 'https://swarm2-mcp.netconnect.ro/me/projects'
const OTHER_RUN = '77777777-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function speed(over: Record<string, unknown> = {}) {
  return {
    window_days: 7, since: '2026-11-15T00:00:00Z', until: '2026-11-22T00:00:00Z',
    runs: [{
      run_id: RUN_ID, repo: 'acme/app', outcome: 'succeeded', total_seconds: 1500,
      stages: [{ stage: 'executing', count: 1, p50: 900, p90: 900 }, { stage: 'verifying', count: 1, p50: 240, p90: 240 }],
      deploy: { seconds: 180, status: 'succeeded', environment: 'dev' }, url: `${TIMINGS}/p1/timings?run=${RUN_ID}`,
    }],
    aggregate: { runs: 12, stages: [{ stage: 'executing', count: 12, p50: 600, p90: 1800 }], url: `${TIMINGS}/p1/timings` },
    top_waits: [
      { stage: 'queue_wait', seconds: 420, repo: 'acme/app', own: true, run_id: RUN_ID, url: `${TIMINGS}/p1/timings?run=${RUN_ID}` },
      // another user's wait: no run id, a project-level link (a run id the server sent by mistake is dropped)
      { stage: 'quota_wait', seconds: 3900, repo: 'acme/api', own: false, run_id: OTHER_RUN, url: `${TIMINGS}/p2/timings` },
    ],
    slow_projects: [{ project_id: 'p2', repo: 'acme/api', runs: 5, p50: 2400, p90: 4200, url: `${TIMINGS}/p2/timings` }],
    org_url: 'https://swarm2-mcp.netconnect.ro/me/org?speed',
    ...over,
  }
}

async function speedPane($: Engine, on: On, control: Record<string, unknown>) {
  engine(on, { control, status: EMPTY_STATUS })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  return $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
}

test('speed: own runs with stages and deploy, aggregate p50/p90, top waits and slow projects, each with its link', async ($, on) => {
  const ui = await speedPane($, on, { ...CONTROL, speed: speed() })
  await has(ui, /SPEED.*last 7 d/)
  await has(ui, /acme\/app 25m/)
  await has(ui, /12345678 · executing 15m · verifying 4m · deploy 3m succeeded \(dev\)/)
  await has(ui, new RegExp(`timings\\?run=${RUN_ID}`))
  await has(ui, /all 12 runs p50\/p90 · executing 10m\/30m .*\/p1\/timings$/)
  await has(ui, /queue_wait 7m acme\/app · you 12345678 /)
  await has(ui, /quota_wait 1h05 acme\/api · another run .*\/p2\/timings$/)
  await paneHas(ui, new RegExp(OTHER_RUN.slice(0, 8)), false)
  await has(ui, /acme\/api 5 runs · p50 40m · p90 1h10 .*\/p2\/timings$/)
  await has(ui, /org speed .*\/me\/org\?speed/)
  await ui.unmount()
})

test('speed: a null deploy time shows ?, no deploy shows nothing, a malformed run or wait is dropped alone', async ($, on) => {
  const base = speed()
  const control = {
    ...CONTROL, speed: speed({
      runs: [
        { ...base.runs[0], deploy: { seconds: null, status: 'deploying', environment: null } },
        { ...base.runs[0], run_id: '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repo: 'acme/web', deploy: null, stages: [] },
        { ...base.runs[0], url: 'javascript:alert(1)', repo: 'acme/bad' },
      ],
      top_waits: [{ stage: 'quota_wait', repo: 'acme/api', own: false, run_id: null, url: `${TIMINGS}/p2/timings` }, base.top_waits[1]],
      org_url: null,
    }),
  }
  const ui = await speedPane($, on, control)
  await has(ui, /deploy \? deploying/)
  await has(ui, /acme\/web 25m/)
  await paneHas(ui, /acme\/web .*deploy/, false)
  await paneHas(ui, /acme\/bad/, false)
  expect((await ui.findAll({ type: 'Text', text: /quota_wait/ })).length).toBe(1)
  await paneHas(ui, /org speed/, false)
  await ui.unmount()
})

for (const value of [undefined, null, 'fast', { window_days: 'x' }]) {
  test(`speed: ${JSON.stringify(value) ?? 'an old feed without it'} draws no SPEED and the rest of the pane`, async ($, on) => {
    const ui = await speedPane($, on, value === undefined ? CONTROL : { ...CONTROL, speed: value })
    await has(ui, /MY REPOS/)
    await paneHas(ui, /SPEED/, false)
    await ui.unmount()
  })
}

test('speed: an empty projection says there is no timing data', async ($, on) => {
  const ui = await speedPane($, on, { ...CONTROL, speed: speed({ runs: [], aggregate: null, top_waits: [], slow_projects: [], org_url: null }) })
  await has(ui, /SPEED/)
  await has(ui, /No timing data in the last 7 days\./)
  await ui.unmount()
})
