# NetConnect — AI client plugins

This repository contains NetConnect's **`netconnect` marketplace** for [Claude Code](https://claude.com/claude-code), the native Codex catalog under `.agents/plugins/marketplace.json`, and source-managed plugin distributions. Client-specific installation instructions are listed below. Swarm2's canonical source lives in `Netconnect-NCY/swarm2-mcp`; its packaged copy here is generated.

## Quick start

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install golden-path@netconnect
```

Then **quit and restart your Claude Code session** — plugins are loaded at session start.

> **Scope tip:** if you install while inside a project directory, the plugin is enabled only for that project. To use it across every project, run the install commands from a non-project shell (e.g. `cd ~ && claude`).

## Available plugins

### `golden-path`

Walks a project through the [NetConnect Golden Path](https://github.com/Netconnect-NCY/golden-path)'s 10 checkpoints — source control, Bunnyshell deploy, MCP, logging, docs, "what's new" UI, Keycloak SSO, centralised logging, portal listing, AI support bot.

**Provides:**
- `/golden-path:start` — slash command, walks the full sequence with mode + scope upfront.
- `golden-path:follow` — orchestrator skill, triggers on "follow the golden path", "bootstrap an NCI app", etc.
- Per-checkpoint skills (`golden-path:source-on-github` … `golden-path:ai-support-bot`) — invokable individually for brownfield work ("add MCP to this service", "deploy to Bunnyshell").

```text
/plugin install golden-path@netconnect
```

Source: [`Netconnect-NCY/golden-path`](https://github.com/Netconnect-NCY/golden-path) (plugin lives under `./plugin/`).

### `ssh-fleet`

Everything to work with **ssh-fleet** from your AI, in one install:
- the **ssh-fleet MCP connection** (`https://mcp.ssh-fleet.netconnect.ro/mcp/`): fleet
  inventory, network devices, BMCs, observability and security integrations;
- **sign-in with Keycloak SSO** using your own NCI account. There is no API key to copy, and
  your rights are your ssh-fleet account's;
- the **`network-operations` skill**: it investigates before it changes anything, keeps
  competing hypotheses, and plans every change with blast radius, rollback and approval;
- its startup check, trace and retrospective hooks.

**Claude Code** (from a non-project shell, `cd ~ && claude`):

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install ssh-fleet@netconnect
```

Restart Claude Code, then `/mcp` → `ssh-fleet` → log in in the browser. Check the skill with
`/ssh-fleet:network-operations`.

- Already have `ssh-fleet` added by hand on the same URL? Claude Code keeps yours and skips
  the plugin's, so you get no duplicate tools.
- Had the old `network-operations` plugin? Remove it first, or the skill loads twice:
  `/plugin uninstall network-operations@netconnect`.

**ChatGPT / Codex:** OpenAI's plugin system reads this same catalog.
`codex plugin marketplace add Netconnect-NCY/claude-plugins`, then
`codex plugin add ssh-fleet@netconnect`. For a whole ChatGPT workspace, an admin publishes
it to the workspace from ChatGPT's Plugins page.

Source: [`Netconnect-NCY/ssh-fleet-plugin`](https://github.com/Netconnect-NCY/ssh-fleet-plugin), a read-only mirror of `ssh-fleet-mcp/claude-plugin/` (edit there). For ChatGPT, give the GitHub connection access to `ssh-fleet-plugin` only.

### `swarm2`

Plan, delegate, monitor and verify remote coding work through the Swarm2 MCP server and NetConnect Keycloak SSO. The package includes the `working-with-swarm2` skill and the client-specific adapters. Project permissions, guarded `plan_only` behavior and server-side approval/verification rules still apply.

**Claude Code:**

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install swarm2@netconnect
```

Open `/mcp`, select Swarm2 and authenticate with your NetConnect account.

**Codex CLI:**

```bash
codex plugin marketplace add Netconnect-NCY/claude-plugins
codex plugin add swarm2@netconnect-claude-plugins
```

The Codex catalog name is `netconnect-claude-plugins`; the Claude catalog name is `netconnect`. Use the existing published ChatGPT plugin or workspace distribution for ChatGPT; installing a local CLI plugin does not by itself publish a ChatGPT connector.

#### Install in Antigravity

The standalone distribution is [Netconnect-NCY/swarm2-plugin](https://github.com/Netconnect-NCY/swarm2-plugin). It is generated from the canonical Swarm2 plugin together with this catalog's copy.

**Rollout prerequisites:** the source publication workflow must have populated the standalone repository with the native Antigravity manifest, `mcp_config.json` and `hooks.json`; the deployed backend must advertise the exact MCP resource URL; and the Keycloak client must allow the callbacks listed below. Repository creation or a passing package validation alone does not prove that live OAuth works.

Once those prerequisites are complete, install from one command:

```bash
agy plugin install https://github.com/Netconnect-NCY/swarm2-plugin
agy plugin list
```

- **Antigravity App:** the App and CLI share installed plugins. Open **Customizations → Installed → MCP Servers**, select Swarm2 and complete the Keycloak OAuth sign-in.
- **Antigravity CLI:** open `/mcp` to check the Swarm2 connection and complete the prompted OAuth flow.
- **Antigravity IDE:** open the agent panel's **MCP Servers → Manage MCP Servers** and check the installed Swarm2 connection; complete the browser sign-in when prompted.

The native server configuration uses `https://swarm2-mcp.netconnect.ro/mcp` and public OAuth client `swarm2-mcp`. No status token is required merely to install or enable the MCP connection. Non-owners on restricted `plan_only` projects must additionally configure the optional local status token so the plugin can report its active guard; follow the [packaged README](plugins/swarm2/README.md). The report never grants project permissions.

Administrators must retain existing redirect URIs and allow these exact additional callbacks on the public PKCE client:

```text
https://antigravity.google/oauth-callback
https://antigravity.google.com/oauth/callback
```

Both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` must return `resource: https://swarm2-mcp.netconnect.ro/mcp`. Complete release verification with a clean Antigravity install, successful Keycloak sign-in and real `swarm_capabilities` and `swarm_projects` calls.

**Partner Marketplace status:** a GitHub distribution is separate from Antigravity Partner Marketplace approval. Do not use `swarm2@antigravity-plugins-partners` or its deep link until the listing is accepted and published.

**Source of truth:** [Netconnect-NCY/swarm2-mcp](https://github.com/Netconnect-NCY/swarm2-mcp), under `plugins/swarm2`, with canonical skill content under `skills/working-with-swarm2`. Do not edit this repository's `plugins/swarm2` or the standalone mirror directly: the next source publication replaces them. Catalog-level README and Claude marketplace entries are maintained here; the Codex catalog is generated by the source publisher.

## Updating

```text
/plugin marketplace update netconnect
```

This refetches the catalog. Individual plugins update from their source repos on install/reinstall.

## Contributing a plugin

Plugins maintained by NetConnect each live in their own repo (so they version, ship, and are issue-tracked independently). To add one to this marketplace:

1. Build the plugin in `Netconnect-NCY/<plugin-name>` (or `<plugin-name>-plugin` if the bare name is taken by an unrelated repo). Follow the [Claude Code plugin guide](https://code.claude.com/docs/en/plugins).
2. Open a PR against this repo that adds an entry to `.claude-plugin/marketplace.json` referencing the new repo (use `github` source, or `git-subdir` if the plugin lives in a subdirectory like `golden-path` does).
3. Once merged, users get it on the next `/plugin marketplace update netconnect`.

## License

Plugins are licensed per their source repository. This catalog itself carries no separate license.
