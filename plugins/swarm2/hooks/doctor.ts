// /swarm2-doctor: what this plugin can observe about itself and its host, as one plain-text report. The builder and the
// formatter are pure (tests hand them facts); gatherDoctor reads the facts through the host types alone. A fact no host API
// answers is 'unknown', never guessed. No token is ever part of a fact: only whether one is set. Server readiness is a
// separate section, read only on `/swarm2-doctor check`, from the public /readyz (no credential is sent).
import type { EngineInterface } from 'claude-code'

import { connectionScope } from './connection'
import { deadline } from './deadline'

export const UNKNOWN = 'unknown'
export const SKILL_NAME = 'working-with-swarm2'
export const MCP_SERVER = 'swarm2'
export const READINESS_PATH = '/readyz'
export const READINESS_TIMEOUT_MS = 4000

export type Surface = 'CLI' | 'desktop' | 'web' | 'IDE' | 'headless' | 'unknown'
export type Readiness = { checked: false } | { checked: true; status: 'ready' | 'not ready' | 'unreachable'; http: number | null }

/** Every fact the report holds; null (or undefined) for one that could not be observed. */
export type DoctorFacts = {
  hostName?: string | null
  hostVersion?: string | null
  surfaces?: readonly string[] | null
  pluginName?: string | null
  pluginVersion?: string | null
  packageName?: string | null
  packageVersion?: string | null
  skillName?: string | null
  skillVersion?: string | null
  serviceUrl?: string | null
  profile?: string | null
  tokenSet?: boolean | null
  mcp?: { connected: boolean; reason?: string } | null
  commandsRegistered?: boolean | null
  panel?: { open: boolean; placed: boolean } | null
  guard?: { on: boolean; envOverride: boolean } | null
  lastFeedSuccessAt?: number | null
  lastReportAckAt?: number | null
  readiness?: Readiness
  now: number
}

export type DoctorReport = {
  host: { name: string; version: string; surface: Surface }
  plugin: { name: string; version: string }
  package: { name: string; version: string }
  skill: { name: string; version: string }
  service: { url: string; profile: string; token: 'set (redacted)' | 'not set' | 'unknown' }
  mcp: string
  mod: { commands: string; panel: string; guard: string }
  feed: { lastSuccess: string }
  report: { lastAck: string }
  readiness: string
  repairs: string[]
}

/** The host's surface from the ones the session draws on: none is headless; an unknown name stays unknown. */
export function surfaceOf(surfaces: readonly string[] | null | undefined): Surface {
  if (!surfaces) return 'unknown'
  if (surfaces.length === 0) return 'headless'
  const first = surfaces[0]
  if (first === 'terminal') return 'CLI'
  if (first === 'desktop') return 'desktop'
  if (first === 'vscode') return 'IDE'
  if (first === 'mobile') return 'web'
  return 'unknown'
}

/** Repair commands only where a person can type them into a full host; never on headless, web/mobile or unknown hosts. */
export function mayRepair(surface: Surface): boolean {
  return surface === 'CLI' || surface === 'desktop' || surface === 'IDE'
}

function known(v: string | null | undefined): string {
  return typeof v === 'string' && v.trim() ? v : UNKNOWN
}

/** "12 s ago" style age, or unknown/never. */
export function ageOf(at: number | null | undefined, now: number, never: string): string {
  if (at === undefined) return UNKNOWN
  if (at === null) return never
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 120 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

export function buildDoctorReport(f: DoctorFacts): DoctorReport {
  const surface = surfaceOf(f.surfaces)
  const mcp = !f.mcp ? UNKNOWN : f.mcp.connected ? 'connected' : `not connected (${known(f.mcp.reason)})`
  const readiness = !f.readiness || !f.readiness.checked
    ? 'not checked (run /swarm2-doctor check)'
    : `${f.readiness.status}${f.readiness.http !== null ? ` (HTTP ${f.readiness.http})` : ''}`
  const repairs: string[] = []
  if (mayRepair(surface)) {
    if (f.mcp && !f.mcp.connected) repairs.push('/mcp — reconnect or sign in to the swarm2 server')
    if (f.tokenSet === false) repairs.push('/swarm2-token s2s_… — save a status token')
    if (f.commandsRegistered === false) repairs.push('/plugin — re-enable the swarm2 plugin so its hooks load')
  }
  return {
    host: { name: known(f.hostName), version: known(f.hostVersion), surface },
    plugin: { name: known(f.pluginName), version: known(f.pluginVersion) },
    package: { name: known(f.packageName), version: known(f.packageVersion) },
    skill: { name: known(f.skillName), version: known(f.skillVersion) },
    service: {
      url: known(f.serviceUrl), profile: known(f.profile),
      token: f.tokenSet === true ? 'set (redacted)' : f.tokenSet === false ? 'not set' : UNKNOWN,
    },
    mcp,
    mod: {
      commands: f.commandsRegistered == null ? UNKNOWN : f.commandsRegistered ? 'registered' : 'not registered',
      panel: !f.panel ? UNKNOWN : !f.panel.open ? 'closed' : f.panel.placed ? 'open' : 'open (not placed)',
      guard: !f.guard ? UNKNOWN : f.guard.on ? 'on (local edits blocked)' : `off (local edits allowed${f.guard.envOverride ? ', SWARM2_LOCAL_EDITS' : ''})`,
    },
    feed: { lastSuccess: ageOf(f.lastFeedSuccessAt, f.now, 'never this session') },
    report: { lastAck: ageOf(f.lastReportAckAt, f.now, 'none this session') },
    readiness,
    repairs,
  }
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines = [
    'Swarm2 doctor',
    `Host: ${r.host.name} ${r.host.version} · surface ${r.host.surface}`,
    `Plugin: ${r.plugin.name} ${r.plugin.version} · package ${r.package.name} ${r.package.version} · skill ${r.skill.name} ${r.skill.version}`,
    `Service: ${r.service.url} · profile ${r.service.profile} · status token ${r.service.token}`,
    `MCP server: ${r.mcp}`,
    `Mod: commands ${r.mod.commands} · panel ${r.mod.panel} · guard ${r.mod.guard}`,
    `Feed: last successful poll ${r.feed.lastSuccess}`,
    `Plugin report: last ack ${r.report.lastAck}`,
    '',
    'Server readiness',
    `  ${r.readiness}`,
  ]
  if (r.repairs.length) lines.push('', 'Try', ...r.repairs.map(c => `  ${c}`))
  return lines.join('\n')
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch { return null }
}

/** Reads the public readiness route of the configured service: no credential, no retry. */
export async function checkReadiness($: EngineInterface, base: string): Promise<Readiness> {
  let timeout: { promise: Promise<null>; cancel: () => void } | undefined
  try {
    timeout = deadline($, READINESS_TIMEOUT_MS, null)
    const res = await Promise.race([$.http.fetch(`${base}${READINESS_PATH}`, { method: 'GET' }), timeout.promise])
    if (!res || !res.status) return { checked: true, status: 'unreachable', http: null }
    return { checked: true, status: res.ok ? 'ready' : 'not ready', http: res.status }
  } catch {
    return { checked: true, status: 'unreachable', http: null }
  } finally {
    timeout?.cancel()
  }
}

/** What register.tsx knows and the host does not answer. `tokenSet` is a yes/no; the token itself never reaches here. */
export type DoctorContext = {
  base: string
  pluginVersion: string
  paneId: string
  commandsRegistered: boolean | null
  tokenSet: boolean | null
  guard: { on: boolean; envOverride: boolean } | null
  lastFeedSuccessAt: number | null | undefined
  lastReportAckAt: number | null
  check: boolean
}

/** Observes the facts through the host types; anything that throws or has no API stays unknown. */
export async function gatherDoctor($: EngineInterface, ctx: DoctorContext): Promise<DoctorFacts> {
  const [version, surfaces, panes, mcp] = await Promise.all([
    attempt(() => $.session.version()),
    attempt(() => $.session.surfaces()),
    attempt(() => $.ui.panes()),
    attempt(() => $.mcp.connect(MCP_SERVER)),
  ])
  const pane = panes?.find(p => p.id === ctx.paneId)
  const scope = connectionScope()
  return {
    hostName: null, // no host API names the host application
    hostVersion: version?.version ?? null,
    surfaces: surfaces ?? null,
    pluginName: $.plugin.name,
    pluginVersion: ctx.pluginVersion,
    packageName: $.plugin.name,
    packageVersion: ctx.pluginVersion,
    skillName: SKILL_NAME,
    skillVersion: null, // the skill declares no version
    serviceUrl: ctx.base,
    profile: scope.profile,
    tokenSet: ctx.tokenSet,
    mcp: mcp ? (mcp.isConnected ? { connected: true } : { connected: false, reason: mcp.reason }) : null,
    commandsRegistered: ctx.commandsRegistered,
    panel: panes ? { open: !!pane, placed: !!pane?.isPlaced } : null,
    guard: ctx.guard,
    lastFeedSuccessAt: ctx.lastFeedSuccessAt,
    lastReportAckAt: ctx.lastReportAckAt,
    readiness: ctx.check ? await checkReadiness($, ctx.base) : { checked: false },
    now: Date.now(),
  }
}
