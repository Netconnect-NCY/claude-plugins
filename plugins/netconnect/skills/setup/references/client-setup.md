# Client setup routes

Use only the route for the user's actual client. Connection names may include
plugin prefixes; use names returned by that host rather than guessing them.

## ChatGPT web or desktop

1. Discover the selected service through the host's available plugin management
   or plugin directory. Inspect existing connections first.
2. Use the exact returned plugin entry and supported install/connect action.
   Complete the provider's sign-in flow if required.
3. Check the tool inventory in a conversation that has loaded the connection,
   then perform the bounded readiness check.

A workspace administrator can import the marketplace repository from GitHub
through **Admin → Plugins → Add → Import marketplace** where this feature is
available. Import is a workspace administration operation, not an automatic
side effect of a user asking for personal setup. Repository source:
`https://github.com/Netconnect-NCY/claude-plugins`.

An imported MCP plugin may be marked **Desktop only**, even when it has a remote
HTTPS URL. A CLI installation does not establish a ChatGPT web cloud connection.
Use a verified registered cloud app/plugin for web. Where the host enables
custom MCP connections, use its supported connection flow and the service's
current OAuth instructions. Do not fabricate an app ID, publish a cloud plugin,
or edit workspace settings as a shortcut. The setup package itself needs no MCP
connection; each selected service still needs its own availability and sign-in.

Sources: [OpenAI plugins](https://learn.chatgpt.com/docs/plugins),
[GitHub marketplace import](https://learn.chatgpt.com/docs/enterprise/plugin-management).

## Claude Code

Add the catalog once, if it is not already configured:

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
```

For a current catalog check, update its metadata when needed:

```text
/plugin marketplace update netconnect
```

Open the selected, verified catalog entry with
`/plugin install <plugin-name>@netconnect`, review it and choose **Install for
you** unless the user requested another scope. Follow the client's reload
guidance, then open `/mcp`, select the actual service entry and complete sign-in.
Refreshing the catalog is separate from updating an installed plugin.

To rerun this guide use `/netconnect:setup` after this plugin is loaded. For
Claude Desktop/Cowork, use that surface's actual plugin/connector interface;
do not present Claude Code slash commands as desktop UI actions.

Sources: [Claude plugin installation](https://code.claude.com/docs/en/plugins/install),
[Claude marketplaces](https://code.claude.com/docs/en/plugins/create-marketplace).

## Codex CLI

In the actual client environment, add the catalog once:

```bash
codex plugin marketplace add Netconnect-NCY/claude-plugins
```

Install the selected, verified entry with
`codex plugin add <plugin-name>@netconnect-claude-plugins`.
Use `codex mcp list` to inspect the real server names, then
`codex mcp login <server-name>` only for a connection that needs authentication.
Use the current client's supported update/reload action when necessary. Start
a session that loads newly installed skills before testing those skills.

The native catalog alias is `netconnect-claude-plugins`; Claude's alias is
`netconnect`. They are intentionally different. Public catalog access does not
grant access to private package sources.

Source: [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins).

## Other clients

Inspect the client's current official integration format and the service's
published adapter first. Do not assume Claude or Codex plugin packages work in
Gemini or another host. A supported remote MCP connection can be configured
directly using the service's documented endpoint and OAuth metadata, but skills,
hooks and in-chat UI remain host-dependent. Report untested surfaces explicitly.
