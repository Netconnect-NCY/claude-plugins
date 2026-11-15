import type { SettingEntry } from '../types'

// A project's effective settings (the control feed's projects[].settings): parsed defensively, since an older server sends
// none and a stored feed is not trusted either, then drawn one short line each for a narrow pane.

const SOURCES = new Set(['project', 'org', 'user', 'server default'])
const MAX_ENTRIES = 60
const VALUE_CHARS = 40
const LABEL_CHARS = 40
const HOW_CHARS = 300
const NOTE_CHARS = 120

/** An entry as the pane keeps it: the optional project_value / blocked_by / note say why the effective value differs from the
 * project's own setting (an organisation kill switch, the organisation's shard maximum, auto-merge implying auto PR); an older
 * server sends none of them. */
export type PaneSetting = SettingEntry & { project_value?: SettingEntry['value']; blocked_by?: string; note?: string }

type Value = SettingEntry['value']
const isValue = (v: unknown): v is Value => v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string'
const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The well-formed entries of a project's `settings`; [] when absent or not a list (an older server). */
export function parseSettings(raw: unknown): PaneSetting[] {
  if (!Array.isArray(raw)) return []
  const out: PaneSetting[] = []
  for (const e of raw.slice(0, MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') continue
    const s = e as Record<string, unknown>
    if (typeof s.key !== 'string' || typeof s.label !== 'string' || !isValue(s.value) || !isValue(s.default)) continue
    out.push({
      key: s.key, label: clip(s.label, LABEL_CHARS), value: s.value, default: s.default,
      source: typeof s.source === 'string' && SOURCES.has(s.source) ? s.source as SettingEntry['source'] : 'server default',
      how_to_change: typeof s.how_to_change === 'string' ? clip(s.how_to_change, HOW_CHARS) : '',
      ...(isValue(s.project_value) ? { project_value: s.project_value } : {}),
      ...(typeof s.blocked_by === 'string' && s.blocked_by ? { blocked_by: clip(s.blocked_by, NOTE_CHARS) } : {}),
      ...(typeof s.note === 'string' && s.note ? { note: clip(s.note, NOTE_CHARS) } : {}),
    })
  }
  return out
}

/** on / off / none, or the value shortened (a long test_command ends in …). */
export function settingValueText(v: Value): string {
  if (v === true) return 'on'
  if (v === false) return 'off'
  if (v === null) return 'none'
  return clip(String(v), VALUE_CHARS)
}

/** The default is in effect: value equals default and nothing overrides a different project setting (an organisation kill
 * switch blocking an auto prod deploy the owner switched on is not "off (default)"). */
export const isDefaultSetting = (s: Pick<PaneSetting, 'value' | 'default' | 'project_value'>): boolean =>
  s.value === s.default && (s.project_value === undefined || s.project_value === s.value)

/** Why the effective value differs from the project's setting: the server's note, else one built from blocked_by. */
const settingNote = (s: PaneSetting): string | null =>
  s.note ?? (s.blocked_by ? `blocked by the ${s.blocked_by}${s.project_value === undefined ? '' : `; project setting: ${settingValueText(s.project_value)}`}` : null)

/** One setting's line: "Label: value", with "(why)" when the value is not the project's own setting; '(default)' is added
 * by the pane when isDefaultSetting. */
export const settingLine = (s: PaneSetting): string => {
  const note = settingNote(s)
  return `${s.label}: ${settingValueText(s.value)}${note ? ` (${note})` : ''}`
}

const isOn = (p: { settings?: unknown }, key: string) => parseSettings(p.settings).some(s => s.key === key && s.value === true)
const onPart = (what: string, repos: string[]) => repos.length === 0 ? null
  : `${what} ON ${repos.length === 1 ? repos[0] : `${repos.length} repos`}`

/** The status line's badges: 'auto-merge ON <repo>' and 'auto deploy ON <repo>' ('<n> repos' for several); [] when none is on
 * or the server sends no settings. A project with Autopilot on is left out: its autopilot badge already says both. */
export function settingsStatusParts(projects: readonly { repo: string; autopilot?: boolean; settings?: unknown }[] | null | undefined): string[] {
  const list = (projects ?? []).filter(p => p && typeof p.repo === 'string' && p.autopilot !== true)
  return [
    onPart('auto-merge', list.filter(p => isOn(p, 'auto_merge')).map(p => p.repo)),
    onPart('auto deploy', list.filter(p => isOn(p, 'auto_prod_deploy')).map(p => p.repo)),
  ].filter((p): p is string => p !== null)
}
