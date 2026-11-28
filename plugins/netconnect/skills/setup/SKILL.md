---
name: setup
description: Help a user choose, install, activate, sign in to, or check NetConnect plugins and MCP connections in their current AI client. Use for NetConnect onboarding, missing tools, duplicate connections, and connection readiness. Keep existing service permissions and distinguish package installation from authentication and a verified service operation.
---

# Set up NetConnect services

Help the user reach one working connection at a time. Reuse existing working
connections. This skill is a guide, not an MCP gateway or an access grant.

## 1. Establish the client and the requested services

Use the current host context to distinguish ChatGPT web, ChatGPT desktop,
Claude Code, Codex CLI, and another client. Ask which client only when it changes
the next step and is not already clear. A shell available to an agent may be a
cloud sandbox; it is not evidence of access to the user's local client.

Inspect the host's advertised plugin/connection inventory and available tools
when supported. Do not treat missing tools as proof that the user lacks access;
the plugin may be uninstalled, disabled, not authenticated, or not loaded yet.

If the user named services, use those. Otherwise ask what work they want to do
and suggest the smallest relevant set:

| Work | Service or package |
| --- | --- |
| Coding projects and delegated implementation | Swarm2 |
| Tickets, projects and work reports | Sunday |
| Network and infrastructure operations | SSH-Fleet |
| Fleet access without the private engineering package | SSH-Fleet Connect |
| Project delivery workflow instructions | Golden Path |
| Business application work | Odoo, when a verified package or cloud connection is available |

Install either `ssh-fleet` or `ssh-fleet-connect` for the same connection.
If a working manual or plugin connection already exists, retain it and explain
any duplicate before changing configuration. Do not remove existing connections
or credentials just to make setup appear clean.

## 2. Resolve the supported distribution path

Read [client setup](references/client-setup.md) for the current client. Use
live host discovery and the current public
[catalog inventory](https://github.com/Netconnect-NCY/claude-plugins/blob/main/catalog/plugin-readiness.json)
when available. The inventory describes packages; it does not attest to this
user's installation or sign-in. If current distribution cannot be checked,
report it as unknown and use a verified existing connection where possible.

Use the host's actual plugin-management capability when it supports the requested
installation or activation. Discover exact plugin/app IDs; never invent them.
For a local client, run commands only in a verified connection to that client,
within the user's request. Otherwise provide the short steps for that client.
Do not run local install commands in a cloud sandbox and claim the user's
ChatGPT or Claude installation changed.

Install or enable only the services the user requested or selected. Package
installation does not authorize business changes, grant service roles, or
publish a workspace app. Keep repository access, workspace availability and
service permissions separate. Use the service's current documentation when
configuration differs from the bundled guidance.

## 3. Complete the service's own sign-in

Use the supported browser-based OAuth/SSO flow or the host's **Connect** action.
Follow the host's handoff process when the user must sign in or grant consent.
Never collect passwords, access tokens, refresh tokens, authentication files or
MFA codes in a skill, repository, chat message or tool goal. Do not borrow another
person's connection or choose a shared account to bypass a denial.

After sign-in, discover the live service's identity/capability tools. Confirm the
acting account and relevant organization/project/company context when the
service exposes them. If identity cannot be verified, say so; do not infer it
from a friendly plugin name, a public health response or a successful transport
handshake. Stop before accessing data if the connection is to an unexpected
account or company.

## 4. Verify a small, relevant read

Follow [readiness checks](references/readiness.md). Use the smallest available
identity, capability, metadata or bounded read operation relevant to the user's
request. Use the tool's live schema and the service-specific skill. Do not
invent a test tool, perform a fleet scan, read unrelated business records, or
submit a coding job just to check a connection.

A 401 usually needs sign-in or reconnection. A 403 may be a real authorization
limit: report the denied operation and use an advertised access-request route
only when the user asks for it. Do not change roles, OAuth clients, organization
policy or global tool visibility as an onboarding repair.

## 5. Show the result and the next action

Return a short table for the selected services using observed evidence:

| Service | Installed or available here | Sign-in and acting identity | Verified read | Next action |
| --- | --- | --- | --- | --- |

Use `unknown`, `needs sign-in`, `access denied`, or `not available in this client`
when applicable. Name the actual check and keep its result scoped to the tested
account, resource and operation. Do not describe all service rights as verified
because one read succeeded.

Load each service's relevant skill when the host supports it. If a skill is not
available, use the service's current advertised documentation and state the
limitation. Do not promise that installation or sign-in in one AI client has
updated another client. Keep account identifiers and returned operational data
in the private conversation; never copy them into this public package.
