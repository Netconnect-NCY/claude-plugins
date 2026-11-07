# swarm2: one install for Swarm2 clients

One install gives you:

- **The Swarm2 MCP server** (`swarm2`). It logs in with NetConnect Keycloak using the pre-registered public OAuth client `swarm2-mcp` (Claude Code callback port 33418).
- **The shared `working-with-swarm2` skill.** It tells the agent how to open a project, save decisions, submit work, resume (Claude ↔ Codex), steer, and use members, messages and Git memory.
- **The live control pane in Claude Code.** `/swarm2` opens the pane, with a spinner while work is active, a status line and toasts. Nothing from the pane is sent to the model.

## Install in Claude Code

Run these commands in Claude Code:

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install swarm2@netconnect
```

The plugin targets **prod** (`https://swarm2-mcp.netconnect.ro`) by default. Its `baseUrl` setting supplies the MCP endpoint `${user_config.baseUrl}/mcp` and the pane's base URL. For the explicit **dev alternative**, override `baseUrl` with `https://swarm2-mcp-5ssd2i.netcompile.ro` in `/plugin configure swarm2@netconnect`.

If the marketplace is unavailable, add the MCP server manually instead:

```bash
claude mcp add --transport http --scope user --client-id swarm2-mcp --callback-port 33418 swarm2 https://swarm2-mcp.netconnect.ro/mcp
```

That fallback connects the server only; the plugin supplies the pane and bundled skill. Setup for other clients is on the [Swarm2 home page](https://swarm2-mcp.netconnect.ro/).

## First steps

1. **Authenticate the Swarm2 server:** open `/mcp` → `swarm2` (shown as `plugin:swarm2:swarm2` for a plugin connection) → **Authenticate**, then complete NetConnect Keycloak SSO. This MCP login is separate from credentials for remote workers.
2. **Store provider credentials:** ask the agent to call `swarm_credentials_link`, then open its one-time credentials link to store your AI-provider and GitHub credentials. Keep secrets out of chat.
3. **Optional: light up the control pane.** Create a read-only status token at `https://swarm2-mcp.netconnect.ro/me/status-tokens`, then run `/swarm2-token s2s_…` or set the plugin's sensitive optional `statusToken` setting. Use the same service as `baseUrl`. The status token authenticates the pane, not MCP.

The MCP server sends initialize `instructions` directing clients through `swarm_capabilities` → `swarm_projects` → `swarm_open_project`. Choose an authorized project returned by the server, then follow the [bundled skill](skills/working-with-swarm2/SKILL.md).

## Control pane and commands

- `/swarm2` opens the control pane.
- `/swarm2-token s2s_…` sets its read-only status token; the plugin's `statusToken` setting is the alternative.

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

OAuth uses the provided public client `swarm2-mcp`, authorization code + PKCE, and **no client secret** (`tokenEndpointAuthMethod: none`). The issuer is `https://auth.netconnect.ro/auth/realms/netconnect`, with authorization and token endpoints under `/protocol/openid-connect/auth` and `/protocol/openid-connect/token`. The Claude Code pane/hooks are client-specific; the MCP connection and skill are portable. Live Codex/ChatGPT callback compatibility remains to be verified.

<a id="mirror"></a>

## Publishing

This plugin is published to the public catalog [Netconnect-NCY/claude-plugins](https://github.com/Netconnect-NCY/claude-plugins) at `plugins/swarm2`. It is maintained in the Swarm2 source repository and copied into the catalog automatically whenever it changes there; changes made directly in the catalog copy are overwritten.
