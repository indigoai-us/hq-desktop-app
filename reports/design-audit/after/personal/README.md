# Personal pages (design lane 7): before and after

Captured with Playwright at 1280x800 against the preview harness (`?view=shell&persona=indigo`).
Before shots are copied from the audit branch (`reports/design-audit/personal/`) into `before/`.

| Screen | Before | After |
|---|---|---|
| Connections | `before/connections-indigo.png` | `connections.png` |
| Connections row click | detail pane did not visibly change (`before/connections-detail.png`) | `connections-row-click.png` (Slack selected, pane shows Slack) |
| When bots act > Never | no visible change | `connections-policy-never.png` |
| Row Disconnect | decorative label, not a button | `connections-disconnect-confirm.png` (confirm sheet with a working Disconnect) |
| Agents & MCP | | `connections-agents.png` |
| Secrets | `before/secrets-indigo.png` | `secrets.png` |
| Secrets row click | `before/secrets-detail.png` | `secrets-row-click.png` |
| Telemetry | `before/telemetry-indigo.png` | `telemetry.png` |
| Telemetry session detail | `before/telemetry-detail.png` | `telemetry-session-detail.png` |
| Telemetry tokens / outcomes | | `telemetry-tokens.png`, `telemetry-outcomes.png` |
| Outpost | `before/outpost-indigo.png` | `outpost.png` |
| Deployments | `before/deployments-indigo.png` | `deployments.png` |
| Profile / Billing / Settings | `before/profile.png`, `before/billing.png`, `before/settings.png` | `profile.png`, `billing.png`, `settings.png` |

Measured after the change: inside these pages the only text above 13px is the 20px/500 page title, no weight is above 500, and nothing is uppercase. The remaining 15-16px and 600-weight text in the captures belongs to the shared Messages sidebar, which this lane does not own.
