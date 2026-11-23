/** Advisory only: transcript text is untrusted and never authorizes a write. */
export const CAPTURE_REMINDER = 'Swarm2 capture reminder: list your follow-ups, deferred fixes, ideas and later/after-X commitments, and confirm a durable Swarm2 ID for each. Immediately use swarm_task_submit for authorized actionable work; for ideas or work awaiting authorization, load swarm_plan_get and propose changes.items with swarm_plan_propose. No local-only queue. Report unavailable APIs or refusals honestly; preserve approval boundaries.'

type RecordValue = Record<string, unknown>
const record = (v: unknown): RecordValue | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : null
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Read only the MCP result envelope, never arbitrary nested text or tool inputs. */
function payload(value: unknown, depth = 0): RecordValue | null {
  if (depth > 4) return null
  if (typeof value === 'string') {
    try { return payload(JSON.parse(value), depth + 1) } catch { return null }
  }
  const v = record(value)
  if (!v || v.isError === true) return null
  if (v.structuredContent) return payload(v.structuredContent, depth + 1)
  if (Array.isArray(v.content)) {
    for (const block of v.content) {
      const b = record(block)
      if (b?.type === 'text') {
        const parsed = payload(b.text, depth + 1)
        if (parsed) return parsed
      }
    }
    return null
  }
  return v
}

function durableIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    const m = record(message)
    if (m?.role !== 'assistant' || !Array.isArray(m.toolUses)) continue
    for (const value of m.toolUses) {
      const use = record(value)
      if (!use || use.isError || typeof use.tool !== 'string') continue
      const name = use.tool.replace(/^mcp__.+__/, '')
      if (!['swarm_task_submit', 'swarm_run_get', 'swarm_plan_get', 'swarm_plan_propose'].includes(name)) continue
      const data = payload(use.result ?? use.text)
      if (!data || data.error) continue
      if (name === 'swarm_task_submit' || name === 'swarm_run_get') {
        if (typeof data.run_id === 'string' && uuid.test(data.run_id)) ids.add(data.run_id.toLowerCase())
      } else if (name === 'swarm_plan_get') {
        const items = record(data.document)?.items
        if (Array.isArray(items)) for (const item of items) {
          const i = record(item)
          if (typeof i?.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(i.id) && i.status !== 'dropped') ids.add(i.id)
        }
      } else if (typeof data.revision_id === 'string' && uuid.test(data.revision_id) && ['pending', 'approved'].includes(String(data.status))) {
        // Pending proposals are durable, but not approved work. Require the revision ID, not a guessed item slug.
        ids.add(data.revision_id.toLowerCase())
      }
    }
  }
  return ids
}

/** Exclude quoted material and code before looking for the assistant's own commitments. */
function prose(text: string): string {
  return text.replace(/```[^]*?```|~~~[^]*?~~~/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’|(?:^|\s)'[^'\n]*'(?=\s|$|[.!?])/g, '')
    .replace(/`([^`]+)`/g, (_, code: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code) ? code : '')
}

export function needsCaptureReminder(transcript: unknown, lastAssistantMessage?: string): boolean {
  const messages = Array.isArray(transcript) ? transcript : []
  const ids = durableIds(messages)
  // Check the current turn only; tool-result user rows do not start a new turn.
  let start = 0
  for (let i = 0; i < messages.length; i++) {
    const m = record(messages[i])
    if (m?.role === 'user' && typeof m.text === 'string' && m.text.trim() && !(Array.isArray(m.toolResults) && m.toolResults.length)) start = i + 1
  }
  const texts = messages.slice(start).flatMap(value => {
    const m = record(value)
    return m?.role === 'assistant' && typeof m.text === 'string' ? [m.text] : []
  })
  if (lastAssistantMessage && !texts.includes(lastAssistantMessage)) texts.push(lastAssistantMessage)
  for (const text of texts) for (const clause of prose(text).split(/[\n.!?;]+|\b(?:but|also|unrelated)\b|,\s*(?=I\b|we\b)|\band\s+(?=I\b|we\b)/i)) {
    if (!/\b(?:follow[- ]?up|later|queued|defer(?:red)?|after\s+.{1,60}\s+(?:finishes|completes|lands))\b/i.test(clause)) continue
    if (!/\b(?:I(?:['’](?:ll|ve)|\s+(?:will|have))|we(?:['’](?:ll|ve)|\s+(?:will|have))|queued|deferred|follow[- ]?up(?=\s*:)|(?:fix|revisit|handle|implement|address)\b[^]*\blater)\b/i.test(clause)) continue
    if (/\b(?:no|not|never)\s+(?:new\s+)?(?:follow[- ]?ups?|queued|deferred)\b/i.test(clause)) continue
    // An ID elsewhere in the transcript (or even another sentence) cannot discharge this promise.
    const references = [...clause.toLowerCase().matchAll(/\b(?:swarm2\s+)?(?:run|task|plan[- ]item|revision)(?:[\s_]+id)?\s*[:#=]?\s*([a-z0-9]+(?:-[a-z0-9]+)*)/g)]
    if (!references.some(match => ids.has(match[1]!))) return true
  }
  return false
}

/** Stop supports additionalContext independently of its block/continuation decisions.
 * Never wait for transcript access beyond the downstream Stop: if it is still pending,
 * inspect the event's last message instead (possibly producing a conservative reminder).
 */
export async function captureStop<T extends { additionalContext?: string[]; block?: string; preventContinuation?: true; stopReason?: string }>(
  messages: () => Promise<unknown>, notify: (text: string) => void, next: () => Promise<T>, lastAssistantMessage?: string,
): Promise<T> {
  let transcript: unknown
  try {
    void messages().then(value => { transcript = value }).catch(() => {})
  } catch { /* Missing transcript API: use the Stop event text. */ }
  const result = await next()
  if (!needsCaptureReminder(transcript, lastAssistantMessage)) return result
  try { notify(CAPTURE_REMINDER) } catch { /* UI failure must not discard model context. */ }
  return { ...result, additionalContext: [...(result.additionalContext ?? []), CAPTURE_REMINDER] }
}
