## Compact layout refinement

Bot details now lives in the top-right header. The identity block and tabs use tighter spacing, repeated tab headings and promotional copy are removed, and channel/app/provider cards use consistent compact padding. Routine counts are inline; provider setup explanations remain available in the configuration dialog. Owner and email are available under Activity, runtime & access. Existing actions, status messages, and keyboard navigation are preserved.

# Bot management UI foundation

## Brain management

Multi-provider cloud bots use Fleet's dedicated `/brains/{provider}/authorize` endpoint rather than reauth. This preserves an already-authorized Grok account or an in-progress login. Refusals never fall back to reauth. The panel distinguishes permission failures, unsupported setup, remote runner failure, and a link delayed over 90 seconds. Existing single-provider bots retain their reauth flow. Backend runner/installation failures still require Fleet-side repair; desktop cannot repair the remote host without operator access.

Brain now shows OpenAI/Codex, Claude/Anthropic, and Grok/xAI with verified connection states, a current-brain summary, and model/thinking-level configuration. Model choices reuse this build’s local-bot settings catalog; they are not a claim of live account entitlement.

Local bots are matched by agent UID before saving through bots.configure using their authoritative handle. Provider sign-in reuses RuntimeSignIn and is shared by local bots on that computer. Cloud sign-in uses the existing provider authorization, scoped status, and Claude-code APIs; pairing URLs use the existing trusted-provider parser and codes stay in component memory. Connecting does not activate a provider.

Brain uses HQ Dropdown controls and bundled OpenAI, Claude and Grok marks. Dialogs portal above the shell and preserve primary-button contrast. The active cloud provider can now save model/thinking level through the existing authenticated PATCH /v1/agents/{uid}/runtime-config endpoint. It rechecks the live provider before writing and verifies the returned bot/model/effort; delayed application is reported honestly. Empty cloud model choices are excluded, and empty effort preserves the stored default. Provider switching remains unavailable: Fleet treats it as runtime migration/replacement, while local bot configuration only accepts model and effort. The demo demonstrates activation without live writes; state=brain-error exercises failed saves. Implementation: BotBrainPanel.svelte, BotBrainHost.svelte, bot-brain.ts, and BrainPreview.svelte. Browser coverage: bot-brain.spec.ts. No live credentials or runtime settings were changed during testing.

## Apps / MCP update

Apps now provides connected/runtime app cards, status filters, tool counts, a searchable supported-MCP catalog, and connection details. OAuth reuses the onboarding runner; API-key setup reuses the secure IntegrationConnectModal. Catalog entries must report MCP readiness and a supported auth method.

The Apps status filter uses the shared styled Dropdown with keyboard navigation. MCP cards and details resolve bundled brand marks by domain, then exact provider or app name for runtime-only entries; brand colors are preserved. Unknown brands retain the generic icon without fetching third-party images.

Apps uses a compact wrapping toolbar for search, status, list/grid selection, refresh and Browse apps. Grid is the initial view, with responsive columns; list uses dense rows. Browse opens a separate, focus-trapped catalog modal with independently scrolling results. Returning from connection details preserves the catalog search; successful connection returns to the bot list. Escape closes the active dialog.

Apps dialogs portal to the desktop shell above sticky headers so panel clipping and stacking cannot bleed into the modal. Search focus is indicated on the enclosing field instead of an inner input outline. Primary buttons preserve their foreground/background contrast on hover.

Connecting adds a company connection; granting this bot access is a separate explicit action. Removing bot access revokes only its grant and never uninstalls the company app. Company-wide/admin access and the existing per-bot feature gate remain enforced. Runtime-only connections and unavailable access checks are read-only. Failed writes preserve existing access.

Implementation: BotAppsPanel.svelte, BotAppsHost.svelte, and bot-apps.ts beside the profile pane. The preview uses demo-only connections and supports state=app-error. Browser regression coverage: bot-apps.spec.ts.

The shared bot profile now contains Channels, Routines, Apps, and Brain tabs. Fleet and messaging entry points use the same component. Message and Open session are omitted because chat is adjacent. Bot details opens an inline profile editor; activity, runtime, access, usage, and pause/resume/stop are grouped in its expandable operational section.

The profile editor loads authoritative details and saves name, title, and description through the existing `agents.updateProfile` API. Server field restrictions are respected; the handle is read-only. Failed saves preserve edits, and collapsing details retains the draft while this bot remains mounted. Switching tabs hides settings without destroying its draft. The preview uses an in-memory adapter and does not change a real bot.

Routine editors use the shared HQ Dropdown for schedule, weekday and delivery; schedule/status list filters are removed. Routines now supports daily, weekly, interval, one-time and custom schedules. `BotRoutinesHost` reads profile box routines, deduplicates older scheduled jobs by ID, and uses the existing `runtimeAction` cron create/update/pause/resume/trigger/delete contract. `BotRoutinesPanel` provides search, summary cards, details, schedule/delivery editing, failure feedback and explicit run/delete confirmations. Cached and restricted routines remain read-only. Retries reuse the action idempotency key, and failed saves keep drafts. Older scheduled jobs retain the existing pause control. Full run history is not available from the current API. Brain and Apps now use the management flows described above. Channels defaults to Slack and Telegram, with status read from the existing status/profile APIs, plus any additional channels reported by the runtime. Slack uses the existing guided connection modal. Fleet management support is described in the channel integration section below. The searchable browser accepts an explicit supported catalog; production exposes Slack, Telegram, Email and Microsoft Teams when supported by the adapter. No new mutation endpoints are invented. Cached runtime status is labeled unavailable rather than connected. Brain only shows provider/model rows when those rows are supplied in the snapshot. Existing integration components remain available for the later Apps wiring.

## Local preview

From `apps/sync`:

```sh
pnpm exec vite --config vite.preview.config.ts --host 127.0.0.1 --port 1424 --open false
```

Open `http://127.0.0.1:1424/?view=bot-management` for an isolated fixture, or `http://127.0.0.1:1424/desktop-alt.html?window=desktop-alt&persona=indigo&bots=table` for the desktop shell. The fixture also accepts `state=loading`, `state=loading-routines`, `state=error`, `state=save-error`, or `state=channel-error`, or `state=routine-error`. The channel fixture is clearly labeled as a demo: Telegram/Discord connection and disconnect actions change in-memory state only.

## Where to continue

- `BotFeatureIntro.svelte` beside the profile pane: onboarding-inspired feature illustrations and explanatory content. Reuses the existing NewBotOrbIcon and bundled Fraunces font, with monochrome surfaces and reduced-motion support.
- `BotChannelsPanel.svelte`, `BotChannelsHost.svelte`, and `bot-channels.ts`: channel cards, searchable catalog, accessible connection details, live reads and existing Slack setup.
- `BotIdentityEditor.svelte`: validated profile form, authoritative reads, restricted-field handling, save/error feedback, and stale-response protection.
- `packages/ui/src/shell/profile-panes/BotProfilePane.svelte`: tab navigation, shared identity header, details, and panel content.
- `ProfilePaneHost.svelte` beside it: platform reads, existing actions, and selected-bot state.
- `BotRoutinesPanel.svelte` / `BotRoutinesHost.svelte`: routine management and live API boundary.
- `BotJobsPane.svelte`: legacy scheduled-job list and details.
- `packages/ui/src/chat/messaging/BotIntegrationsSection.svelte`: existing flagged per-bot access UI for future Apps integration. Preserve its company/bot scope and permission states.
- `apps/sync/dev-harness/BotManagementPreview.svelte`: isolated preview fixtures.

Keep future platform operations in the host/adapter layer. Replace each placeholder only when real loading, empty, permission, failure, and acknowledgement states are supported. Do not interpret an unavailable feature or failed read as an empty connection list.

## Checks

```sh
TZ=UTC pnpm --filter @hq/ui test src/shell/profile-panes src/company/BotsPage --maxWorkers=2
pnpm --filter @hq/ui typecheck
pnpm --filter hq-sync typecheck
```

From `apps/sync`:

```sh
PW_DEV_SERVER=1 TZ=UTC pnpm exec playwright test e2e/browser/bot-management.spec.ts e2e/browser/bot-jobs-tab.spec.ts e2e/browser/bot-channels.spec.ts e2e/browser/bot-routines.spec.ts --project=chromium --workers=2
```

## Native desktop QA follow-up

Verified the installed macOS app and fixed shell-refresh resets, missing Apps company context in direct messages, inactive-channel clutter, simulated Stop behavior, and local lifecycle control routing/error recovery. Native local model settings save/readback was exercised and the original setting restored. Regression suite: 106 unit tests and 20 browser tests pass; app typecheck and production build pass. Backend-dependent limitations remain explicitly labelled. Full local QA notes: workspace/orchestrator/bot-management-desktop-qa/report.md in the HQ workspace.


### Channel API wiring (2026-10-16)

The live catalog now exposes Slack, Telegram, Email and Microsoft Teams contact enrollment. Telegram uses the verified hq-pro-agents provisioning/status/contact endpoints, supports managed bot creation or an existing BotFather token, member enrollment links, confirmed contact revocation and disconnect. Email supports attach, editing the address local part, and confirmed detach. Slack supports guided setup, app settings and confirmed detach without reattaching. Teams supports contacts for the existing company Teams app, not installing a new company-wide Teams integration. Human members are selected from the resolved company roster. All adapters (Web, Tauri and Sync) use the same encoded route contracts; credentials travel only in request bodies and echoed token errors are redacted.

WhatsApp has no verified Fleet provisioning API and is hidden from defaults, runtime-reported rows and the production browser. Its unfinished backend draft is deferred in a separate worktree. Local bots still have no equivalent external channel management APIs. These remain explicit limitations rather than simulated connections. Live native QA verified Telegram eligibility/form validation, email status/edit validation and Teams roster loading; production connection writes were not executed. Mutation paths are covered by mocked UI and adapter tests.

### Existing MCP credentials

Company owners/admins can open **Manage → Connection settings** on a remote MCP installation. API-key connections expose a masked replacement key and authentication method (Bearer, header, prefix, or Basic). The form rechecks permissions and the stored connection identity, reuses the exact saved endpoint/provider, preserves the history preference, and uses the existing factory install API to replace credentials without changing access grants. The returned connection ID and installed/connected status must match before success is shown. Keys are cleared after every attempt and on close; upstream errors are never rendered.

Connections needing attention remain visible in this panel for repair. OAuth MCP connections (including Notion) offer browser reconnection using the saved provider and endpoint, preserving history preferences. After browser consent, Check connection requires a fresh installed/connected update on the same connection ID before reporting success. No-auth connections explain that there are no credentials; unsupported legacy authentication remains informational. Endpoints containing query parameters/userinfo, ambiguous duplicate provider identities, and non-MCP installations are not offered this form. The application never reads saved secret values. Tests use fake credentials; no live company credentials were changed.

### Tab loading states

Channels, Routines, Apps, and Brain use `BotTabSkeleton` during foreground reads. The skeleton uses HQ theme tokens, card silhouettes, a restrained shimmer with reduced-motion support, and the shared ReadLoader delayed retry. Previous cards, counts, and empty states are not rendered alongside the loader. Apps commits connection and access results together; catalog searches hide prior results while pending. Routines waits for its profile before rendering legacy scheduled jobs, and clears stale routine rows when a refresh fails. Channel polling refreshes in the background so settled cards do not flash a skeleton every 15 seconds. Bot/company keyed hosts and request generation guards remain in place.
