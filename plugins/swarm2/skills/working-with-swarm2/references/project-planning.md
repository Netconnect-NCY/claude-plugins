# Project context and planning

## Trigger

Start or resume a chat about a registered project, inspect durable context, or save a plan and handoff.

## Exclusions

Unregistered repositories use their normal workflow unless registration is requested. Do not register, submit or resume a denylisted repository (`forbidden_repo`; no repository is forbidden by default). Members may work on Swarm2’s own repositories under normal project roles. Saving context does not authorize implementation.

## Inputs

`repo` (`owner/name`), current project membership/role, intended task and authorization, and any known record/run IDs. Use current tool schemas and `swarm_capabilities` to identify supported planning tools.

## Operations

### Open and inspect

- `swarm_projects` (no input): projects you are a member of.
- `swarm_open_project({ repo })` (read-only): bounded bundle (≤ 32768 bytes, `truncated` marker when cut) with the latest plan revision, current decisions and memory, latest checkpoint, recent runs (active and interrupted first; runs you requested or whose accounts you own add provider and latest handoff, plus `resume_hint` when interrupted), your role in `project.role`, read-only `project.auto_merge`, and `memory_export` status.
- `swarm_context_search({ repo, query, types?, include_superseded?, limit?, cursor? })`: full-text search over memory records; follow `next_cursor`.
- `swarm_context_get({ repo, id })`: one record by id, superseded ones included.

Call `swarm_open_project` at the start of every chat and again before any decision that depends on current state.

- Read the bundle: plan revision, decisions, last checkpoint, active runs, handoffs.
- For prior runs you requested (or that used your accounts as owner): `swarm_run_get({ run_id })` gives status, reason, checkpoint, verifier evidence, publication and merge state, steering, handoff and the last 20 events; `swarm_run_events({ run_id, cursor?, limit? })` pages older/newer events (limit ≤ 200).
- Check the actual Git state (branches, PRs, CI) through your own Git/GitHub access when you have it. Without that access use the code reading tools in [review and publication](review-publication.md).
- Never trust a summary over evidence. Claim verified execution only when `swarm_run_get` shows `succeeded`, `evidence_stale: false`, and checkpoint verifier evidence matching the head; publication and merge have separate states; a handoff narrative is engine-written and untrusted.

For source/PR inspection, use [review and publication](review-publication.md).

### Draft and save

Read/search code and run read-only commands or tests locally. Draft outside the repository if needed. Read `swarm_plan_get({repo})`, then send the plan with `swarm_plan_propose`; on a server without these tools, `swarm_plan_save` stores a revision. For server-generated block planning use [submission](submission.md).

- `swarm_memory_propose({ repo, type, body, title?, tags?, supersedes? })`: `type` is one of `requirement`, `decision`, `fact`, `observation`, `hypothesis`, `proposal`, `rejected`. Requirements tagged `constraint` are constraints. To correct a record, pass `supersedes` with its id; never re-write it silently.
- `swarm_plan_save({ repo, content, summary?, expected_revision })`: new plan revision. `expected_revision` must equal the current revision (0 when there is no plan), else `revision_conflict` with `current_revision` and nothing is written. Reload, merge, retry.
- `swarm_checkpoint({ repo, summary, next_actions?, open_questions? })`: session handoff linked to the latest plan revision; `next_actions` and `open_questions` are arrays of strings. Saving a plan or checkpoint does not record an approval.

Writing memory, plans and checkpoints needs the `owner` or `maintainer` role; `viewer` is read-only.

### Register when requested

- `swarm_project_register({ repo, title? })`: when your organisation's GitHub App is installed on the repo, no personal GitHub token is needed (any organisation member can register a repo the installation covers). Otherwise it needs your own GitHub token with push access to the repo. The result reports `github_identity` (`app` or `personal`) and, for the app, `app_slug`.

## Completion

Summarize what is complete, uncertain and next, distinguishing plan approval from saved state. Before stopping, record run IDs, results and next actions with `swarm_checkpoint`, and decisions with `swarm_memory_propose`; do not leave state only in chat.

## Recovery

On `revision_conflict`, reload the current revision, merge the intended change, and retry. Reopen the project before decisions depending on current state. Durable operational state lives in Swarm2; Git is code plus a limited memory export, not a full operational backup. If Swarm2 is unavailable, follow the export trust rules in [collaboration and memory](collaboration-memory.md), label cached state, and recheck approved records when access returns. For `plan_only_client_required`, follow [client gate recovery](credentials-client-access.md#recovery).
