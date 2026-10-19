# ssh-fleet-connect

Connects Claude (Desktop, web, Claude Code) to **ssh-fleet**, NetConnect's network and voice assistant.

This plugin contains only the server address and the login setting:
- the MCP server `https://mcp.ssh-fleet.netconnect.ro/mcp/`;
- Keycloak SSO with the public PKCE client `ssh-fleet-cli`.

It contains no infrastructure data and no credentials. Access comes only from signing in with a NetConnect account, and each person gets the rights of their own ssh-fleet role.

## Install in Claude Desktop

1. *Customize → Cowork → Plugins → Add → Add marketplace → Add from a repository*, then enter `Netconnect-NCY/claude-plugins`.
2. Install **ssh-fleet-connect**.
3. Open its **Connectors** tab, click **Connect** and sign in with your NetConnect account.

## Install in Claude Code

```
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install ssh-fleet-connect@netconnect
```

Then run `/mcp`, pick ssh-fleet and log in.

## Who should use which plugin

- Use **ssh-fleet-connect** if you are on the routing or commercial team, or if you only want the connection. The network-operations method is served by the ssh-fleet server itself after login.
- Use **ssh-fleet** if you are on OPS or an engineer in Claude Code and want the extra Claude Code hooks and commands. It needs read access to a private repository.

Install one of the two, not both: they connect to the same server.

Guide, in Romanian: https://ssh-fleet.netconnect.ro/ui/docs/ghid-acces-readonly (office or VPN, SSO).
