import type { ProjectRow } from '../types'

/** The pane status line's Autopilot part: 'autopilot ON <repo>' for one project, 'autopilot ON <n> repos' for several, null when
 * none (or an older server that sends no autopilot field). A project whose Autopilot settings were changed individually since it
 * was switched on (autopilot_drifted) is marked '(drifted)' / '(<k> drifted)': "ON" alone would overstate what is automated. */
export function autopilotStatusPart(projects: readonly Pick<ProjectRow, 'repo' | 'autopilot' | 'autopilot_drifted'>[] | null | undefined): string | null {
  const on = (projects ?? []).filter(p => p?.autopilot === true)
  if (!on.length) return null
  const drifted = on.filter(p => p.autopilot_drifted === true).length
  if (on.length === 1) return `autopilot ON ${on[0]!.repo}${drifted ? ' (drifted)' : ''}`
  return `autopilot ON ${on.length} repos${drifted ? ` (${drifted} drifted)` : ''}`
}

/** The repo row's Autopilot label, null when off. */
export const autopilotRowLabel = (p: Pick<ProjectRow, 'autopilot' | 'autopilot_drifted'>): string | null =>
  p.autopilot === true ? (p.autopilot_drifted === true ? 'autopilot ON (drifted)' : 'autopilot ON') : null
