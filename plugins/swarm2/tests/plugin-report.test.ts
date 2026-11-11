import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { configureConnection, resetConnection } from '../hooks/connection'
import {
  flushPluginReports, PLUGIN_REPORT_PATH, REPORT_INTERVAL_MS, REPORT_RETRY_MS, REPORT_TIMEOUT_MS, reportBody, reportDue, reportPluginState,
  resetPluginReports, setPluginVersion,
} from '../hooks/plugin-report'

// ---- pure ----

test('the report body follows the protocol; a session id outside [\\w-]{1,100} is left out', () => {
  expect(reportBody('0.5.1', 'on', 'sess-1')).toEqual({ client: 'claude-code', plugin_version: '0.5.1', guard: 'on', session: 'sess-1' })
  expect(reportBody('0.5.1', 'off', null)).toEqual({ client: 'claude-code', plugin_version: '0.5.1', guard: 'off' })
  for (const bad of ['', 'a b', 'x'.repeat(101), 'ünïcode', 'a/b']) expect('session' in reportBody('0.5.1', 'on', bad)).toBe(false)
  expect(reportBody('0.5.1', 'on', 'x'.repeat(100)).session?.length).toBe(100)
  expect(PLUGIN_REPORT_PATH).toBe('/me/plugin/report')
})

test('a report is due first, on a guard change, after the interval, sooner after a failure, never while one is in flight', () => {
  const t = 1_000_000
  expect(reportDue(undefined, 'on', t)).toBe(true)
  const sent = { at: t, guard: 'on' as const, ok: true, inflight: false }
  expect(reportDue(sent, 'on', t + 1000)).toBe(false)
  expect(reportDue(sent, 'off', t + 1000)).toBe(true)
  expect(reportDue(sent, 'on', t + REPORT_INTERVAL_MS - 1)).toBe(false)
  expect(reportDue(sent, 'on', t + REPORT_INTERVAL_MS)).toBe(true)
  const failed = { ...sent, ok: false }
  expect(reportDue(failed, 'on', t + REPORT_RETRY_MS - 1)).toBe(false)
  expect(reportDue(failed, 'on', t + REPORT_RETRY_MS)).toBe(true)
  expect(reportDue({ ...sent, inflight: true }, 'off', t + REPORT_INTERVAL_MS)).toBe(false)
  expect(REPORT_INTERVAL_MS).toBe(5 * 60_000)
})

// ---- against a fake fetch (the module as this test file imports it, with a hand-made $) ----

type Fake = { posts: { url: string; auth?: string; body: unknown }[]; status: number; mode?: 'throw' | 'hang'; token?: string | null }

function fake(f: Fake): EngineInterface {
  const $ = {
    session: { id: async () => 'sess-9' },
    store: { get: async (key: string) => (key === 'statusToken' ? (f.token === undefined ? 's2s_reporttoken' : f.token) : null) },
    http: {
      fetch: async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        f.posts.push({ url, auth: init?.headers?.authorization, body: JSON.parse(init?.body ?? 'null') })
        if (f.mode === 'throw') throw new Error('network down')
        if (f.mode === 'hang') return new Promise(() => {})
        return { status: f.status, ok: f.status >= 200 && f.status < 300, headers: {}, text: '' }
      },
    },
  }
  return $ as unknown as EngineInterface
}

function setup(now: () => number, options: { baseUrl?: string; statusToken?: string } = { baseUrl: 'https://swarm2.example/' }) {
  resetConnection()
  configureConnection(options)
  setPluginVersion('0.5.1')
  resetPluginReports(now)
}

test('one POST with the token and body; repeated calls inside the window send nothing; a guard change sends at once', async () => {
  const f: Fake = { posts: [], status: 202 }
  const $ = fake(f)
  let t = 5_000_000
  setup(() => t)
  await reportPluginState($, true)
  await reportPluginState($, true)
  t += 60_000
  await reportPluginState($, true)
  expect(f.posts).toEqual([{ url: 'https://swarm2.example/me/plugin/report', auth: 'Bearer s2s_reporttoken', body: { client: 'claude-code', plugin_version: '0.5.1', guard: 'on', session: 'sess-9' } }])
  await reportPluginState($, false)
  expect(f.posts.map(p => (p.body as { guard: string }).guard)).toEqual(['on', 'off'])
  t += REPORT_INTERVAL_MS
  await reportPluginState($, false)
  expect(f.posts.length).toBe(3)
})

test('a failed report (HTTP error, network error) is retried after the short retry window, never sooner', async () => {
  const f: Fake = { posts: [], status: 500 }
  const $ = fake(f)
  let t = 5_000_000
  setup(() => t)
  await reportPluginState($, true)
  t += REPORT_RETRY_MS - 1
  await reportPluginState($, true)
  expect(f.posts.length).toBe(1)
  t += 1
  f.mode = 'throw'
  await reportPluginState($, true) // rejects inside: swallowed
  expect(f.posts.length).toBe(2)
  t += REPORT_RETRY_MS
  f.mode = undefined
  f.status = 202
  await reportPluginState($, true)
  t += REPORT_RETRY_MS
  await reportPluginState($, true) // accepted: now the long interval applies
  expect(f.posts.length).toBe(3)
})

test('no token, no configuration or no version: nothing is sent', async () => {
  const f: Fake = { posts: [], status: 202, token: null }
  const $ = fake(f)
  const t = 5_000_000
  setup(() => t, {})
  await reportPluginState($, true)
  expect(f.posts).toEqual([])
  resetConnection() // not configured by register.tsx
  f.token = 's2s_reporttoken'
  resetPluginReports(() => t)
  await reportPluginState($, true)
  expect(f.posts).toEqual([])
  configureConnection({})
  setPluginVersion(null)
  await reportPluginState($, true)
  expect(f.posts).toEqual([])
})

test('a hung server never holds the caller past the report timeout, and the call is not repeated meanwhile', { timeoutMs: REPORT_TIMEOUT_MS + 3000 }, async () => {
  const f: Fake = { posts: [], status: 202, mode: 'hang' }
  const $ = fake(f)
  setup(() => Date.now())
  const t0 = Date.now()
  const first = reportPluginState($, true)
  await reportPluginState($, false) // in flight: skipped, resolves at once
  expect(Date.now() - t0).toBeLessThan(500)
  await first
  await flushPluginReports()
  const took = Date.now() - t0
  expect(took).toBeGreaterThanOrEqual(REPORT_TIMEOUT_MS - 50)
  expect(took).toBeLessThan(REPORT_TIMEOUT_MS + 1500)
  expect(f.posts.length).toBe(1)
})
