# swarm2: one install for Swarm2 clients

One install gives you:

- **The Swarm2 MCP server** (`swarm2`). It logs in with NetConnect Keycloak using the pre-registered public OAuth client `swarm2-mcp` (Claude Code callback port 33418).
- **The shared `working-with-swarm2` skill.** It tells the agent how to open a project, save decisions, submit work, resume (Claude ↔ Codex), steer, and use members, messages and Git memory.
- **The live control pane in Claude Code.** `/swarm2` opens the pane, with a spinner while work is active, a status line and toasts. Nothing from the pane is sent to the model.
- **The local-edit guard in Claude Code.** In a checkout of a Swarm2 project it refuses local edits and commits: Swarm2 writes the code (see [below](#local-edit-guard)).

## Install in Claude Code

Run these commands in Claude Code:

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install swarm2@netconnect
```

Plugin **0.4.1** targets `https://swarm2-mcp.netconnect.ro`, the only deployed environment. Service dev was decommissioned on 2026-11-08. Its `baseUrl` setting supplies `${user_config.baseUrl}/mcp` and the pane URL. Target repositories still support dev/prod deployment APIs.

If the marketplace is unavailable, add the MCP server manually instead:

```bash
claude mcp add --transport http --scope user --client-id swarm2-mcp --callback-port 33418 swarm2 https://swarm2-mcp.netconnect.ro/mcp
```

That fallback connects the server only; the plugin supplies the pane and bundled skill. Setup for other clients is on the [Swarm2 home page](https://swarm2-mcp.netconnect.ro/).

## First steps

1. **Authenticate the Swarm2 server:** open `/mcp` → `swarm2` (shown as `plugin:swarm2:swarm2` for a plugin connection) → **Authenticate**, then complete NetConnect Keycloak SSO. This MCP login is separate from credentials for remote workers.
2. **Store provider credentials:** ask the agent for `swarm_credentials_link` or `swarm_credentials_login_start({provider:"codex",scope:"me"})`, then open its one-time browser intake link (not provider OAuth) to store your AI-provider and GitHub credentials. Keep secrets out of chat.
3. **Optional: light up the control pane.** Create a read-only status token at `https://swarm2-mcp.netconnect.ro/me/status-tokens`, then run `/swarm2-token s2s_…` or set the plugin's sensitive optional `statusToken` setting. Use the same service as `baseUrl`. The status token authenticates the pane, not MCP.

**Token precedence and 401 recovery.** A token saved with `/swarm2-token` (kept in the plugin store) wins over the configured `statusToken` setting; `/swarm2-token clear` removes it so the setting applies again. The setting is read once when the plugin starts. On an HTTP 401 the pane re-reads the store and retries once, only if the token changed; otherwise it shows "status token rejected" with the `/me/status-tokens` link. Create a new token and run `/swarm2-token s2s_…`, with no restart needed. The token is never logged or displayed.

The MCP server sends initialize `instructions` directing clients through `swarm_capabilities` → `swarm_projects` → `swarm_open_project`. Choose an authorized project returned by the server, then follow the [bundled skill](skills/working-with-swarm2/SKILL.md).

<a id="local-edit-guard"></a>

## The rule and the local-edit guard

Owner decision (2026-11-10): code for Swarm2 projects is written only by Swarm2, on the server. Your connected AI plans, reads, reviews and gives instructions:

**Plan locally → swarm_plan_propose; implement only via Swarm2 runs (swarm_task_submit); review and steer.**

Read the current plan with `swarm_plan_get`, send yours with `swarm_plan_propose` (or `swarm_plan_save` on a server without them), submit the work with `swarm_task_submit`, then follow, steer and review the run and its PR.

In Claude Code the plugin enforces the rule with a `tool.call` guard (`hooks/guard.ts` classifies, `hooks/guard-hook.ts` looks up the checkout). A checkout counts as a Swarm2 project when:

- any of its git remotes (`git remote -v`, every remote name, fetch and push) is a GitHub URL naming a repository in your Swarm2 project list (ssh, https and `.git` spellings normalized, owner/repo compared case-insensitively). Accepted hosts: `github.com`, `ssh.github.com` (e.g. `ssh://git@ssh.github.com:443/Org/repo.git`) and `www.github.com`. A remote on another host that is an ssh form (`git@github-work:Org/repo.git`, `ssh://…`) may be an `~/.ssh/config` alias: the guard runs `ssh -G <host>` (3 s timeout, cached per host) and reads its `hostname` line; a GitHub hostname counts, any other hostname (a real GitLab, say) does not. If `ssh -G` fails, times out or prints no hostname, the guard **fails closed** for that remote: the owner/repo path alone is compared with your projects, so a match blocks. https, git and local-path remotes never trigger an alias lookup. When no remote matches a project but one looks like GitHub, the guard prints `swarm2 guard: no Swarm2 project matches this checkout's remotes (<list>); local edits are allowed` to stderr, once per checkout per minute. The list comes from the pane's control feed and from any `swarm_projects` call, and is cached in the plugin store for 7 days; or
- it has `.swarm2/project.yaml` at its root (no list needed).

There it refuses Edit, Write, MultiEdit and NotebookEdit on files in the repository, and Bash commands that write into it or change its history: redirections (`>`, `>>`), `tee`, `sed -i`/`perl -i`, `mv`/`cp`/`rm`/`touch`/`mkdir`/`ln`/`chmod` into the tree, `git commit/push/apply/am/cherry-pick/merge/rebase/reset/checkout/stash/add`…, package changes (`npm install <pkg>`, `bun add`…) and formatters that write (`prettier --write`, `eslint --fix`…). The refusal reads: "This repo is worked on through Swarm2 — submit a job (swarm_task_submit) or send a plan (swarm_plan_propose) instead".

Never refused: reads, searches, `ls`/`cat`/`grep`, tests and builds, `git status/log/diff/show/fetch`, `gh pr view/diff/review`, writes outside the repository (`/tmp`, `~/.claude`, plan files), and every MCP call (plans and decisions sent to Swarm2 included). The guard fails open: if the checkout, its git remotes or the project list cannot be read, the call runs (only an unresolvable ssh alias fails closed, as above). It reads commands statically, so it is a guard rail, not a sandbox: a safety net, not enforcement. Other tools, other remotes or a determined user can bypass it.

**Override.** `/swarm2-local on` allows local edits for the current session; `/swarm2-local off` turns the guard back on; `/swarm2-local` shows the setting. Each change is appended to an audit log in the plugin store (`localEditsAudit`: timestamp, session id, value; the newest 1000 entries are kept) and reported to Swarm2 as an audit event (`POST /me/guard/override` with your status token, recorded as `plugin.local_edit_override`; best-effort, a failed report never blocks the override), and while it is on the pane shows a red **local edits ON** line and the status line says so. An automated environment (for example a CI or server-side agent with this plugin installed) can set `SWARM2_LOCAL_EDITS=1` before starting Claude Code; that is audited too, with source `env`.

## Work protocol

After opening the project, call `swarm_context_search` / `swarm_context_get` before planning and `swarm_code_map({repo,ref?,query?})` for bounded, read-only orientation at a resolved base SHA. For definitions, references, callers, symbol search and file outlines prefer `swarm_code_definition`, `swarm_code_references`, `swarm_code_callers`, `swarm_code_symbols` and `swarm_code_outline` (cache-only; `not_indexed`/`index_unavailable` start no work, fall back to the map or grep; see docs/CODE_NAV.md). Save decisions during work with `swarm_memory_propose` (`type:"decision"`). Check active claims, submit narrow authorized paths with a real acceptance command, and preserve exact head/verifier/test evidence in a checkpoint. Success, PR publication, merge and deployment are separate outcomes.

Default roles are viewer (reads), developer (plans/memory/own runs/PRs), maintainer (also scope approval/merge/deploy requests), owner (also settings/members/targets/production approval). Effective overrides, non-owner `branch_scope` and private-run visibility still apply.

`swarm_account_sharing_set({enable})` changes your AI lending consent on owned projects, never GitHub; project overrides win. Enable only on explicit request. `swarm_org_credentials_status` reports the pool and enablement; org owners/admins manage it through `swarm_org_credentials_link` and the browser.

The routing catalog selects provider/model/effort by difficulty and cost with bounded failure cascades. `/me/org/routing` shows catalog, difficulty matrix and simulation. Explicit model/effort need an explicit provider. Quota behavior is described below; credential presence never grants pool consent.

Owners inspect `swarm_deploy_targets_get` / `swarm_deploy_targets_discover`; singular `swarm_deploy_target_set` configures a target. Review `swarm_project_setup_plan` before `swarm_project_setup_apply`. Production target changes need a fresh-login owner's confirmation URL; every production deploy request separately needs owner approval. Org owners/admins use `swarm_org_secret_link({kind:"bunnyshell"})` for secret intake in the browser. Never paste keys in chat.

See the [skill](skills/working-with-swarm2/SKILL.md) for exact procedures and [client guides](../../docs/clients/generic-mcp.md) for authentication/acceptance. A configured repository denylist returns `forbidden_repo`; there is no fixed ban on Swarm2 repositories.

## Control pane and commands

- `/swarm2` opens the control pane.
- `/swarm2-token s2s_…` sets its read-only status token; the plugin's `statusToken` setting is the alternative.
- `/swarm2-local on|off` allows or blocks local edits to Swarm2 repos for this session (audited; see [the local-edit guard](#local-edit-guard)).

The pane polls `GET <baseUrl>/me/control` with `Authorization: Bearer <statusToken>`, falling back to `GET <baseUrl>/me/runs/status` for older servers. It shows a spinner during active work and keeps the status line. The control sections are:

- **ACCOUNTS:** provider accounts and their reported health/usage.
- **NEEDS YOU:** items requiring your attention. Scope and production deploy approvals appear only where your rights in that
  project include `run.approve_scope` / `deploy.prod.approve` (the project row's `capabilities`); the basic status feed carries
  no rights, so on it a deployment awaiting approval is listed under DELIVERY only.
- **MY REPOS:** your repository runs and progress.
- **OTHERS:** other visible activity.
- **DELIVERY:** active and recent deployments (repo, target, phase/status, pipeline link, reason).
- **CAPACITY:** reported usage and capacity.
- **MESSAGES:** project messages from the last 24 h (time, sender, repo, body).

Merge toasts use the recorded merge outcome: “merged” appears once on a change
to `merge_status: merged`, with the short merge SHA when available. A pending
merge that becomes blocked, times out, fails or is skipped reports that outcome
and its reason. The `merging` phase alone never announces success. PR-opened
and terminal run status toasts remain; the first poll does not replay history.

Deployments toast when they reach `done`, `failed` or `awaiting_approval`
(including a new prod request that starts out waiting for approval). Each new
project message toasts once; more than three at once collapse into one summary
toast. Servers older than M-G send no deployments or messages; the pane then
shows runs only.

## Codex / OpenAI

The same `plugins/swarm2` folder is also a portable Codex / OpenAI plugin: root `plugin.json` identifies the package, root `mcp.json` declares a `streamable-http` server at `https://swarm2-mcp.netconnect.ro/mcp`, and `skills/working-with-swarm2/SKILL.md` is shared with Claude Code. In Codex CLI, run `codex plugin marketplace add Netconnect-NCY/claude-plugins`, then install the swarm2 plugin from that marketplace (Plugins directory). Alternatively, install this folder through a local plugin marketplace; see the [official packaging instructions](https://developers.openai.com/plugins/build/plugins).

OAuth uses the provided public client `swarm2-mcp`, authorization code + PKCE, and **no client secret** (`tokenEndpointAuthMethod: none`). The issuer is `https://auth.netconnect.ro/auth/realms/netconnect`, with authorization and token endpoints under `/protocol/openid-connect/auth` and `/protocol/openid-connect/token`. The Claude Code pane/hooks are client-specific; the MCP connection and skill are portable. Live Codex/ChatGPT callback compatibility remains to be verified. When configured, the external GitHub issuer separately advertises public-client DCR through discovery metadata; the bundled connection uses the static Keycloak client.

<a id="mirror"></a>

## Publishing

This plugin is published to the public catalog [Netconnect-NCY/claude-plugins](https://github.com/Netconnect-NCY/claude-plugins) at `plugins/swarm2`. It is maintained in the Swarm2 source repository and copied into the catalog automatically whenever it changes there; changes made directly in the catalog copy are overwritten.

Quota waits appear under NEEDS YOU and as a paused “waiting for quota” run, with the earliest automatic retry when known. An account's “quota cooldown” window shows when it becomes eligible again, without inventing a remaining balance. The scheduler resumes eligible work automatically; updating the credentials owner's account can permit an earlier retry. Explicit providers stay pinned and the organisation pool is used only when already enabled and authorized. The default maximum wait is 24 hours (`SWARM2_QUOTA_MAX_WAIT_SECONDS`); expiry fails with `quota_exhausted`. See `docs/QUOTA_FAILOVER.md` in the source repository for continuation and visibility rules.

Code map refs are cache-only: full commit SHA or a unique cached hex prefix of at least 7 characters. Omit `ref` for the most recently built/used cached map, which may differ from the current branch head. Branch/tag names are refused. `status:not_cached` means no usable cached map exists; `status:withheld` means safety checks could not pass. Neither starts work. Maps are built at run startup; retain the returned `sha`. Queries match any of at most eight whitespace-separated terms on paths/symbol names (case-insensitive, 200 characters maximum). Map text is capped at 24 KiB, and the complete MCP result at 64 KiB; `truncated` reports omitted content.
