# NetConnect Setup

Install this small guide once in each supported client, then ask:

> Help me connect the NetConnect services I need.

The setup skill checks what is already available, helps you choose the missing
connections, opens supported sign-in flows, and reports what it could verify.
It uses your own accounts and each service's existing permissions. It does not
include an MCP server, credentials, hooks or an automatic install-all action.

## Claude Code

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install netconnect@netconnect
/netconnect:setup
```

Skip adding the marketplace if it is already configured. Follow the client's
reload guidance if the new skill is not yet visible.

## Codex CLI

```bash
codex plugin marketplace add Netconnect-NCY/claude-plugins
codex plugin add netconnect@netconnect-claude-plugins
```

Start a session that has loaded the installed plugin, then ask it to use the
NetConnect setup skill. The package also declares an onboarding skill for
clients that expose a **Setup** action.

## ChatGPT

Use **NetConnect Setup** when it is available in your account or workspace's
plugin directory. A workspace administrator can import this marketplace from
GitHub. Import and publication must be verified in that workspace; this package
does not assert that a cloud entry already exists for every user.

The guide can help find a service's supported cloud plugin or connection flow.
Installing a CLI package does not connect ChatGPT web. If an entry is marked
**Desktop only**, use its verified cloud counterpart where one exists; the label
is not removed by this guide.

## What “ready” means

Setup reports installation, tool availability, signed-in identity, scope and a
small read-only service check separately. Unknown evidence stays unknown. A
successful read does not prove write access or access to every project, company
or host. An administrator's denial remains a denial.

All clients use the same [setup skill](skills/setup/SKILL.md) and its bundled
references. Current distribution state is maintained in the marketplace's
[readiness inventory](https://github.com/Netconnect-NCY/claude-plugins/blob/main/catalog/plugin-readiness.json).
