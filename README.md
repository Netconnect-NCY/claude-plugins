# NetConnect — Claude Code plugins

This repository is the **`netconnect` marketplace** for [Claude Code](https://claude.com/claude-code) plugins maintained by NetConnect. Each plugin lives in its own repository; this one is just the catalog.

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

### `network-operations`

Teaches Claude to work as a careful network engineer through the **ssh-fleet MCP**:
- it investigates before it changes anything;
- it adjusts investigation depth to the problem;
- it keeps competing hypotheses and resolves contradictions;
- it plans each change with blast radius, pre-checks, rollback and approval, then
  verifies the change against the original symptom.

**Provides:** the `network-operations:network-operations` skill. It triggers on
"X can't reach Y", firewall/ACL, VPN, SIP/SBC, routing, monitoring gaps, or any "push/restart
this on prod" request. You can also call it explicitly.

**Requires:** the ssh-fleet MCP, connected with your own identity:

```bash
claude mcp add --transport http --client-id ssh-fleet-cli -s user ssh-fleet https://mcp.ssh-fleet.netconnect.ro/mcp/
```

Then run `/mcp` → `ssh-fleet` → log in through Keycloak. Keep the trailing slash on the URL.

```text
/plugin install network-operations@netconnect
```

Source: [`Netconnect-NCY/ssh-fleet-mcp`](https://github.com/Netconnect-NCY/ssh-fleet-mcp) (the plugin lives under `./claude-plugin/`).

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
