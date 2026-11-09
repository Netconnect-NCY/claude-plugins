// The pane's own idea of Swarm2's state. `/me/control` answers runs, accounts, others, attention, deployments and capacity in
// this shape; `/me/runs/status` adds the project messages and each run's merge reason and SHA, and on an older server without
// `/me/control` it is mapped onto the same shape (accounts, others, capacity, pool and projects then stay empty).

/** `_quota` is one persistent account cooldown: null percentage, scheduling retry in resets_at. */
export type UsageWindow = { name: string; used_pct: number | null; resets_at: string | null }

export type Account = {
  id: string
  provider: string
  kind: string
  label: string | null
  /** "you", or "pool · <contributor>" */
  owner: string
  /** ok | cooling | degraded | exhausted | invalid | unknown (degraded: provider rate limit / 5xx on the current version) */
  health: string
  /** Since when the degraded/invalid state has held; null when healthy, unknown, or an older server. */
  health_since?: string | null
  /** Generic redacted reason for failure health or cooldown (kind + HTTP status); null when healthy, hidden for pool accounts a
   * member views, or an older server. Never another user's run content. */
  last_error?: string | null
  /** True when invalid and dispatch skips this account until its owner replaces the credential; absent on older servers. */
  attention?: boolean
  /** Current invalid transition timestamp; visible to the owner or pool admin only. */
  notified_at?: string | null
  windows: UsageWindow[]
  observed_at: string | null
  in_use: number
  engine_workers: number
  users: { name: string; count: number }[]
}

export type EngineWorker = { id: string; vendor: string; model: string | null; last_action: string | null; since: string | null }

export type Run = {
  run_id: string
  repo: string
  requester: string | null
  mine: boolean
  goal: string | null
  status: string
  status_reason: string | null
  provider: string | null
  attempt: number | null
  phase: string
  /** Earliest quota retry, null when unknown/hidden or not waiting; absent on older servers. */
  quota_resume_at?: string | null
  started_at: string | null
  updated_at: string
  pr_url: string | null
  /** pending | merged | merge_blocked | checks_pending_timeout | failed | skipped, or null */
  merge_status: string | null
  /** From `/me/runs/status`; null when only the control feed answered. */
  merge_reason: string | null
  /** From `/me/runs/status`; null when only the control feed answered. */
  merge_sha: string | null
  validation_tier: string | null
  workers: EngineWorker[]
  tokens: number | null
  cost_usd: number | null
  /** Latest routing decision; null before the first decision, absent on older servers. */
  routing?: RunRouting | null
}

/** Bounded projection of a run's latest persisted routing decision. provider/model/effort are what the router REQUESTED, not
 * proof of application (see the observed worker model in `workers`). */
export type RunRouting = {
  difficulty: 1 | 2 | 3 | 4 | 5
  classification_source: 'model' | 'heuristic' | 'fallback' | null
  provider: string | null
  model: string | null
  effort: string | null
  /** Safe policy/reason text (enum words and catalog reason codes). */
  why: string
  /** Classification reasons; empty when the goal is hidden from the viewer or could not be redacted. */
  reasons: string[]
}

/** branch_scope: the branches the member may target (null = unrestricted; absent from older servers). */
export type ProjectMember = { name: string; role: string; you: boolean; active_runs: number; branch_scope?: string[] | null }
/** members is capped (the viewer, active members and owners first); more_members counts the rest. role is the viewer's
 * (viewer | developer | maintainer | owner); capabilities their effective rights there, absent from servers before roles. */
export type ProjectRow = {
  repo: string; role: string; capabilities?: string[]; active_runs: number; members: ProjectMember[]; more_members: number
  /** pending invites: a number only when the viewer owns the project; null or absent otherwise */
  pending_invites?: number | null
}

export type Other = { name: string; active_runs: number; models: Record<string, number> }

export type Attention = { kind: string; id?: string; text: string; url: string | null }

export type Deployment = {
  deployment_id: string
  repo: string
  target: string
  status: string
  /** queued | awaiting_approval | deploying | verifying | outcome_unknown | done | failed */
  phase: string | null
  pipeline_url: string | null
  reason: string | null
  /** The run that requested it; the status feed sends it, the control feed does not. */
  run_id?: string | null
  updated_at: string
}

export type Message = {
  id: number
  repo: string
  /** Verified in-organisation email, else the sender's user id; "system" for server notices. */
  from: string
  from_run_id: string | null
  body: string
  created_at: string
}

export type Capacity = {
  org_active: number
  org_limit: number
  queued: number
  pods: number | null
  today: { name: string; tokens: number; cost_usd: number }[]
  models: { model: string; tokens: number }[]
}

export type Feed = {
  /** Which feed drew the runs: the control feed, the basic status feed, or none yet. */
  source: 'control' | 'status' | null
  accounts: Account[]
  runs: Run[]
  others: Other[]
  attention: Attention[]
  deployments: Deployment[]
  /** The last 24 h of project messages, newest first (from `/me/runs/status`). */
  messages: Message[]
  capacity: Capacity | null
  /** The organisation pool switch; null on a server older than the pool field, or from the status feed. */
  pool: { enabled: boolean } | null
  /** Every project of the organisation the viewer is a member of, idle ones included; null on a server older than the
   * projects field, or from the status feed (the pane then lists runs only). */
  projects: ProjectRow[] | null
  error: string | null
  checkedAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'swarm2': { feed: Shaped<Feed>; frame: number }
  }
}
