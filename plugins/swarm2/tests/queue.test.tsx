import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseQueue, queueStatus } from '../hooks/queue'

const PANE = {
  plugin: 'swarm2',
  component: 'Pane',
  requestId: 'swarm2',
  props: {
    title: 'Swarm2',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const BLOCKER = '0b1c2d3e-0000-4000-8000-000000000001'
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

function entry(position: number, over: Record<string, unknown> = {}) {
  return {
    position, run_id: `${String(position).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, title: `task ${position}`, status: 'queued',
    status_reason: null, requester: 'Edi', mine: false, provider: null, model: null, effort: null, waiting_for_paths: null,
    retry_at: null, since: minutesAgo(5), ...over,
  }
}

const QUEUE = {
  repos: [{
    repo: 'acme/app', more: 3, entries: [
      entry(1, { status: 'running', mine: true, requester: 'Alex', title: 'fix login', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', since: minutesAgo(12) }),
      entry(2, { status: 'waiting_quota', retry_at: '2026-11-13T15:30:00Z' }),
      entry(3, { status: 'awaiting_approval', requester: 'Ion' }),
      entry(4, { status_reason: 'waiting_for_paths', waiting_for_paths: { blocking_run_id: BLOCKER, blocking_pattern: 'src/auth/**' } }),
    ],
  }],
  more_repos: 2,
}

const CONTROL = { accounts: [], runs: [], others: [], attention: [], deployments: [], capacity: null }

type Server = { control: Record<string, unknown> }

function json(body: unknown, status = 200) {
  return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(body) : '' } }
}

function engine(on: On, server: Server) {
  const store = new Map<string, unknown>([['statusToken', 's2s_testtokentesttokentest']])
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
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
    if (e.url.endsWith('/me/plugin/report')) return json({ ok: true })
    if (e.url.endsWith('/me/control')) return json(server.control)
    if (e.url.endsWith('/me/runs/status')) return json({ runs: [], deployments: [], messages: [] })
    return json(null, 404)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

type Mounted = { find: (q: { type: string; text: RegExp }) => Promise<unknown>; findAll: (q: { type: string; text?: RegExp }) => Promise<{ text: string; props: Record<string, unknown> }[]> }

const has = async (ui: Mounted, text: RegExp) =>
  expect((await ui.find({ type: 'Text', text })) ? 'found' : `missing ${text}`).toBe('found')

/** Every Text the pane shows, the footer's clock left out. */
const lines = async (ui: Mounted) => (await ui.findAll({ type: 'Text' })).map(t => t.text.replace(/updated \S+/, 'updated'))

test('each repo queue lists its entries in order: position, status, you or the requester, title, routing, age, what it waits for', async ($, on) => {
  engine(on, { control: { ...CONTROL, queue: QUEUE } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await has(ui, /^acme\/app queue \+3 more$/)
    await has(ui, /^ {2}1 ▶ running · you · “fix login” · claude \/ claude-opus-5-5 \/ high · 12m$/)
    await has(ui, /^ {2}2 ⏸ waiting for quota · Edi · “task 2” · 5m$/)
    await has(ui, /^ +retries \d\d:\d\d|^ +retries \w{3}$/)
    await has(ui, /^ {2}3 ⚑ awaiting approval · Ion/)
    await has(ui, /^ {2}4 ⧗ waiting for paths · Edi/)
    await has(ui, /^ +waits for run 0b1c2d3e · src\/auth\/\*\*$/)
    await has(ui, /^\+2 more repos$/)
    const shown = await lines(ui)
    const at = (n: number) => shown.findIndex(t => t.startsWith(`  ${n} `))
    expect([at(1), at(2), at(3), at(4)].every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1]!))).toBe(true)
    await ui.unmount()
  }
})

test('an absent, empty or malformed queue draws nothing extra', async ($, on) => {
  const server: Server = { control: CONTROL }
  engine(on, server)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const without = await lines(ui)
  await ui.unmount()
  for (const queue of [{ repos: [], more_repos: 0 }, null, 'x', 7, [], { repos: 'x' }, { repos: [{ repo: 'acme/app', entries: [{ position: 'one' }], more: 0 }] },
    { repos: [{ repo: 'acme/app', entries: [{ ...entry(1), run_id: 42 }, { ...entry(2), since: 'yesterday' }] }], more_repos: -1 }]) {
    server.control = { ...CONTROL, queue }
    await command($, 'swarm2')
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await lines(ui)).toEqual(without)
    expect(await ui.find({ type: 'Text', text: /queue|more repo/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a malformed entry is dropped alone; the rest of the repo still shows', async ($, on) => {
  const queue = { repos: [{ repo: 'acme/app', more: 0, entries: [{ position: 1 }, entry(2, { mine: true })] }, { repo: 42, entries: [entry(1)] }], more_repos: 0 }
  engine(on, { control: { ...CONTROL, queue } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await has(ui, /^acme\/app queue$/)
  await has(ui, /^ {2}2 · queued · you · “task 2”/)
  expect(await ui.find({ type: 'Text', text: /^ {2}1 / })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /more/ })).toBeUndefined()
  await ui.unmount()
})

test('at a narrow width the pane draws, every queue line truncates at its end and a long title is cut', async ($, on) => {
  const long = 'x'.repeat(120)
  engine(on, { control: { ...CONTROL, queue: { ...QUEUE, repos: [{ ...QUEUE.repos[0]!, entries: [...QUEUE.repos[0]!.entries, entry(5, { title: long })] }] } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'swarm2')
  for (const bodyColumns of [12, 1]) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns } })
    const rows = (await ui.findAll({ type: 'Text' })).filter(t => / queue( \+\d+ more)?$|^ {2}\d |^ +waits for|^ +retries|more repos/.test(t.text))
    expect(rows.length).toBeGreaterThanOrEqual(8)
    for (const t of rows) expect(t.props.wrap).toBe('truncate-end')
    await has(ui, /^ {2}5 · queued · Edi · “x{47}…” · 5m$/)
    expect(await ui.find({ type: 'Text', text: new RegExp(long) })).toBeUndefined()
    await ui.unmount()
  }
})

test('parseQueue bounds repos and entries and counts the rest; statuses read as words', () => {
  const repos = Array.from({ length: 12 }, (_, i) => ({ repo: `acme/r${i}`, more: 1, entries: Array.from({ length: 22 }, (_, k) => entry(k + 1)) }))
  const q = parseQueue({ repos, more_repos: 3 })
  expect(q.repos).toHaveLength(10)
  expect(q.more_repos).toBe(5)
  expect(q.repos[0]!.entries).toHaveLength(20)
  expect(q.repos[0]!.more).toBe(3)
  expect(parseQueue(undefined)).toEqual({ repos: [], more_repos: 0 })
  expect(parseQueue({ repos: [{ repo: 'acme/app', entries: [], more: 0 }], more_repos: 0 })).toEqual({ repos: [], more_repos: 0 })
  expect(parseQueue({ repos: [{ repo: 'acme/app', entries: [], more: 4 }] }).repos[0]!.more).toBe(4)
  expect(queueStatus({ status: 'queued', status_reason: 'waiting_for_paths' }).word).toBe('waiting for paths')
  expect(queueStatus({ status: 'queued', status_reason: null }).word).toBe('queued')
  expect(queueStatus({ status: 'waiting_quota', status_reason: null }).word).toBe('waiting for quota')
  expect(queueStatus({ status: 'verifying', status_reason: null }).word).toBe('verifying')
  expect(queueStatus({ status: 'awaiting_owner', status_reason: null }).word).toBe('awaiting approval')
})
