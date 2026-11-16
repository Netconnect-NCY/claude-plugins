# sunday

The Sunday MCP connection for Claude Code, Claude Desktop and Codex.

- Server: `https://sunday.work/api/v1/mcp/rpc` (JSON-RPC over HTTP)
- Auth: Keycloak `netconnect` realm, public client `sunday-mcp` (PKCE). No secrets in this plugin.

## Install (Claude Code)

```
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install sunday@netconnect
```

Then `/mcp` → `plugin:sunday:sunday` → Authenticate, and sign in with your NetConnect account.

## Install (Codex)

```
codex plugin marketplace add Netconnect-NCY/claude-plugins
codex mcp login sunday
```

If you already added Sunday as a claude.ai connector, you don't need this plugin too — you'd get the same tools twice.
