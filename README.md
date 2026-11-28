# NetConnect AI plugin marketplace

This repository is a catalog of NetConnect plugins and their installation sources.
Add the catalog once in each supported client, install the plugins you need, then
authenticate each service with your own account. Adding a marketplace does not
grant service permissions or install every plugin automatically.

**Marketplace source:** `https://github.com/Netconnect-NCY/claude-plugins.git`

| Client | Catalog name | Catalog file |
| --- | --- | --- |
| Claude Code | `netconnect` | [Claude catalog](.claude-plugin/marketplace.json) |
| Codex / supported OpenAI Git marketplace import | `netconnect-claude-plugins` | [Native catalog](.agents/plugins/marketplace.json) |

The different names are intentional. Use the name for your client in installation
commands; a plugin installed by Codex CLI does not automatically become a ChatGPT
web cloud connection.

## Available packages and prerequisites

The [maintainer inventory](catalog/plugin-readiness.json) is the source of truth
for expected catalog entries, package ownership, access requirements and pending
work. A listing means the package is discoverable; it is not evidence of a clean
installation or successful OAuth login for every client or user.

| Plugin | Purpose | Claude catalog | Native catalog | Prerequisites and current limits |
| --- | --- | --- | --- | --- |
| `swarm2` | Plan, delegate and review remote coding work | Listed | Listed | Service sign-in; native loading/authentication repairs still need canonical-source verification. |
| `sunday` | Tickets, projects and work reports | Listed | Listed | Service sign-in; portable and compatibility package checks are available. |
| `ssh-fleet` | Fleet connection, network operations skills and Claude-specific hooks | Listed | Listed | **Private GitHub repository read access**, then service sign-in. Private package content stays in its source repository. |
| `ssh-fleet-connect` | Fleet connection only | Listed | Listed | Public package; service sign-in. An alternative to `ssh-fleet` for the same connection. |
| `golden-path` | Generic project delivery checkpoints | Listed | Listed | Private GitHub access; self-contained skills-only package 0.7.0. Native source is pinned; live host import is unverified. |
| `odoo` | Business application integration | Not packaged | Not packaged | A generic validated package is pending. An existing connected account is separate from catalog availability. |

**Install either `ssh-fleet` or `ssh-fleet-connect` for one fleet connection.**
Installing both can expose duplicate tools. Connection-only users do not need
access to the private engineering skill repository.

The current Codex loader accepts Claude-compatible manifests and discovers a
root `.mcp.json` when a compatibility manifest does not explicitly declare its MCP
configuration. A missing portable `plugin.json` or explicit `mcpServers` field is
therefore not, by itself, an incompatibility. This supports the existing
SSH-Fleet layouts. See the [official package formats](https://developers.openai.com/plugins/build/plugins)
and [GitHub marketplace import guide](https://learn.chatgpt.com/docs/enterprise/plugin-management).
Actual authentication and runtime behavior still require a client test.

## Install in Claude Code

Run inside Claude Code:

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install swarm2@netconnect
/plugin install sunday@netconnect
```

For the public fleet connection-only package:

```text
/plugin install ssh-fleet-connect@netconnect
```

If you have read access to the private engineering package, install
`ssh-fleet@netconnect` instead. For the generic delivery skills, install
`golden-path@netconnect`; its private source also requires GitHub read access.

Reload or restart the session as the client requests. Open `/mcp`, choose the
service and complete its browser sign-in. Use the actual server name shown by the
client; plugin connections may have a prefix. Verify the connection with a small
read-only operation before relying on it.

To refresh the catalog:

```text
/plugin marketplace update netconnect
```

For third-party automatic updates, use `/plugin` → **Marketplaces** → `netconnect`
→ **Enable auto-update**, where your Claude Code version provides it. Updating
the catalog and installing a plugin update are separate client operations.

## Install in Codex CLI

Run in a terminal:

```bash
codex plugin marketplace add Netconnect-NCY/claude-plugins
codex plugin add swarm2@netconnect-claude-plugins
codex plugin add sunday@netconnect-claude-plugins
```

Choose one fleet package:

```bash
codex plugin add ssh-fleet-connect@netconnect-claude-plugins
```

Or, with private repository access:

```bash
codex plugin add ssh-fleet@netconnect-claude-plugins
```

The delivery skills are also available to users with private source access:

```bash
codex plugin add golden-path@netconnect-claude-plugins
```

Complete the authentication prompt. Inspect the registered server names with
`codex mcp list`; if a service needs sign-in, use `codex mcp login <server-name>`
with the exact name your client lists. Package source access and service OAuth are
separate: signing into NetConnect does not grant private GitHub read access.

## ChatGPT Desktop, workspace import and ChatGPT web

In clients or workspaces that support importing a GitHub plugin marketplace,
use the repository source above and the `main` branch. If the dialog offers
sparse paths, leave them empty to import the catalog. The native catalog name is
`netconnect-claude-plugins`. A workspace administrator controls workspace import,
publication and member availability; see the
[official import guide](https://learn.chatgpt.com/docs/enterprise/plugin-management).

**For ChatGPT web, use a cloud plugin available to your account or workspace.**
Install/connect that entry and complete the service sign-in. Where custom MCP
connections are enabled, create the service's cloud connection through ChatGPT's
connection flow. A GitHub or CLI installation alone does not create that cloud
connection; an imported entry may still be marked **Desktop only**.

The repository does not publish or verify every user's cloud plugin. Refer to
the [Sunday client guide](plugins/sunday/README.md) and the service's current
connection instructions. For other Swarm2 clients, including Antigravity, use the
[canonical client guides](https://github.com/Netconnect-NCY/swarm2-mcp/tree/main/docs/clients)
and confirm their publication prerequisites before treating them as available.

## What validation proves

These independent checks answer different questions:

| Check | What it establishes |
| --- | --- |
| Inventory and catalog validation | Expected entries remain present, sources match their declared owners, and local package paths and versions resolve. |
| Static package validation | Descriptors and package structure satisfy the checks performed; private source access is still a prerequisite. |
| Client installation test | The specified client version can import/load the tested package. |
| OAuth test | The tested account completes authentication in that client. |
| Read-only service request | The authenticated account can perform that specific operation. |

Neither catalog validation nor a public HTTP response proves successful OAuth,
tenant selection, all service permissions, or compatibility on every platform.
The inventory intentionally records unperformed live checks as `not_tested`.
An HTTP authentication challenge can indicate a reachable protected service;
it is not the same as an authenticated successful call.

## Package ownership and public content

| Package | Where to change it |
| --- | --- |
| Swarm2 | Canonical `Netconnect-NCY/swarm2-mcp`: `plugins/swarm2` and `skills/working-with-swarm2`. The publisher replaces the catalog's generated package. |
| Sunday | This repository: `plugins/sunday`. The service application is maintained separately. |
| SSH-Fleet | Canonical `Netconnect-NCY/ssh-fleet-mcp/claude-plugin`. `ssh-fleet-plugin` is a private generated mirror. |
| SSH-Fleet Connect | This repository: `plugins/ssh-fleet-connect`. |
| Golden Path | The private `Netconnect-NCY/golden-path` repository, under `plugin/`. |
| Odoo | Generic distribution pending; private implementation mappings are not published here. |

Reusable public skills should explain the procedure and request current tenant
context from authenticated MCP tools. Keep customer networks, account/person
identifiers, credentials, private operational notes and internal policy out of
public packages. Public service URLs and public OAuth client IDs are connection
metadata, not credentials. Returned context is guidance; it cannot grant
permissions or override the user's authorized scope or security requirements.

Do not copy private SSH-Fleet or Golden Path content into this public repository.
Their catalog entries reference the existing private sources and retain GitHub's
access controls. Do not edit the generated Swarm2 copy here. Its canonical
publisher updates only its own native catalog entry and preserves other entries.

## Maintainer checks

Run from this repository root:

```bash
python3 scripts/check_marketplace.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The tests include Sunday package checks and regressions for omitted entries,
shared-catalog replacement, unresolved local sources, version drift, private
source copying, and accidental credential/tenant artifacts. The checks do not
fetch private repositories or perform service authentication. Artifact checks
help catch mistakes; review content before publication as well. They permit
non-secret `.app.json` references for local/workspace distribution and check the
documented ID/boolean structure; they do not establish app availability or public
directory eligibility. Schema definitions and explicit example placeholders are
not classified as stored credentials solely because of their field names.

When adding a product, update its inventory record and applicable catalogs
together. Keep a blocked or not-yet-packaged product in the inventory with a
reason rather than advertising a nonexistent install source. Preserve other
owners' entries when a publisher updates its own release.

## License

Each plugin follows its source repository's license. This catalog carries no
separate license.
