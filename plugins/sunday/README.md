# Sunday

Find tickets, inspect projects and reports, and make requested updates with your
own Sunday permissions. The package includes the `working-with-sunday` skill and
a remote MCP connection; it needs no local server or copied API key.

- **MCP endpoint:** `https://sunday.work/api/v1/mcp/rpc`
- **Sign-in:** NetConnect Keycloak SSO, public OAuth client `sunday-mcp`, PKCE.
- **Source:** this repository's `plugins/sunday` directory. The application and
  MCP server are maintained separately in `Netconnect-NCY/Sunday`.

## ChatGPT web

If your account or workspace already provides a Sunday cloud plugin, install or
connect that entry and sign in with your own NetConnect account.

Otherwise, where custom MCP connections are enabled:

1. Open **Plugins → + → Add custom MCP server**.
2. Name it **Sunday** and set **Connection** to the MCP endpoint above.
3. Select **OAuth**, expand the advanced settings and choose **User-Defined
   OAuth Client** instead of the default dynamic registration. Enter client ID
   `sunday-mcp`, choose token authentication **none**, and leave the client secret
   empty. Use base scope `offline_access` and default scopes `openid profile email`
   when those fields are shown.
4. Review the connection prompt and choose **Create as a plugin**. Complete
   NetConnect sign-in and inspect the discovered tools.
5. Install the resulting plugin. Start a conversation, select **@Sunday**, and
   ask it to verify your identity and list your open tickets.

In the legacy interface the creation route is **Settings → Apps → Create**.
Account/workspace policy controls availability and permitted actions. Workspace
publication and access are configured by an authorized workspace administrator.
See OpenAI's [custom MCP connection guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

**A GitHub/CLI installation does not itself create a ChatGPT web connection.**
Imported MCP packages may be labelled **Desktop only**, even with a remote URL.
Use the cloud connection above for web; keep its generated identity when adding
this package's skills. Do not copy a personal app ID into this public package.
See [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## ChatGPT Desktop

Use the Sunday cloud connection available to your account, or install the Sunday
package from your organization's NetConnect plugin distribution when supported.
Connect with NetConnect SSO. If the installed entry says **Desktop only**, follow
the web connection procedure above to make Sunday available in ChatGPT web.

## Codex CLI

Install the plugin after adding its marketplace:

```bash
codex plugin marketplace add Netconnect-NCY/claude-plugins
codex plugin add sunday@netconnect-claude-plugins
codex mcp list
```

Complete the authentication prompt, or run `codex mcp login <server-name>` with
the exact Sunday server name shown by your client. The native catalog is named
`netconnect-claude-plugins`; the Claude catalog below is named `netconnect`.

## Claude Code

```text
/plugin marketplace add Netconnect-NCY/claude-plugins
/plugin install sunday@netconnect
```

Reload the plugin or reopen the session as the client requests. Open `/mcp`,
select the Sunday server (usually `plugin:sunday:sunday`), choose **Authenticate**
and sign in with NetConnect. The skill is `sunday:working-with-sunday`.

## Claude Desktop

Where remote custom connectors are available, add the MCP endpoint in Claude's
connector settings and complete OAuth. If Sunday is already connected through
the same account, reuse it to avoid duplicate tools. The Claude Code marketplace
commands above are for Claude Code.

## Verify the connection

Use `get_me({})` to confirm the connected identity. Then make a read-only request,
such as `list_departments({})` or a filtered `list_tickets` query. The host may
prefix tool names. Verify actual data access after OAuth; finding or installing
the package alone does not establish authentication or write permissions.

If connection fails, record the client, failing step and sanitized error. The
operator should check the live MCP endpoint, strict resource metadata at
`https://sunday.work/.well-known/oauth-protected-resource/api/v1/mcp/rpc`, and
authorization-server metadata at
`https://sunday.work/.well-known/oauth-authorization-server`.

The public Keycloak client must allow the **exact callback displayed by the
client** and require PKCE S256. This package does not change that allowlist.
The OpenAI descriptor uses the pre-registered public client; it does not rely on
Sunday's historical Claude-specific registration shim. It requests
`openid profile email offline_access`; the provider must issue refresh tokens for
persistent access. These OIDC scopes do not grant additional Sunday permissions.

## Maintainer validation

From the repository root:

```bash
python3 -m unittest discover -s tests -p 'test_sunday_plugin.py' -v
```

The checks cover native catalog discovery, portable/compatibility metadata,
version agreement, OAuth configuration, the skill and secret-free packaging.
Run a real ChatGPT OAuth and read-only smoke test separately after server or
identity-provider changes. Package validation does not prove those live flows.
