import type { SettingEntry } from '../types'

// A project's effective settings (the control feed's projects[].settings): parsed defensively, since an older server sends
// none and a stored feed is not trusted either, then drawn one short line each for a narrow pane.

const SOURCES = new Set(['project', 'org', 'user', 'server default'])
const MAX_ENTRIES = 60
const VALUE_CHARS = 40
const LABEL_CHARS = 40
const HOW_CHARS = 300

type Value = SettingEntry['value']
const isValue = (v: unknown): v is Value => v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string'
const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The well-formed entries of a project's `settings`; [] when absent or not a list (an older server). */
export function parseSettings(raw: unknown): SettingEntry[] {
  if (!Array.isArray(raw)) return []
  const out: SettingEntry[] = []
  for (const e of raw.slice(0, MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') continue
    const s = e as Record<string, unknown>
    if (typeof s.key !== 'string' || typeof s.label !== 'string' || !isValue(s.value) || !isValue(s.default)) continue
    out.push({
      key: s.key, label: clip(s.label, LABEL_CHARS), value: s.value, default: s.default,
      source: typeof s.source === 'string' && SOURCES.has(s.source) ? s.source as SettingEntry['source'] : 'server default',
      how_to_change: typeof s.how_to_change === 'string' ? clip(s.how_to_change, HOW_CHARS) : '',
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

export const isDefaultSetting = (s: Pick<SettingEntry, 'value' | 'default'>): boolean => s.value === s.default

/** One setting's line: "Label: value", '(default)' added by the pane when isDefaultSetting. */
export const settingLine = (s: SettingEntry): string => `${s.label}: ${settingValueText(s.value)}`

const isOn = (p: { settings?: unknown }, key: string) => parseSettings(p.settings).some(s => s.key === key && s.value === true)
const onPart = (what: string, repos: string[]) => repos.length === 0 ? null
  : `${what} ON ${repos.length === 1 ? repos[0] : `${repos.length} repos`}`

/** The status line's badges: 'auto-merge ON <repo>' and 'auto deploy ON <repo>' ('<n> repos' for several); [] when none is on
 * or the server sends no settings. */
export function settingsStatusParts(projects: readonly { repo: string; settings?: unknown }[] | null | undefined): string[] {
  const list = (projects ?? []).filter(p => p && typeof p.repo === 'string')
  return [
    onPart('auto-merge', list.filter(p => isOn(p, 'auto_merge')).map(p => p.repo)),
    onPart('auto deploy', list.filter(p => isOn(p, 'auto_prod_deploy')).map(p => p.repo)),
  ].filter((p): p is string => p !== null)
}
