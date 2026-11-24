/** Advisory only: it never blocks, and tool names alone (never tool text) decide it. */
export const CHECKPOINT_REMINDER = 'Swarm2 checkpoint reminder: this session changed Swarm2 state since the last swarm_checkpoint. Call swarm_checkpoint (project-level next_actions, open_questions, watched PRs/CI, pending deploys) so another client can resume.'

export const STATE_CHANGING_TOOLS = ['swarm_task_submit', 'swarm_memory_propose', 'swarm_plan_propose', 'swarm_ci_run', 'swarm_merge_record', 'swarm_deploy_request']

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/** Whether a state-changing swarm tool ran (successfully) after the session's last swarm_checkpoint. */
export function needsCheckpointReminder(transcript: unknown): boolean {
  let dirty = false
  for (const message of Array.isArray(transcript) ? transcript : []) {
    const m = record(message)
    if (m?.role !== 'assistant' || !Array.isArray(m.toolUses)) continue
    for (const value of m.toolUses) {
      const use = record(value)
      if (!use || use.isError || typeof use.tool !== 'string') continue
      const name = use.tool.replace(/^mcp__.+__/, '')
      if (name === 'swarm_checkpoint') dirty = false
      else if (STATE_CHANGING_TOOLS.includes(name)) dirty = true
    }
  }
  return dirty
}

/** Adds the one-line reminder to a Stop result; a missing transcript API or UI failure never discards the downstream result. */
export async function checkpointStop<T extends { additionalContext?: string[] }>(
  messages: () => Promise<unknown>, notify: (text: string) => void, next: () => Promise<T>,
): Promise<T> {
  let transcript: unknown
  try {
    void messages().then(value => { transcript = value }).catch(() => {})
  } catch { /* Missing transcript API: no reminder. */ }
  const result = await next()
  if (!needsCheckpointReminder(transcript)) return result
  try { notify(CHECKPOINT_REMINDER) } catch { /* UI failure must not discard model context. */ }
  return { ...result, additionalContext: [...(result.additionalContext ?? []), CHECKPOINT_REMINDER] }
}
