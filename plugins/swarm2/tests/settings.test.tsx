import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isDefaultSetting, parseSettings, settingLine, settingsStatusParts, settingValueText } from '../hooks/settings'

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

const setting = (key: string, label: string, value: unknown, def: unknown, over: Record<string, unknown> = {}) => ({
  key, label, value, default: def, source: value === def ? 'server default' : 'project', how_to_change: `change ${key} here`, ...over,
})

const LONG_COMMAND = `bun test ${'tests/very/long/path '.repeat(6)}--bail`
const SETTINGS = [
  setting('auto_pr', 'Auto PR', true, false),
  setting('auto_merge', 'Auto merge', false, false),
  setting('auto_prod_deploy', 'Auto prod deploy', false, false),
  setting('controller_mode', 'Controller mode', 'observe', 'off', { source: 'org' }),
  setting('test_command', 'Test command', LONG_COMMAND, null),
  setting('shards', 'Verifier shards', 1, 1),
]

const project = (repo: string, settings?: unknown[]) => ({
  repo, role: 'owner', active_runs: 0, more_members: 0, members: [{ name: 'Alex', role: 'owner', you: true, active_runs: 0 }],
  ...(settings ? { settings } : {}),
})

const BASE_FEED = { accounts: [], runs: [], others: [], attention: [], deployments: [], capacity: null, pool: { enabled: true } }

function json(body: unknown, status = 200) {
  return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(body) : '' } }
}

/** A fake Swarm2 answering the control feed with these projects; every status line the pane sets lands in `statuses`. */
function engine(on: On, projects: unknown[], statuses: (string | undefined)[] = []) {
  const store = new Map<string, unknown>([['statusToken', 's2s_testtokentesttokentest']])
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
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
    if (e.url.endsWith('/me/control')) return json({ ...BASE_FEED, projects })
    if (e.url.endsWith('/me/runs/status')) return json({ runs: [], deployments: [], messages: [] })
    return json(null, 404)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'swarm2', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')

test('parseSettings keeps well-formed entries and tolerates an absent or malformed list', () => {
  expect(parseSettings(undefined)).toEqual([])
  expect(parseSettings(null)).toEqual([])
  expect(parseSettings('nope')).toEqual([])
  const parsed = parseSettings([...SETTINGS, null, { key: 'x' }, { key: 'y', label: 'Y', value: { nested: 1 }, default: null }])
  expect(parsed.map(s => s.key)).toEqual(SETTINGS.map(s => s.key))
  expect(parseSettings([setting('a', 'A', 1, 1, { source: 'elsewhere', how_to_change: 5 })])[0])
    .toMatchObject({ source: 'server default', how_to_change: '' })
})

test('values read on/off/none; long values are shortened; (default) only when value equals default', () => {
  expect(settingValueText(true)).toBe('on')
  expect(settingValueText(false)).toBe('off')
  expect(settingValueText(null)).toBe('none')
  expect(settingValueText(1200)).toBe('1200')
  const long = settingValueText(LONG_COMMAND)
  expect(long.length).toBe(40)
  expect(long.endsWith('…')).toBe(true)
  const [autoPr, autoMerge] = parseSettings(SETTINGS)
  expect(settingLine(autoPr!)).toBe('Auto PR: on')
  expect(isDefaultSetting(autoPr!)).toBe(false)
  expect(isDefaultSetting(autoMerge!)).toBe(true)
})

test('status badges: auto-merge and auto deploy ON per repo or count, none when off or absent', () => {
  const on = (key: string) => SETTINGS.map(s => s.key === key ? { ...s, value: true } : s)
  expect(settingsStatusParts(null)).toEqual([])
  expect(settingsStatusParts([project('acme/app', SETTINGS), project('acme/old')])).toEqual([])
  expect(settingsStatusParts([project('acme/app', on('auto_merge'))])).toEqual(['auto-merge ON acme/app'])
  expect(settingsStatusParts([project('acme/app', on('auto_prod_deploy')), project('acme/web', on('auto_prod_deploy'))]))
    .toEqual(['auto deploy ON 2 repos'])
  const both = SETTINGS.map(s => s.key === 'auto_merge' || s.key === 'auto_prod_deploy' ? { ...s, value: true } : s)
  expect(settingsStatusParts([project('acme/app', both)])).toEqual(['auto-merge ON acme/app', 'auto deploy ON acme/app'])
})

test('the Settings section is collapsed by default and expands to one line per setting', async ($, on) => {
  engine(on, [project('acme/app', SETTINGS)])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'settings:acme/app' }))?.text).toBe('▸ Settings (6)')
  expect(await ui.find({ type: 'Text', text: /Auto PR/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /change auto_pr here/ })).toBeUndefined()

  await ui.press({ key: 'settings:acme/app' })
  const lines = await texts(ui)
  expect((await ui.find({ key: 'settings:acme/app' }))?.text).toBe('▾ Settings (6)')
  const line = (label: RegExp) => lines.find(t => label.test(t) && /: /.test(t)) ?? ''
  expect(line(/Auto PR: on/)).not.toMatch(/\(default\)/)
  expect(line(/Auto merge: off/)).toMatch(/\(default\)/)
  expect(line(/Controller mode: observe/)).not.toMatch(/\(default\)/)
  expect(line(/Verifier shards: 1/)).toMatch(/\(default\)/)
  expect(line(/Auto PR/)).toMatch(/change auto_pr here/)
  // a long test command is cut, never drawn whole
  expect(line(/Test command/)).toMatch(/…/)
  expect(lines.some(t => t.includes(LONG_COMMAND))).toBe(false)

  await ui.press({ key: 'settings:acme/app' })
  expect(await ui.find({ type: 'Text', text: /Auto PR/ })).toBeUndefined()
  await ui.unmount()
})

test('an older server without settings draws no Settings section and no badge', async ($, on) => {
  const statuses: (string | undefined)[] = []
  engine(on, [project('acme/old')], statuses)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /acme\/old/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Settings/ })).toBeUndefined()
  await ui.unmount()
  expect(statuses.some(s => /auto-merge|auto deploy/.test(s ?? ''))).toBe(false)
})

test('the status line carries a badge for each repo with auto-merge or auto deploy on', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const onSettings = SETTINGS.map(s => s.key === 'auto_merge' || s.key === 'auto_prod_deploy' ? { ...s, value: true } : s)
  engine(on, [project('acme/app', onSettings), project('acme/web', SETTINGS)], statuses)
  await start($)
  const last = statuses.filter(Boolean).at(-1) ?? ''
  expect(last).toMatch(/auto-merge ON acme\/app/)
  expect(last).toMatch(/auto deploy ON acme\/app/)
  expect(last).not.toMatch(/acme\/web/)
})

test('the status line has no settings badge while auto-merge and auto deploy are off', async ($, on) => {
  const statuses: (string | undefined)[] = []
  engine(on, [project('acme/app', SETTINGS)], statuses)
  await start($)
  expect(statuses.some(s => /auto-merge|auto deploy/.test(s ?? ''))).toBe(false)
})

test('every surface draws the collapsed Settings line', async ($, on) => {
  engine(on, [project('acme/app', SETTINGS)])
  await start($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'settings:acme/app' }))?.text).toBe('▸ Settings (6)')
    expect(await ui.find({ type: 'Text', text: /Auto PR/ })).toBeUndefined()
    await ui.unmount()
  }
})

// The server's effective values that differ from the project's own setting (an organisation kill switch, the organisation's shard
// maximum, auto-merge implying auto PR) carry project_value / blocked_by / note; older servers send none of them.
const KILL = 'organisation kill switch'
const OVERRIDDEN = [
  setting('auto_pr', 'Auto PR', true, false, { project_value: false, note: 'implied by auto-merge' }),
  setting('auto_merge', 'Auto merge', true, false),
  setting('auto_prod_deploy', 'Auto prod deploy', false, false,
    { source: 'org', project_value: true, blocked_by: KILL, note: `blocked by the ${KILL}; project setting: on` }),
  setting('controller_mode', 'Controller', 'off', 'off',
    { source: 'org', project_value: 'repair', blocked_by: KILL, note: `blocked by the ${KILL}; project setting: repair` }),
  setting('shards', 'Verifier shards', 4, 1,
    { source: 'org', project_value: 8, note: 'clamped to the organisation maximum 4; project setting: 8' }),
]

test('parseSettings keeps project_value, blocked_by and note when well-formed and drops them otherwise', () => {
  const [autoPr, , autoProd] = parseSettings(OVERRIDDEN)
  expect(autoPr).toMatchObject({ project_value: false, note: 'implied by auto-merge' })
  expect(autoProd).toMatchObject({ project_value: true, blocked_by: KILL })
  const bad = parseSettings([setting('a', 'A', 1, 1, { project_value: { x: 1 }, blocked_by: 5, note: '' })])[0]!
  expect('project_value' in bad || 'blocked_by' in bad || 'note' in bad).toBe(false)
  expect(parseSettings(SETTINGS).some(s => 'project_value' in s || 'blocked_by' in s || 'note' in s)).toBe(false)
})

test('a blocked, clamped or implied value is never "(default)" and its line says why', () => {
  const s = new Map(parseSettings(OVERRIDDEN).map(e => [e.key, e]))
  expect(settingLine(s.get('auto_prod_deploy')!)).toBe(`Auto prod deploy: off (blocked by the ${KILL}; project setting: on)`)
  expect(isDefaultSetting(s.get('auto_prod_deploy')!)).toBe(false)
  expect(settingLine(s.get('controller_mode')!)).toBe(`Controller: off (blocked by the ${KILL}; project setting: repair)`)
  expect(isDefaultSetting(s.get('controller_mode')!)).toBe(false)
  expect(settingLine(s.get('auto_pr')!)).toBe('Auto PR: on (implied by auto-merge)')
  expect(settingLine(s.get('shards')!)).toBe('Verifier shards: 4 (clamped to the organisation maximum 4; project setting: 8)')
  // blocked_by without a note still explains itself; an unblocked off is still the default
  expect(settingLine({ ...s.get('auto_prod_deploy')!, note: undefined })).toBe(`Auto prod deploy: off (blocked by the ${KILL}; project setting: on)`)
  expect(isDefaultSetting({ value: false, default: false })).toBe(true)
  expect(isDefaultSetting({ value: false, default: false, project_value: false })).toBe(true)
})

test('the expanded pane draws the reason and no (default) for blocked settings', async ($, on) => {
  engine(on, [project('acme/app', OVERRIDDEN)])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'settings:acme/app' })
  const lines = await texts(ui)
  const line = (label: RegExp) => lines.find(t => label.test(t) && /: /.test(t)) ?? ''
  expect(line(/Auto prod deploy: off \(blocked by the organisation kill switch; project setting: on\)/)).not.toMatch(/\(default\)/)
  expect(line(/Controller: off \(blocked by the organisation kill switch; project setting: repair\)/)).not.toMatch(/\(default\)/)
  expect(line(/Auto PR: on \(implied by auto-merge\)/)).not.toMatch(/\(default\)/)
  expect(line(/Verifier shards: 4 \(clamped to the organisation maximum 4/)).not.toMatch(/\(default\)/)
  await ui.unmount()
})

test('with Autopilot on, a project shows only the autopilot badge, not auto-merge / auto deploy', async ($, on) => {
  const all = SETTINGS.map(s => s.key === 'auto_merge' || s.key === 'auto_prod_deploy' ? { ...s, value: true } : s)
  expect(settingsStatusParts([{ ...project('acme/app', all), autopilot: true }])).toEqual([])
  expect(settingsStatusParts([{ ...project('acme/app', all), autopilot: true }, project('acme/web', all)]))
    .toEqual(['auto-merge ON acme/web', 'auto deploy ON acme/web'])
  const statuses: (string | undefined)[] = []
  engine(on, [{ ...project('acme/app', all), autopilot: true }], statuses)
  await start($)
  const last = statuses.filter(Boolean).at(-1) ?? ''
  expect(last).toMatch(/autopilot ON acme\/app/)
  expect(last).not.toMatch(/auto-merge|auto deploy/)
})
