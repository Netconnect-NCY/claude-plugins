# Readiness checks

Use existing host and service tools. These are evidence categories, not new tool
names or an API that this package implements.

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| Catalog entry resolves | A distribution source is advertised | Installed, enabled, authenticated or authorized |
| Host reports installed/enabled | That client has loaded or enabled the package | Another client is configured |
| Tools are advertised | The host can discover those tool contracts | Every call is authorized |
| Authenticated identity/capability response | The account and capabilities explicitly returned | Rights absent from the response |
| Small successful service read | That operation works for that account and scope | Writes, all resources, or future sessions |

## Select a bounded check

| Service | Prefer, when advertised by the current connection |
| --- | --- |
| Swarm2 | `swarm_capabilities` and the minimum project context needed for the requested work; do not submit work as a probe. |
| Sunday | `get_me`; use `list_docs`/`get_doc` for current service guidance when needed. |
| SSH-Fleet | A caller identity/capability read if exposed; otherwise a minimal non-SSH metadata read. If only organization identity is returned, do not label it as the human's identity. |
| Golden Path | Confirm the selected packaged skill and its references load; it has no bundled service sign-in to test. |
| Odoo | The selected connector's advertised identity/company metadata read. Do not assume a generic Odoo package or tool name exists. |

Record only evidence actually observed in this client. Where tools are lazy
loaded, use the host's advertised discovery first. If a cached session still
shows old tools, follow the client's supported refresh or new-session guidance;
do not work around a current authorization denial.

## Explain a blocker precisely

| Observation | Next action |
| --- | --- |
| Selected plugin is absent from the current catalog | Report unavailable; check the current owner/publisher status instead of guessing an install source. |
| Private source cannot be read | Explain the required repository access, or offer a published public alternative for the same service. |
| Imported entry is Desktop only | Use that desktop client or a verified cloud counterpart; do not claim HTTPS alone fixes it. |
| Connection needs sign-in or has expired | Use the service's browser sign-in/reconnect flow. |
| Authenticated call is denied | Report the denied action and scope; existing service rights remain in force. |
| Tools work but identity is unavailable | Report the operation as tested and identity as unverified. |
| User requests a write after setup | Apply the service's authorization and action workflow to that request; setup was not approval for future changes. |
