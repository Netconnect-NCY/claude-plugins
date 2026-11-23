# Monitor, steer and recover runs

## Trigger

Track an accepted run, investigate failure or quota/path waits, steer/cancel work, or continue a resumable run.

## Exclusions

Project membership alone does not grant private run evidence or diagnostics. Do not duplicate auto-retries, bypass quota/scope approval, infer causes from missing evidence, or treat a queued steer as delivered.

## Inputs

`run_id`, current project membership and requester/recorded credential-owner identity, event cursor and steering version when available. Resume/steer/cancel additionally require owner/maintainer role; a resume needs an idempotency key.

## Operations

### Poll

- Submitting never waits for the job. Poll `swarm_run_get({ run_id })`, then `swarm_run_events({ run_id, cursor })` from a non-null `events_next_cursor`. Omit `cursor` if none exists; never send null. Follow non-null `next_cursor` for more pages; for later polling retain the last event id as a string.
- Lifecycle: `queued` → `running` → `succeeded` | `failed` | `blocked` | `cancelled` | `interrupted`; `running` → `awaiting_approval` after a scope-changing steer.
- Disconnecting or closing the chat does not cancel accepted work. A later authenticated session can poll with the `run_id` if it still has project membership and is the requester or recorded credential owner.
- `blocked` names what is missing (e.g. `the project owner has no <provider> credential`, `the project owner has not shared their accounts`). Fix the cause, then use the continuation procedure below.

Swarm2 sees only submitted content: it cannot read your chat, push into an old chat or know that a chat closed. Progress arrives by polling, the authenticated `/me/runs/status` or `/me/runs/stream` feed (read-only token from `/me/status-tokens`), or the Claude Code mod; nothing calls you back.

### Steering and cancelling

`swarm_run_steer({ run_id, instruction, expected_version, changes_scope? })` (requester or recorded credential owner, with owner/maintainer role; active runs):

- Steering is a versioned list. Pass the version you last saw; a stale one fails with `version_conflict` and `current_version`.
- The reply is a receipt (`version`, `status: "queued"`, `changes_scope`, `scope_reason`, `run_status`, `delivery`), not proof the engine read it.
- Delivery happens only at a safe point: the start of the next attempt (or a resume). An instruction that arrives while an executor runs stays queued; if that attempt then verifies, the run ends `interrupted` with `steering_pending` and you continue it with `swarm_run_resume`.
- Scope changes need re-approval: unless you pass `changes_scope: false` and the run declared `paths`, the steer counts as scope-changing, stops the current attempt and moves the run to `awaiting_approval`. The internal approval function has no exposed MCP tool or web route in this revision; the auto-merge settings page does not approve runs. Resume refuses `awaiting_approval` and cannot bypass carried scope approval. Prefer narrow steers on runs with `paths`.

`swarm_run_cancel({ run_id })` (requester or recorded credential owner, with owner/maintainer role; destructive) cancels immediately; the worker and its credential secret are removed on the next scheduler tick.

## Completion

Claim verified execution only for `succeeded`, `evidence_stale: false` and checkpoint verifier evidence matching the exact head under current policy. Check publication and merge separately using [review and publication](review-publication.md). Save run IDs, results and next actions in a checkpoint before stopping.

## Recovery

### Failure and test policy

- On a failure, read `latest_attempt.failure_class` and the evidence in `swarm_run_get` before deciding anything: `checkpoint.verifier_output_tail` (acceptance output, redacted; `verifier_full_output_tail` for the full suite), `status_reason` (ends with the last 1500 chars of that output) and the handoff. `code` means the work failed acceptance; `environment` means infrastructure (verifier or sweep error, crash, OOM kill shown as `pod_failed: container … OOMKilled`, lease expiry, transient GitHub or scanner fault); `policy` means a rule was broken (scope, secret, forbidden repo, refused GitHub access, a tracked file rewritten by acceptance, `unverified: …`).
- Retries are automatic; do not resubmit while the run is `queued` again. A `code` or `environment` failure with a stored clean candidate and attempts left requeues the run from that candidate, with the previous output in the goal; an `environment` failure at the limit grants one extra attempt once per run. `policy` is terminal: fix the cause, then resume.
- When acceptance legitimately rewrites a tracked file (e.g. `.phpunit.result.cache`, failing with "acceptance changed the candidate"), ask a project owner to add it to the test policy's `acceptance_ignored_paths` (`swarm_project_test_policy`, owner-only; ≤ 50 repository-relative globs, never `.git`), rather than weakening the acceptance command. `acceptance_env` pins `TZ`, `LANG`, `LC_ALL`, `CI` (defaults `UTC`, `C.UTF-8`, `C.UTF-8`, `true`). Ignored paths, resolved environment, verification services and toolchain image share one verification fingerprint. Changing any of them invalidates earlier verifier evidence, so publish or merge only after a run verified under the current policy.

- `swarm_project_test_policy({ repo, action: "get"|"set"|"clear", policy?, expected_revision?, idempotency_key? })`: members read; owners set/clear test commands and dynamic validation; no policy means clone-time auto-detection.

### Continuation

`swarm_run_resume({ run_id, provider?, paths?, whole_repository?, idempotency_key })` creates a new run linked by `continues_run_id`. It works across providers (Claude → Codex → Claude) for `interrupted`, `failed`, `cancelled` and `blocked` runs, and for a `succeeded` run whose evidence went stale. The requester or recorded credential owner can resume if still an owner/maintainer of the project. The optional provider defaults to `auto`.

What carries over:

- code state: the newest available clean stored candidate across attempts, or an applicable inherited seed; otherwise the latest recorded attempt base or inherited upstream base. With no recorded base, or stale evidence, it resolves the current base;
- the original goal (never truncated), then the previous run's applied steering in order, then the handoff inside an untrusted data block; queued steering stays queued for the new run's first attempt; a carried scope-changing steer makes the new run `awaiting_approval`, not `queued`;
- declared `paths` (the claim), acceptance command, base ref, attempt limit and the task's auto-merge opt-out. Passing `paths`/`whole_repository` that differ from the inherited claim is `invalid_input`. A run created before path claims (no `paths`) must be resumed with exactly one of `paths` or `whole_repository: true` (else `invalid_input`). Claims are acquired before the run is queued: when another unfinished run HOLDS overlapping paths the resume is still created and WAITS (status `queued`, `status_reason: waiting_for_paths`, `waiting_for_paths {blocking_run_id, path, blocking_pattern, since, deadline_at}` and a message; do NOT resume again). It waits with priority (never behind waiting submits) and starts from its recorded seed once the paths are free; it fails with `path_wait_expired` after the server's maximum wait.

Native provider sessions are never reused (`native_sessions_reused: false`): the new engine sees only the repository state and the composed goal, so work after the last uploaded candidate is lost. Possible results: `warnings: ["handoff_truncated"]`, `goal_too_long` (goal plus applied steering over 20000 chars), `conflict` (not resumable, seed missing, or the composed goal fails the secret scan). An `interrupted` run shows `resume_hint` in `swarm_run_get`.

### Diagnostics

When a call misbehaves, read its trace instead of guessing: `swarm_audit_trace({since,until,tool?,limit?})` (ISO `since`/`until` required; newest first; follow a non-null `next_cursor`, never send null) returns your own calls with `result`, `error_code`, `duration_ms`, `request_id` and redacted, bounded arguments (8 KiB) and response summary (2 KiB). Pass `user` only as a current organisation owner/admin; project ownership grants nothing, and unauthenticated calls are not attributed to anyone. Full redacted request/response bodies exist only while the human has enabled debug capture (1 h, 24 h or custom, at most 7 days) on `/me/audit` or `/me/org/audit`, and are kept 14 days (traces 365 days). No MCP tool enables it. If a result carries `_meta.debug_tracing` (or `error.data._meta.debug_tracing`), tell the human that debug capture is active until `until`. Do not put secrets in arguments: stored text is redacted best-effort. Example: `{"since":"2026-11-08T13:00:00Z","until":"2026-11-08T14:00:00Z","tool":"swarm_run_get","limit":20}`.

Each debug body is capped at 64 KiB after redaction; capture stops at wall-clock expiry and can be disabled in the same web form. The debug-setting audit and change commit together or fail closed. Missing/failed vault redaction withholds stored content; headers/cookies are never captured. Credential intake preserves only allowlisted provider/kind metadata, and trace-query responses are metadata-only to prevent recursive capture.

For provider/account failures, use `swarm_audit_trace({type:"errors",provider?,tool?,user?,since?,until?,limit?,cursor?})`: default last 24 hours, 1–100 rows (50 default), maximum 366-day window, newest recorded ID first. Keep explicit bounds/filters when following a non-null cursor. `tool` is an engine alias here (claude/codex); `provider` overrides it. Calls mode still requires since/until. Errors are requester-only unless you are a current organisation owner/admin explicitly selecting a UUID or `user:"all"`; project ownership or lending a credential grants no private diagnostic access. Web equivalents are `/me/audit?type=errors` and admin-only `/me/org/audit?type=errors`. Records carry trusted run/attempt/provider/credential/source/contributor attribution, HTTP/exit status and redacted message/stderr (2 KiB each, or withheld); history is visible for 365 days; physical trace/error/debug pruning runs in bounded scheduler retention batches, independently of indefinite audit retention. Do not copy private diagnostics into project messages.

Check `swarm_credentials_status` / `swarm_org_credentials_status` or their credential web pages for `health` (`ok`, `degraded`, `invalid`, `exhausted`, since and generic last_error). Pool members receive no last_error or attention details; owners/admins do. Health is bound to the exact credential ID and mounted ciphertext fingerprint. Invalid current versions are skipped by dispatch; a sibling account of the same provider remains eligible. Use the credential link/page to replace them; never paste secrets into diagnostics. Replacement resets health; otherwise recovery needs newer explicit allowed measurements or controller-verified success on the same version, while quota cooldowns expire separately. Pane/panel health and owner-only invalid attention complement the once-per-invalid-transition generic project notice. The plugin deduplicates invalid-transition toasts, does not replay initial history and sends no unsolicited notification into an old chat. Status reads do not probe providers, repair credentials or authorize fallback spending.

For attempt failures, read `swarm_run_get({run_id})` → `pod_diagnostics`. It returns the latest 20 captured attempts with status, capture/expiry times and controller-collected pod phases, container restarts/last states (including OOMKilled), recent matching events and redacted log tails. Follow non-null `next_before_attempt` via `diagnostics_before_attempt` for older captures. Existing private-run authorization applies; project membership alone grants no evidence access. Evidence is captured before cleanup and retained 30 days from attempt end; expired bodies are null. `available`, `partial` and `unavailable` distinguish evidence from missing/forbidden/timed-out reads; unsupported backends return `backend_unsupported`. Whole fetched content is redacted before bounds (5 seconds, four pods, 2 KiB stored log tail per container, 64 KiB total stored JSON); failed redaction withholds content. No Secret/environment values are returned. Missing or already deleted pods and previous-container logs cannot be recovered. Never infer a cause from unavailable evidence or paste secrets into diagnostics.

For credential health, quota availability or confirmed early resets, also use [credentials and client access](credentials-client-access.md).
