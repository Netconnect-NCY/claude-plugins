# Credentials, routing and client access

## Trigger

Connect a client, recover the local-edit/client gate, manage authorized credential sharing/pool preferences, or inspect provider/model availability.

## Exclusions

Never request keys, tokens or auth files in chat; use browser intake. Do not silently change sharing, pool use, owner settings or App permissions. An override, stale metadata or detection failure never authorizes local implementation. Repository code must receive only auth-proxy placeholders, never AI secrets.

## Inputs

Intended service URL, current client capabilities/project metadata and role, provider/kind or account ID (not secrets), and explicit authorization for any sharing/contribution/preference change. Organisation membership alone gives neither work authorization nor pool consent.

## Operations

For setup use **Connect**; for consent and account changes use **Accounts and sharing** or **Organisation AI pool**; for provider eligibility use **Supported credentials**, **Quota weighting**, **Routing defaults** and **Routing inspection**. Guard refusals and `plan_only_client_required` are under **Recovery**.

### Connect

Swarm2 is a remote MCP server (Streamable HTTP, `https://swarm2-mcp.netconnect.ro/mcp`, Keycloak realm `netconnect`, pre-registered public OAuth client `swarm2-mcp`, PKCE, no client secret or DCR) that keeps a project's plan, decisions, handoffs and runs in PostgreSQL and executes coding tasks on isolated remote workers. For client setup, add that production Streamable HTTP endpoint and complete browser OAuth with the public client above. The Claude Code plugin uses `${user_config.baseUrl}/mcp`; `baseUrl` is configurable and defaults to `https://swarm2-mcp.netconnect.ro`. Use the intended service URL and confirm the connection with `swarm_capabilities` and `swarm_projects`.

Client support: Claude Code is verified; ChatGPT and Codex are not yet verified (install routes, plan limits and the evidence checklist are in `docs/clients/chatgpt.md` and `docs/clients/codex.md`).

### Accounts and sharing

- `swarm_project_share_accounts({ repo, enable })`: owner only, destructive. Lends the owner's AI and GitHub accounts to members' runs on that project; without a consenting owner or an eligible enabled organisation pool, a maintainer's accepted run is `blocked` (repository-access checks may reject submission earlier). Disabling sharing blocks other members' active runs using that owner's accounts. Invitations and promotions never grant consent. Never enable it for the user without their explicit request.

Credentials (each user's own vault; maintainers can use a consenting owner's accounts for runs; registering a repository needs your own GitHub token unless the organisation's GitHub App is installed on it):

- `swarm_credentials_status()`: own provider/kind metadata and top-level `use_org_pool` (default **true**); never returns secrets.
- `swarm_org_pool_usage_set({ user?: UUID, enable: boolean })`: set the caller’s preference when `user` is omitted. Self is allowed; organization admins/owners can edit **any same-org member**, including admins and owners. Ordinary members cannot edit others; cross-org edits are denied. Every accepted call audits actor, target, org and old/new values. Browser controls live on `/me/credentials` (personal, separate from sharing) and `/me/org` (members).
- Pool preference belongs to the **requester**, not the credential owner. Default on; the separate organization-wide `pool_enabled_for_runs` master switch must also be on. Off forbids selecting, decrypting or using organization pool accounts in routing, classification and dispatch. Own and authorized shared accounts remain usable; if unavailable, the exact reason is `org_pool_disabled_for_user`, even with an empty or disabled organization pool. An allowed account cooling down retains its quota wait. Existing sharing consent is unchanged. Disabling cancels active pool-backed runs; enabling does not restart them. Never change the preference without the user’s authorization.
- `swarm_credentials_link()`: one-time URL (15 minutes) to the credential page. Prefer it: the secret never enters the chat.
- `swarm_credentials_set({ provider, kind, secret, config? })` exists for direct storage, but secrets remain in chat history. Use browser intake instead; never request or send secrets in chat/tool arguments.

### Organisation AI pool

`swarm_org_credentials_status()` reports metadata and `pool_enabled_for_runs`, never secrets: one entry per account with its `id`, provider/kind, optional `label`, contributor and `can_remove` for the caller, plus the caller's `your_role` and `permissions`. A provider/kind may hold several accounts (e.g. two GLM keys); each is a separate account for quota failover, remaining-quota weighted selection and per-account concurrency. Refer to accounts by `id` (and label), not by provider/kind alone, which may be ambiguous. Never request keys, tokens or auth files in chat. Organisation scope is not available through `swarm_credentials_login_start`; use the organisation link.

**Every organisation member** may contribute their OWN AI accounts — `swarm_org_credentials_link()` for a single-use, 15-minute browser URL that adds another account (never replaces one), the add form on `/me/org/credentials`, or **Give to pool** — and may remove only accounts they added. There is no separate member opt-in setting for contributions. Owners/admins may remove any account and alone turn **pool enabled for runs** on or off. Removal happens on `/me/org/credentials` by account ID. The page/link always adds; to rotate there, add the new account then remove the old ID. Store `replaceId` replaces exactly one same-pair account, preserves its contributor/date and rotates its version ID; old mounted attempts become stale. Members may replace only their own contributed entries; owners/admins may replace any.

`swarm_org_pool_contribute({ provider, kind, label?, idempotency_key? })` (write scope) copies the caller's OWN stored personal AI credential of that pair into their current organisation's pool without retyping the secret (the browser equivalent is the **Give to pool** button on `/me/credentials`). It is strictly self-only: no user or organisation parameter exists, so never try to contribute someone else's account. GitHub and Bunnyshell credentials are refused. Always pass an `idempotency_key` so a retry does not add a second copy. The server decrypts with personal AAD and re-encrypts with organisation AAD under current-membership and credential locks; it audits `org.pool_credential_contributed` fail-closed. It returns the new entry's metadata only. The copy is independent: changing or deleting the personal credential leaves it, and removing the shared copy leaves the personal credential. Only contribute when the user explicitly asks to share that account with their organisation.

### Supported credentials

The pool accepts exactly the AI provider/kind pairs in `CREDENTIAL_OPTIONS`:

| AI credential provider | Supported kinds |
|---|---|
| `anthropic` | `api_key`, `oauth_token`, `subscription_token` |
| `openai` | `api_key`, `subscription_token` |
| `glm` | `api_key` |
| `deepseek` | `api_key` |
| `kimi` | `api_key` |
| `anthropic_compatible` | `api_key` |
| `qwen` | `api_key` |
| `xai` | `api_key` |
| `gemini` | `api_key`, `subscription_token` (Google AI Pro login file `~/.gemini/oauth_creds.json`; web page only, never chat or `swarm_credentials_set`) |

The pool accepts all AI provider/kind pairs from `CREDENTIAL_OPTIONS`; other combinations are invalid. Anthropic accepts `oauth_token` as well as `subscription_token` (the latter from `claude setup-token`). OpenAI subscription intake takes the complete `~/.codex/auth.json` from `codex login`.

Qwen (Alibaba Model Studio Token Plan) is its own provider `qwen`, separate from `anthropic_compatible` (both may coexist): config `{region, model}` with a region from a fixed allowlist, default `ap-southeast-1` and `qwen3.8-max`; the API key is entered only on the credentials web page. An `anthropic_compatible` gateway requires an API key plus `config.base_url` and `config.model`, validated by the same rules as personal credentials: an HTTPS base URL resolving to public addresses and a single-token model ID (1–200 characters; no whitespace, quotes or control characters). The proxy revalidates the upstream destination at connection time. Kimi accepts only a Kimi Platform key from `platform.moonshot.ai` for `api.moonshot.ai`; Kimi Code subscription/OAuth logins and `platform.moonshot.cn` keys are unsupported.

**Kimi subscription gap (required follow-up).** `kimi/api_key` is supported. Current intake rejects Kimi subscription/OAuth credentials: there is no subscription kind, login/token intake or worker/pool wiring. Track that subsystem separately from pool delivery and obtain the owner’s scope decision before implementing it. Never infer implementation from a PR title or research notes.

`github` and `bunnyshell` are excluded from the AI pool. Existing `github_app` rows in `organization_credentials` remain controller-only and separate from AI pool status, management and worker loading; expanding AI support must not alter those rows or expose their secrets. Organisation Bunnyshell secrets also remain a separate controller-only facility.

The organisation-wide pool switch is disabled by default. Credential presence, organisation membership, invitations and promotions grant neither pool consent nor new work authorisation. Keep existing project owner/maintainer rights and owner-sharing consent; select eligible owner accounts before an already enabled, authorised organisation pool, including quota failover. `claude` uses `anthropic`, `codex` uses `openai`, and the other providers use their matching pool credentials; `auto` follows existing routing eligibility. Explicit providers remain pinned; cooldowns, `waiting_quota`, retry timing and the existing wait cap are unchanged. Never silently enable sharing or the pool, or bypass a quota wait.

Pool management retains current RBAC, signed browser sessions, fresh sign-in for storage, same-origin/CSRF protections, single-use nonces, organisation locks and current-membership checks. AI secrets stay in the auth proxy; repository code receives placeholders. Status, logs and events must not reveal secrets or the gateway URL.

### Quota weighting

Same-provider accounts within the selected source/model/billing tier are weighted by remaining current-window quota. The remaining fraction is one minus the larger of provider-reported usage and recorded window tokens divided by measured exhausted-window capacity. Unknown capacity has neutral weight 0.5; weight is proportional at or above 10% remaining and tapers cubically below it (minimum 0.001 for non-exhausted accounts). Exhausted, cooling, invalid/unavailable and concurrency-full pool accounts are excluded. A known reset makes the old reading stale and eligible again. A 90%-versus-20% remaining pair receives about 82% versus 18% of seeded draws over many jobs, not a guarantee for a small batch. Each distinct account ID enters once; catalog duplicates do not multiply weight. Per-account capacity leases and configured concurrency limits apply to personal/shared and pool accounts; organization limits still apply. Owner accounts retain priority over pool accounts. The cubic weight is `max(0.001, 0.10 * (r / 0.10)^3)` for `0 < r < 0.10`; exhausted accounts have weight zero. Window weighting requires an exact subscription link and a configured window (known exhaustion stops still exclude accounts); unlinked accounts stay neutral.

### Routing defaults

**Routing defaults (provider `auto`).** Every organisation starts with a versioned default model catalog (rows marked `default`, editable at `/me/org/routing`; owner edits are never overwritten). Each queued run is classified once, d1–d5, before it is claimed: by a cheap model call when an authorized API key of the run's own credential source exists (eligible Anthropic/OpenAI API keys only; GLM Coding Plan keys and opaque subscription logins use the heuristic, never a standalone HTTP API), otherwise by a local, no-key heuristic (documentation-only scope is easy; a whole-repository refactor is d5). Classification source is `model`, `heuristic` or `fallback` (`fallback`/d3 only after a model error, timeout or invalid output). A run is never claimed before it has a classification: at most ten runs are classified per scheduler tick, the rest wait for the next tick. Policy: d1–d2 prefer GLM (`glm-5.3`/`glm-5.3-flash`), else a lighter Sonnet/Sol tier at medium effort; d3 is cheapest eligible; d4–d5 pick the frontier band at high effort (whole-repository refactors → `claude-opus-5-5` high when eligible; unknown context cannot fall through to legacy defaults). Catalog subscription support is metadata, not proof of account entitlement. Subscriptions are preferred over API at equal expected cost; same-tier accounts are drawn by remaining-quota weight, within configured per-account concurrency leases. Failures and verifier rejections only cascade upward (more effort, then a higher-capability model). Overrides: an explicit `provider` pins the provider (and still applies the difficulty/effort policy inside it); explicit `model`/`effort` are respected over the policy; gateways (`anthropic_compatible`) match only their validated configured model.

### Routing inspection

**Reading the decision.** `swarm_run_get` returns `routing` (null before the first decision): `difficulty`, `classification_source`, requested `provider`/`model`/`effort`, `why` (policy and reason codes) and up to four bounded `reasons`. These are what the router *requested*; `latest_attempt.model` is the model the worker observed. The control pane and `/me/control-panel` show the same line per run; classification reasons are hidden from teammates who cannot see the run's goal and dropped if they cannot be redacted. Free text is redacted before truncation; after mounted credentials are released, raw history model/reasons are withheld. Heuristic reasons require the fixed server allowlist. Malformed history yields no routing summary. Raw candidates and account references are never exposed. Old servers omit `routing`; treat it as optional.

**Seeing the routing table (read before you ask for a specific model).** `swarm_routing_table({repo?})` shows every catalog model with `codingPower`, `tier`, `priceClass` and, per source (own subscription, pool subscription, own API key, pool API key), the state `ok`, `cooling` (until), `reserved` (weekly reserve: used % and reserve %, until = the weekly reset), `exhausted` or `missing`; `reachable` means the router could use it for you now. Call it when a run waits in `waiting_quota`, before pinning a provider/model, or when the human asks what is available. `swarm_routing_explain({repo, difficulty 1-5})` previews, without creating a run, which model and account the router would choose for that difficulty and why each candidate was skipped (stable reasons such as `account_cooling`, `weekly_reserve`, `not_chosen_higher_cost`; `weekly_reserve` = a subscription account kept free for its owner once its weekly usage reaches 100 minus its reserve %, default 2; a run whose every account is reserved waits in `waiting_quota` until the weekly reset); `swarm_run_get` carries the same for a real run as `routing_explanation`. Accounts show as labels only (yours by type, the pool as `pool`). The default source preference is own subscription → pool subscription → own API key → pool API key, but the router really tries all your own accounts first and the pool only when none of them yields a choice, then ranks by difficulty policy, effort fit, capability and expected cost; a subscription without a usage measurement ranks after priced API keys. Trust the explain output over the default order. If the human says their account was reset early, call `swarm_credentials_recheck({scope:'me'})` (`scope:'org'` for pool accounts, owners/admins only): it asks the provider's status endpoint now (only providers that have one, today Kimi Code; others report `skipped_no_status_endpoint`), ends the cooldown on a confirmed reset, and is limited to one check per account per minimum interval (10 minutes by default; the tool description states the configured one) and refused with `conflict` when the server disables re-checks. Never paste secrets into any of these.

### xAI (Grok)

- Key: an xAI API key from [console.x.ai](https://console.x.ai/) → API Keys (inference key; billed per token). Personal: `swarm_credentials_login_start({provider:"xai",scope:"me"})` and give the human the browser link; the form offers only *xAI API key*. Organisation: any member contributes *xAI API key* (`swarm_org_credentials_link()` or **Give to pool**), as for every pool provider; runs use it only while **pool enabled for runs** is on. Only `api_key` is accepted for xai; never take the key in chat.
- Run: `provider:"xai"`; default model `grok-4.7`. Allowed: `grok-4.7` (effort `low|medium|high|xhigh`), `grok-4.3` (`none|low|medium|high`), `grok-build-0.1` (no effort); omit effort for the provider default. Any other model/effort is refused with `invalid_input`. `auto` uses calibrated cost/capability routing; legacy fallback orders xai last, with retries preferring a different provider.
- Prices and model facts come from official xAI pages retrieved 2026-11-09 (USD per million tokens; all tokens of a request cost 2x once its prompt reaches 200k tokens). Routing uses the long-context tier because task estimates do not bound request size. Catalog capability stays null until an owner calibrates it; no Grok performance has been measured.
- Runtime: Codex adapter against the xAI Responses API through the auth proxy, which injects only the selected key. A 429 cools that key and fails over owner-first to the enabled pool or waits; 401/403 are not quota. No live/paid xAI probe has been run, so do not claim live acceptance, latency or quality.

## Completion

Confirm connection with `swarm_capabilities` and `swarm_projects`. Report credential metadata and observed routing only; never disclose secrets or gateway URLs. Status reads do not probe providers, repair credentials or authorize fallback spending. Keep sharing consent, requester preference and the organisation pool switch distinct.

## Recovery

### Local-edit guard

The Claude Code plugin enforces the remote-implementation rule. In a checkout where any remote (any name, fetch or push URL) matches one of your Swarm2 projects in the fresh cached project list, or that has `.swarm2/project.yaml` at its root, it refuses Edit, Write, MultiEdit, NotebookEdit, and Bash commands that write into the repository or commit/push, with: "This repo is worked on through Swarm2 — submit a job (swarm_task_submit) or send a plan (swarm_plan_propose) instead". Reads, searches, tests, `gh pr view/diff/review`, writes outside the repository (`/tmp`, `~/.claude`, plan files) and every Swarm2 MCP call are never blocked. If the person explicitly wants a local edit and the plan-only restrictions below permit it, they can run `/swarm2-local on` for this session; it is recorded in an audit log and shown in the pane as "local edits ON". `/swarm2-local off` turns the guard back on. Never ask for the override to get around a refusal: submit a job or send a plan. This is a safety net: it reads commands statically, so other tools and unrecognised command forms can bypass it; the rule itself still applies. Each override is also reported to Swarm2 as an audit event (best-effort; a failed report never blocks it).

Remote matching is case-insensitive for `owner/repo` and supports `github.com`, `www.github.com` and `ssh.github.com`, including HTTPS, git and SSH URL forms. SSH aliases are resolved with `ssh -G`: a supported GitHub hostname matches normally, a resolved non-GitHub hostname does not, and a failed or timed-out lookup conservatively matches the remote's `owner/repo` path against the project list. The list expires after seven days; a missing or stale list cannot establish a remote match. When a fresh, nonempty project list is available and Git lookup succeeds, an unmatched GitHub-like remote warns but permits local edits unless the checkout marker independently guards it.

Fallback is conditional. Git lookup errors fail open outside a checkout with `.swarm2/project.yaml`; the marker keeps that checkout guarded even when Git or the project store fails. After an unexpected guard error, the fallback denies writes when it can identify the marker or a remote matching a fresh cached plan-only project the viewer does not own; otherwise it fails open. This error fallback compares SSH alias paths without resolving their hosts, so an alias path matching such a plan-only project is conservatively denied. A plan-only project elsewhere in the cache does not block an unrelated checkout. None of these detection limits authorizes local implementation.

Both `/swarm2-local on` and `SWARM2_LOCAL_EDITS=1` are refused for plan-only non-owners (including an unknown role). An override enabled elsewhere in the session cannot lift that restriction. For a marked checkout whose project cannot be identified, overrides are also refused while plan-only status is unknown: the list is missing/stale, or no remote matches and fresh metadata does not rule out a plan-only project the viewer does not own. Refresh the control feed with the status token configured via `/swarm2-token` (or call `swarm_projects`) and check `git remote -v`; repo names alone without project metadata do not rule plan-only out. A fresh list with metadata for every project and no plan-only non-owner restriction can rule it out even for an unmatched marked checkout. Refused overrides are audited too; do not use an override or a detection failure to evade the rule.

### Plan-only client gate

On a project with `plan_only` on, non-owners only plan: `swarm_task_submit` / `swarm_task_draft` answer `plan_only_project` (send the plan with `swarm_plan_propose`). In addition, every Swarm2 call that acts on such a project is accepted from a non-owner only from Claude Code or Codex with the Swarm2 plugin installed, up to date and its local-edit guard on. Otherwise the call fails with `plan_only_client_required` (its `reason` says which part is missing). When you see it, do not retry and do not try to work around it: tell the person, verbatim, to run

```
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install swarm2@netconnect
/plugin update swarm2
```

keep the guard on (no `/swarm2-local on`, no `SWARM2_LOCAL_EDITS`), and retry after the plugin has reported (restart the session if needed). `swarm_capabilities`, `swarm_projects`, `swarm_open_project` and `swarm_credentials_status` keep working and show the same fix in a `client_gate` field. Owners are exempt.

For invalid credentials and private diagnostic evidence use [monitoring and recovery](monitoring-recovery.md#recovery). For GitHub identity failures use [review and publication](review-publication.md#recovery).
