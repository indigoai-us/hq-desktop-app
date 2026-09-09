# Desktop Alt UX

The desktop workspace is the single HQ UI. The decorated Tauri window
(`desktop-alt`, `@hq/ui` DesktopApp) is what every user gets after sign-in.
The compact menubar popover remains a status/quick-actions surface (tray
right-click / Opt+Shift+H), not a second chat app.

## Access Model

- Tray left-click, Dock, and second-process activation open the `desktop-alt` window.
- First-run onboarding still uses the compact `main` card, then hands off to the desktop workspace.
- Signed-out users open the same window; `HqWorkWorkShell` shows sign-in there.
- `desktop_alt_enabled` still reports whether a Cognito email is present (used by some command paths). It no longer blocks opening the window.
- Indigo-only checks still protect admin/pre-release surfaces such as Moderation and non-stable update channels.

## Window + Frontend Map

| Surface | Files |
| --- | --- |
| Tauri window declaration | `src-tauri/tauri.conf.json`, label `desktop-alt`, hidden at startup with `create: false` |
| Tauri capability | `src-tauri/capabilities/desktop-alt.json` |
| Rust command module | `src-tauri/src/commands/desktop_alt.rs` |
| Vite entry | `desktop-alt.html`, `src/desktop-alt/main.ts`, `vite.config.ts` `desktopAlt` input |
| Shell + route state | `src/desktop-alt/DesktopApp.svelte`, `src/desktop-alt/route.ts`, `src/desktop-alt/v4/V4Sidebar.svelte`, `src/desktop-alt/v4/V4SecondarySidebar.svelte`, `src/desktop-alt/v4/V4TitleBar.svelte` |
| Pages | `src/desktop-alt/pages/HomePage.svelte`, `MissionControlPage.svelte`, `CompanyPage.svelte`, `CompanyGoalsPage.svelte`, `CompanyProjectsPage.svelte`, `InboxPage.svelte`, `MeetingsPage.svelte`, `MarketplacePage.svelte`, `LibraryPage.svelte`, `SettingsPage.svelte`, `ProjectDetailView.svelte` |
| Company secondary nav | Overview · Goals · Projects · Skills · Workers · Knowledge (→ files mode) · Team · Activity · Deployments · Secrets · Settings |
| Company panels | `src/desktop-alt/panels/CompanyBoardPanel.svelte`, `ActivityPanel.svelte`, `DeploymentsPanel.svelte`, `SecretsPanel.svelte`, `CompanyLibraryPanel.svelte` (Skills/Workers), `TeamPanel.svelte` |
| Global command surface | `src/desktop-alt/components/CommandPalette.svelte`, opened by command-K and grouped into actions/navigation rows |
| Company channel tabs | `packages/ui/src/chat/CompanyTabs.svelte`, `CompanyHero.svelte`, `tabs/tab-model.ts` (`COMPANY_CHANNEL_TABS` — Chat · Atlas · Team · Integrations · Settings), `tabs/atlas-model.ts`, `tabs/{AtlasTab,TeamTab,IntegrationsTab,SettingsTab}.svelte` |
| Lifecycle cards | `packages/ui/src/chat/messaging/LifecycleCard.svelte`, `chat/card-action.ts` (idempotency-key store + `submitLifecycleCardAction`), `messaging/channelMessageModels.ts` (`lifecycle_card` systemEvent envelope) |
| Agent channel | `packages/ui/src/chat/agent-channel.ts` — `isAgentUid`, `provisioningFromMessages` (`pending` / `done` / `blocked`), `agentComposerPlaceholder`; the composer stays locked until the status card flips to `done` |

## Tauri Commands

All commands are registered in `src-tauri/src/main.rs`.

| Command | Purpose |
| --- | --- |
| `desktop_alt_enabled` | Returns the Indigo gate result. |
| `open_desktop_alt_window` | Shows/focuses an existing `desktop-alt` window or builds the decorated window. The window is built `transparent(true)` and gets its native macOS glass backing applied via `glass::apply_liquid_glass_window` immediately after build (0.8.1-beta.1). |
| `get_company_project_creators` | Legacy-named cloud attribution lookup. It returns normalized owner, assignee, creator, and origin fields keyed by project id / PRD path. Desktop surfaces prefer explicit local attribution, fill missing fields from this cloud result, and use the same-company PRD's first Git author only as a final **Created by** fallback. A creator is never relabeled as an owner. |
| `get_company_summary` | Returns counts for the company header and overview stats. |
| `get_company_board` | Reads board data from the vault API at `/companies/{companyUid}/board`. |
| `get_company_activity` | Reads activity data from the vault API at `/companies/{companyUid}/activity`. |
| `get_company_deployments` | Reads hq-deploy apps from `https://api.indigo-hq.com/api/apps/me` with `x-org-slug`. |
| `get_company_secrets` | Reads hq-pro secrets metadata from `/secrets/{companyUid}` and returns grouped key metadata only. |
| `get_local_company_goals`, `get_local_projects`, `get_local_project_prd`, `get_local_project_readme` | Read local HQ work-system data for V4 goals, projects, tasks, and detail views. |
| `set_local_project_status`, `set_local_story_passes` | Write V4 project and story status changes back to local project files. |
| `run_card_action` | Submits a lifecycle-card action: POST `/v1/notify/channels/{id}/cards/{cardId}/actions` with a client-generated `idempotencyKey`. A 409 replay counts as success; a 403 renders its reason on the card. Each 2xx also runs the activate-cloud reconcile pass. |
| `get_company_tab`, `run_company_tab_action` | Company channel tabs: GET `/v1/companies/{uid}/tabs/{tab}` and POST a `tab_row` action for the Team / Integrations / Settings tabs. |
| `take_pending_setup_target` | Drains a stashed `hq-desktop://setup?checkout=done&company={uid}` deep link (cold-start path; see `src-tauri/src/deep_link.rs`). |

Company slugs are normalized in Rust, resolved through `list_syncable_workspaces`, and mapped to cloud company UIDs before vault API calls. A broken manifest UID can still resolve if the workspace row exposes the live cloud UID in its broken reason.

## Data + Security Notes

- V4 reads work-system data from local HQ goals/projects where possible, while Activity and Deployments still use their existing service-backed command paths.
- Projects and tasks display asserted roles separately: **Owner**, **Assignee**, **Created by**, and **Source**. Missing people are omitted instead of repeated as “Unassigned.” Local Git history is tenant-scoped and supplies creator evidence only when no explicit person attribution exists.
- Deployments intentionally call hq-deploy directly; hq-deploy owns app rows, DNS state, deploy history, passwords, and share-token state.
- Secrets must never expose plaintext. `get_company_secrets` projects each row into `{ env, count, items: [{ key, upd, rot }] }`; parser and E2E coverage reject recursive `value` or `secret` fields.
- The desktop-alt capability grants only `core:default`, `core:event:default`, and `shell:allow-open`.
- Lifecycle-card links are host-opened. Without an `onopenurl` host, `LifecycleCard.svelte` falls back to `window.open` **only for `http(s)` hrefs** — a server-supplied `javascript:` / `file:` href is ignored.
- `hq-desktop://` is a low-trust input. Only `setup` with a `^cmp_[A-Za-z0-9_-]+$` company uid is forwarded to the shell; anything else is dropped inert.

## Window Appearance

- **Liquid Glass window (0.8.1-beta.1).** The desktop window is built `transparent(true)`; `src-tauri/src/glass.rs::apply_liquid_glass_window` inserts a native `NSGlassEffectView` at the very back of the content view on macOS 26 (Tahoe) so the window reads as real Liquid Glass over the desktop. On older macOS the class is resolved at runtime as absent and the code falls back to the same `NSVisualEffectView` `UnderWindowBackground` vibrancy the menubar popover uses, so every supported OS still gets a translucent window. AppKit is main-thread-only, so this runs via `run_on_main_thread`. The native material backs the *window*; in-window panels get matched translucent styling in CSS (the material cannot refract the webview's own DOM).
- **Light-mode adaptivity (0.8.2-beta.1).** The V4 surface follows the OS appearance. `src/desktop-alt/v4/tokens.css` carries a light token set under `prefers-color-scheme: light`, and `src/desktop-alt/styles/desktop-alt.css` carries matching light glass/surface overrides. Previously the desktop window was dark-only.
- **Updater surfaces.** The titlebar version control opens `VersionPopout.svelte`, which reads `get_pending_update` and can run `install_update`; **All update settings** opens the `updates` section of `SettingsPage.svelte`, where the same restart/install action is available after a successful check.
- **HQ console links.** Every external link the desktop window opens into the HQ web console is centralized in `src/desktop-alt/lib/hq-console.ts` (base `https://hq.computer`) — Company Settings (the console company page), invite, integrations, and creator profiles. Links open in the system browser via `@tauri-apps/plugin-shell`.

The accepted route and UI contract is recorded in `docs/design/v4/IMPLEMENTATION-NOTES.md`. `docs/design/v4/SPEC.md` is retained as a historical design input rather than the current screen inventory.

## Tests

Use the normal unit/story suite plus the desktop-alt E2E harness:

```bash
npm test
npm run test:e2e:desktop-alt
```

`npm run test:e2e:desktop-alt` runs a scripted source-contract harness by default. To exercise a live app through `tauri-driver`, set `HQ_SYNC_DESKTOP_ALT_LIVE=1` and `HQ_SYNC_DESKTOP_ALT_APP` or `HQ_SYNC_DESKTOP_ALT_APP_PATH`; `HQ_SYNC_DESKTOP_ALT_WEBDRIVER_URL` defaults to `http://127.0.0.1:4444`.

Live mode is strict: when `HQ_SYNC_DESKTOP_ALT_LIVE` is set and the `tauri-driver` harness cannot be resolved, the run **fails** with the resolution reason rather than quietly falling back to the scripted harness. A silent fallback would let the Windows installer job report a pass without ever launching the installed binary.

## Single desktop shell

Canonical combined-app notes: [hq-work-embedded-rollout.md](hq-work-embedded-rollout.md).

This window always mounts `@hq/ui` DesktopApp. The retired `hqWorkHandoff`
menubar key is stripped on launch so upgraded installs cannot keep a classic
chat shell. Historical two-app notes remain in [hq-work-handoff.md](hq-work-handoff.md).

## In-app back/forward

The shared shell (`packages/ui/src/shell`) owns one in-memory history stack.
Every semantic destination goes through `navigate` → `resolveDestination` →
`commitDestination`. This is not `window.history`, not a general web router,
and not the pending-route bridge (`EmbeddedNavigationController` in
`hq-work-host.ts`). Legacy `src/desktop-alt/DesktopApp.svelte` DesktopRoute
navigation is out of scope; `desktop-alt/main.ts` mounts `HqWorkWorkShell`
only.

### History model

- Destinations are a discriminated union of stable IDs and serializable
  params: channels and DMs (reply thread, company/agent tab, file preview),
  notifications, meetings, Atlas, library tab/item, settings section, shared
  files, extra pages (sessions), and setup checkout.
- Each entry also stores account ID, company scope, and an optional scroll
  anchor (message/event/file identity with a pixel fallback). History never
  stores component instances, adapter handles, presigned URLs, cached
  content, or prompt text.
- A successful user navigation pushes one entry. Duplicate destinations do
  not push. Navigating after Back truncates the forward branch. Capacity is
  100 entries.
- Hydration, polling, live session phase updates, background roster changes,
  and cosmetic sidebar writes are not navigation and must not push.
- Company switching is navigation within one signed-in account. Sign-out or
  account change clears the stack. The stack is not persisted across app
  restart.

### Keyboard shortcuts

- macOS: Cmd+[ Back, Cmd+] Forward.
- Windows: Alt+Left Back, Alt+Right Forward.
- Both chords go through `consumeNavigationShortcut` on the shared shell.
  They are not stolen from text editing, IME composition, or a focused
  embedded web editor (Monaco, CodeMirror, ProseMirror, iframe/webview).
- Escape still dismisses ephemeral menus and dialogs first. Title-bar Back,
  settings close, and in-page detail Back use the same resolver when they
  mean navigation. Page-internal wizard steps stay owned by the wizard.

Title-bar Back/Forward sit immediately after the day-date in
`packages/ui/src/home/V4TitleBar.svelte`, outside the macOS drag region,
with accessible names and disabled states at the stack endpoints. Hover
labels show the destination. Unsupported hosts (legacy desktop-alt
`DesktopApp.svelte`) omit the callbacks so that chrome stays unchanged.

### Restore rules

- Back and Forward restore selection, active tab, reply target, and scroll
  without refetching unnecessarily, but still re-run access checks. Visibility
  is never inferred from cached history.
- Session restore uses open / openHistory / shared-view only. Traversing
  history must not call `agent_session_start` or send.
- First successful send replaces a temporary new-draft identity with the
  created session ID so Back cannot recreate the sent draft. Unsent drafts
  keep identity and content via existing draft persistence.
- A transient resolve failure does not consume a history step. A confirmed
  unavailable destination commits an explicit unavailable view with content
  concealed; Back remains usable; the app never silently opens a different
  conversation.
- Returning to a long transcript restores its stored anchor. New background
  messages do not steal that offset. Background sessions stay alive while
  views unmount.
- Latest navigation wins during async races. Cursor changes wait for a
  successful commit.

Manual live steps, measured latency, native preview, and Windows keyboard
status live in
`companies/indigo/projects/hq-desktop-back-forward-nav/acceptance-notes.md`.
