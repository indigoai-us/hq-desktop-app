# HQ Sync Menubar

macOS menu bar app wrapping `hq sync` for non-technical users. Tauri 2 + Svelte 5 + vanilla CSS.

## Architecture

**Frontend:** Svelte 5 with runes (`$state`, `$effect`). No component library — vanilla CSS in `src/styles/popover.css` owns the canonical Liquid Glass tokens (the file keeps its historical name; the tray popover it was written for was deleted in PL-07), and `src/desktop-alt/styles/desktop-alt.css` imports those tokens for both the V4 desktop window and standalone Messages window. The V4 surface is light-mode adaptive (0.8.2-beta.1): `src/desktop-alt/v4/tokens.css` carries a light token set under `prefers-color-scheme: light` and `desktop-alt.css` carries the matching light glass/surface overrides, so the desktop window follows the OS appearance instead of being dark-only. External links the desktop window opens into the HQ web console are centralized in `src/desktop-alt/lib/hq-console.ts` (single source of truth — Company Settings, invite, integrations, creator profiles), opened in the system browser via `@tauri-apps/plugin-shell`. **The desktop window is the UI.** The tray window (`main`) is a hidden controller that paints only three things: a loading dot, `Onboarding` (install / first-run / consent) and `SignInPrompt` (OAuth). Its script block still owns sync orchestration, every `set_tray_state` call, the tray-menu commands, the macOS menu-bar unread badge, the updater lifecycle, OS-notification action routing and meeting detection — see `src/App.svelte`. The tray popover that used to be the signed-in UI (`Popover.svelte`, `NotificationFeed.svelte`) was unmounted in PL-06 and deleted in PL-07; sync status, conflicts, updates and notifications all live in the desktop-alt shell under `src/desktop-alt/` (Home, Mission Control, Inbox, Meetings, Marketplace, Library, Files, company workspaces, Settings, safety flows, V4 sidebars, titlebar updater, command palette). Conflict resolution reaches `resolve_conflict` through the platform adapter (`packages/platform/src/tauri/sync-adapter.ts`); the surface is the desktop window's titlebar Core popover. There are no first-launch onboarding pages — on a brand-new install `App.svelte` shows the onboarding card and starts the first sync (the old `FirstRunWelcome` carousel + `AutoSyncNotice` card were removed). New-file notification via `NewFilesDetail` (secondary window with file list and attribution). Recent Changes via `ActivityLog` (secondary window listing the session's per-file syncs, each attributed as "{author} added/updated" — author email + verb — falling back to the company slug when no author). DM notifications open `DmDetail` (secondary window showing the full two-way **conversation thread** — received vs. sent bubbles, scrollable, with the live message at the bottom — plus a reply composer: textarea + **Send** / ⌘↵; sent replies append optimistically); share notifications open `ShareDetail`. **Notifications:** the desktop-alt **Inbox** (`packages/ui/src/inbox/NotificationsView.svelte`) is the notification feed; the standalone Messages window remains independent. `src/lib/notificationFeedData.ts` survives as the data layer for the share-detail quick window, which reads unread state from the server (`fetchServerUnreadIds`) rather than a local watermark. **Share reactions (0.9.8):** shares support emoji reactions via the reaction scope `share:{eventId}` reusing the DM `ReactionBar` (`src/lib/shareReactionController.svelte.ts`); `ShareDetail` and the feeds gain reactions plus a **Message the sharer** action that deep-links into the Messages window (`src/lib/pendingConversation.ts` + `messages:open-conversation`). **Share history in Messages (0.9.8):** `src/lib/shareTimeline.ts` merges the peer's share events into DM threads as inline share-card bubbles and drives the rail's "Shared a file" previews (agent conversations get no reactions surface).

**Backend:** Tauri 2 Rust commands in `src-tauri/src/commands/`. ~110 registered commands in `main.rs`.

**State flow:** Svelte frontend calls Tauri commands via `invoke()`. Rust backend emits typed events (`sync:progress`, `sync:conflict`, `sync:error`, `sync:complete`, `sync:new-files`) that Svelte listens to via `listen()`.

## Key Modules

| Module | Purpose |
|--------|---------|
| `commands/sync.rs` | Spawns `hq sync --json`, streams ndjson events, 10-min timeout. Includes a "Preparing sync…" pre-pass that walks the tree to compute real `filesTotal` before transfers start (so progress isn't fake) |
| `commands/first_run.rs` | First-run / first-update onboarding classification + persisted flags. `classify_launch` runs at the very top of `main.rs` `.setup()` — BEFORE `config::ensure_machine_id` writes `machineId` — and caches a `LaunchKind` (`FirstRun` / `ExistingUpdate` / `Normal`) in managed state. Tiebreaker between a brand-new install and a legacy update is the *pre-write* `machineId` (existing users have it, fresh installs don't; `firstRunCompleted` alone can't tell them apart). Exposes `is_first_run`, `should_show_auto_sync_notice` (gated to `ExistingUpdate` + notice-not-shown + `realtimeSync` still on — never overrides an explicit opt-out), `mark_first_run_complete` (writes `firstRunCompleted` + `autoSyncNoticeShown` + `realtimeSync`/`personalSyncEnabled` true), `mark_auto_sync_notice_shown` (writes `autoSyncNoticeShown` + `firstRunCompleted`, never touches `realtimeSync`). All writes use the same untyped-merge + atomic-rename algorithm as `config::ensure_machine_id` so unknown/future top-level keys survive |
| `commands/auth.rs` | Cognito token state + silent refresh |
| `commands/cognito.rs` | Cognito client wrapper (refresh, sign-out, hosted-UI URL builder) |
| `commands/oauth.rs` | PKCE OAuth flow on loopback port 53682 |
| `commands/config.rs` | Reads `~/.hq/config.json` + `~/.hq/menubar.json` |
| `commands/status.rs` | Live status surface (last sync, current state, error count) — read by the desktop window through `get_sync_status` |
| `commands/workspaces.rs` | Manifest-driven workspace list — reads `companies/manifest.yaml`, unions with cloud memberships, exposes per-row Connect state |
| `commands/folder_picker.rs` | Native folder picker for the Settings re-tether flow |
| `commands/personal.rs` | Auto-provisions the `personal` company row + bucket on first sync if missing |
| `commands/provision.rs` | Auto-provisions the user's `person` entity in HQ-Cloud on first sync (UJ-006) |
| `commands/provision_reconcile.rs` | Reconciles server-side cloud activation (0.10.194). Observes `cloudActivatedAt` on owned companies, writes the local cloud marker + `company.yaml`, and POSTs `/v1/companies/{uid}/activate-cloud/ack` **only when `wrote_local` is true**. An unparseable/non-mapping `company.yaml` is skipped byte-identical (never replaced with a bare `{cloud: true}`). Ack transport/5xx failures persist `companies/{slug}/.hq/activate-ack.pending` and retry on a later pass (cleared on success or a terminal 403/404). Single-flighted by a process-wide `AtomicBool` returning `ReconcileOutcome::SkippedInFlight`; triggered by `run_card_action` and `start_sync`. The legacy `cloud: true` provision path is unchanged |
| `commands/first_push.rs` | First-push protection — companies that have never synced are pre-walked and validated against ignore rules before any upload |
| `commands/prewarm.rs` | Warms the vault client + manifest cache on app launch so the first window open is <100ms |
| `commands/vault_client.rs` | HTTPS client to hq-ops `vault` endpoints (signed S3 URLs, telemetry opt-in, person provisioning) |
| `commands/telemetry.rs` | Per-sync telemetry collector — scans the HQ tree, diffs against `~/.hq/telemetry-cursor.json`, POSTs to `/v1/usage` (gated on `telemetryEnabled` in menubar.json + server-side opt-in) |
| `commands/daemon.rs` | Feature-flagged V2 daemon lifecycle (`autostartDaemon` in menubar.json) |
| `commands/process.rs` | Generic subprocess lifecycle with SIGTERM->SIGKILL. Children inherit the full parent environment (no `env_clear()`), which is how the hq-cloud runner's `HQ_SYNC_MANIFEST_DISABLED` manifest-upload kill switch reaches it; `child_env_tests` guards that inheritance |
| `commands/conflicts.rs` | Conflict resolution + open-in-editor |
| `commands/new_files.rs` | New files detail window — creates/focuses a secondary Tauri window showing file list with attribution. Uses managed `PendingNewFiles` state + ready handshake pattern |
| `commands/activity.rs` | Session activity log (Recent Changes window) — in-memory append-only `Vec<ActivityEntry>` in managed state, one entry per `progress` event. Each entry carries `direction`, `author`, and `is_new`. `record_new_files()` reconciles the per-company `new-files` event onto the matching download rows (flips `is_new` so the UI renders "added" vs "updated", back-fills `author` from `addedBy` where the progress event had none). Renders as "{author} added/updated", falling back to the company slug when no author |
| `commands/share_notify.rs` | "Shared with me" notification client — polls `GET /v1/files/shared-with-me` on an **independent interval timer** (`setup_share_notify_poller`, one timer that also drives DM polling), surfaces a native banner, opens `ShareDetail`. Decoupled from sync events on purpose (a stalled sync must not stop notifications) |
| `commands/dm_notify.rs` | User-to-user DM notification client, layered on the same poll timer as `share_notify`. Polls `GET /v1/notify/inbox`, surfaces a banner; **every DM is clickable** — a body-click maps to the `"open"` action (opens `DmDetail`), while `"copy"` (write the agent prompt to the clipboard) stays an explicit action button for DMs that carry a `prompt`. Outbound `send_dm` (`POST /v1/notify/dm` via the sender's `fromPersonUid` → recipient's `toPersonUid`) powers the `DmDetail` reply composer — the app is no longer receive-only. `fetch_dm_thread` (`GET /v1/notify/thread?withPersonUid=`) loads the full two-way conversation history (server-side pair-keyed mirror; messages `direction`-tagged in/out) so `DmDetail` renders a thread, not just the single triggering DM. Cursor `~/.hq/dm-cursor.json`; gated by `dmNotifications` in menubar.json (default on); log codes `DM_NOTIFY_*` in `~/.hq/logs/hq-sync.log`. All DM sends take the guarded blocking-send path (`BlockingNotifyGuard` caps blocking sends at ~1 core). **Watched-shares slot (0.9.8):** `set_watched_shares` registers the share eventIds currently visible in the UI so the single DM poll path also re-fetches share reaction aggregates and emits `message:reaction` on reaction wakes (last-writer-wins across surfaces — known limitation) |
| `commands/dm_mqtt.rs` | **Instant DM delivery** (GA in 0.3.0, all signed-in users). MQTT-over-WSS receiver: fetches scoped STS creds from `POST /v1/realtime/credentials`, SigV4-presigns the AWS IoT Core endpoint (sign WITHOUT the session token, append `X-Amz-Security-Token` after — IoT rejects a token in the signed query with 403), subscribes to its own `hq/{personUid}/dm`, and on any wake (and on connect/reconnect for offline catch-up) calls `dm_notify::poll_dm_once` — the MQTT message is only a wake signal, so dedupe/cursor/notification all reuse the poll path. Spawned from `main.rs` `.setup()`; capped exponential backoff; on any failure falls back silently to the 60s poll (no regression). Log codes `DM_MQTT_*`. |
| `commands/notifications.rs` | OS notification permission state + request (`notification_permission_state` / `notification_request_permission`) |
| `commands/desktop_alt.rs` | GA desktop window gate, open/focus command, and read-only company panel commands. Uses `feature_gate::desktop_features_enabled()` for UI eligibility and backend enforcement. Board/Activity call the vault API, Deployments calls hq-deploy with `x-org-slug`, and Secrets returns metadata-only `{key, upd, rot}` rows with no plaintext fields. The window is built `transparent(true)` and gets its native glass backing applied via `glass::apply_liquid_glass_window` right after build (0.8.1-beta.1). `get_company_project_creators` (0.8.2-beta.1) fetches the cloud board for a company and returns only projects that carry a non-empty creator (derived from the prd's S3 `created-by` metadata) for the Projects-list Lead column — projects with no stamped creator stay "Unassigned" (pure parse in `parse_project_creators`, unit-tested) |
| `commands/messages.rs` | All `/v1/notify/*` channel + DM HTTP from Rust: channels, threads, reactions, members. Lifecycle additions (0.10.194): `run_card_action` (POST `/v1/notify/channels/{id}/cards/{cardId}/actions` with a client `idempotencyKey`; a 409 replay counts as success, a 403 surfaces its reason on the card, and every 2xx runs the activate-cloud reconcile pass), `get_company_tab` (GET `/v1/companies/{uid}/tabs/{tab}`) and `run_company_tab_action` (POST a `tab_row` card action for the Team / Integrations / Settings tabs) |
| `deep_link.rs` | `hq-desktop://` URL scheme (0.10.194). Only `hq-desktop://setup?checkout=done&company={uid}` is accepted — host *or* path may be `setup`, and `company` must match `^cmp_[A-Za-z0-9_-]+$`; every other URL is parsed and dropped as inert. Focuses Messages on `#setup`; cold-start hits are stashed in `PendingSetupTarget` and drained by the `take_pending_setup_target` command. Registered via `tauri-plugin-deep-link` on the Rust side only (`tauri.conf.json` `plugins.deep-link.desktop.schemes`) — the webview holds no deep-link permission. Log codes `HQ_DESKTOP_SETUP`, `HQ_DESKTOP_REGISTER_FAIL` |
| `glass.rs` | Native macOS "Liquid Glass" window backing (0.8.1-beta.1, macOS 26 Tahoe). `apply_liquid_glass_window` resolves `NSGlassEffectView` at runtime and inserts it at the very back (`NSWindowBelow`) of the transparent desktop window's content view so the window reads as live glass over the desktop; on pre-Tahoe macOS it falls back to the same `NSVisualEffectView` `UnderWindowBackground` vibrancy the tray window uses. Main-thread-only — callers must invoke via `run_on_main_thread`. The native material backs the *window*; in-window panels get matched translucent styling in CSS (it cannot refract the webview's own DOM) |
| `commands/settings.rs` | Settings persistence |
| `commands/autostart.rs` | Login-item autostart. `ensure_autostart_on_launch()` (called from `main.rs` `.setup()`, macOS-gated) idempotently reconciles the LaunchAgent plist with the effective `startAtLogin` pref on every launch — **default-on** (a fresh install autostarts without opening Settings), honouring an explicit `"startAtLogin": false` opt-out (stale plist removed). Mirrors the `daemon.rs` `realtime_sync` default-on convention |
| `commands/dock.rs` | macOS Dock icon presence. `dock_icon_pref()` resolves `dockIcon` from menubar.json **default-on** (explicit `false` is the only opt-out); `set_activation_policy()` maps it to `ActivationPolicy::Regular` (Dock icon + Cmd-Tab + app menu bar) or `Accessory` (classic menubar-only). `apply_at_launch` (`&mut App`) runs from `main.rs` `.setup()` and `apply_at_runtime` (`AppHandle`) backs the `apply_dock_icon` command the Settings toggle calls after `save_settings`. **The two are not interchangeable** — tao re-applies its STORED policy at `applicationDidFinishLaunching`, which is after `.setup()`, so the AppHandle setter at launch is silently clobbered (and tao's stored default is `Regular`, so every user would get an unwanted Dock icon). The bundle keeps `LSUIElement=true` so the process always launches accessory and is promoted from there — an opted-out user never sees a Dock icon flash at login. A Dock click arrives as `RunEvent::Reopen` and routes through the new `ActivationSource::DockIconClick` → `ShowDesktop`, opening the full desktop window via `tray::show_desktop_window` (show-only, never toggles; signed-out users fall back to the `main` window's SignInPrompt). The Dock icon is an application-window affordance. `has_visible_windows` is ignored on purpose — a hidden-but-live notification banner would otherwise make the icon inert. **Dock badge:** `set_badge()` mirrors the unread-DM count onto the Dock tile, called from the only two writers of `UnreadDmState` (`dm_notify::bump_unread` / `reset_unread_dms`) so it is an exact function of that state with no poller. `format_badge_label` maps 0 → cleared and caps at `99+`; the module formats its own label because Tauri's `set_badge_count` stringifies 0 into a literal "0" badge on macOS. Not gated on `dockIcon` — no file read on the DM poll path, and the tile keeps its badge across a policy change so opting in mid-session shows the right count immediately |
| `tray.rs` | System tray with 4 visual states (idle/syncing/error/conflict) |
| `updater.rs` | Auto-update checker (10s delay, then every 6h). **Channel-aware**: resolves a per-user endpoint via `util/release_channel.rs` from `MenubarPrefs.release_channel` × `util/feature_gate::is_indigo_user`. Non-`@getindigo.ai` users are coerced to Stable regardless of stored preference (defense-in-depth). Exposes `available_channels` command for the Settings picker. |
| `events.rs` | Typed sync event structs (ndjson discriminated union; defined in `hq-desktop-core`) plus `parse_sync_line`, the single tolerant parser both `commands/sync.rs` and `commands/daemon.rs` use — unknown event types (such as the runner's additive `manifest-upload` outcome) and blank/malformed lines return `None` and are skipped |
| `sentry_scrub.rs` | Sentry event scrubber — strips Cognito tokens and home-dir paths before send |
| `util/paths.rs` | HQ folder resolver (4-tier — see below). Also provides `resolve_bin` + `child_path` for finding `hq` and node-shebang interpreters under launchd's minimal PATH |
| `util/ignore.rs` | Sync ignore rules — excludes `settings/`, `data/`, `workers/`, `.git/`, etc. from cloud sync (privacy class) |
| `util/journal.rs` | Append-only sync journal at `~/.hq/sync-journal.log` (used by Connect diagnostics) |
| `util/logfile.rs` | Persistent diagnostic log for the sync pipeline at `~/.hq/sync-debug.log` (rotated at 10MB) |

## Desktop Alt UX (GA — public since 0.7.0)

The desktop-alt UX is a second Tauri window labeled `desktop-alt`, declared hidden in `src-tauri/tauri.conf.json` with `create: false` and opened only by `open_desktop_alt_window`. **It is the default UI for a signed-in person** — tray left-click, the Dock icon and a second launch all land there (PL-05/PL-06), and the tray popover that used to be the default was deleted in PL-07.

Access is defense-in-depth:

1. `App.svelte` invokes `desktop_alt_enabled`.
2. `activate_primary_surface` (`src-tauri/src/tray.rs`) routes every activation to the desktop window unless setup still owns `main`.
3. `open_desktop_alt_window` calls the same backend gate again and rejects signed-out callers — the window graduated to GA via `feature_gate::desktop_features_enabled`; pre-release update channels stay Indigo-only via `is_indigo_user`.

Frontend files live under `src/desktop-alt/`. `DesktopApp.svelte` owns the route, V4 chrome, command-K palette, titlebar updater, sync event listeners, workspace loading, and meetings cache hydration. `route.ts` maps the sidebar rows and command-number hotkeys. The company work-system views read local goals/projects where possible; Activity, Deployments, and Secrets call `get_company_activity`, `get_company_deployments`, and `get_company_secrets`.

Important constraints:

- Any new desktop-alt invoke path must be allowed by `src-tauri/capabilities/desktop-alt.json`.
- Secrets are read-only metadata. Do not add `value`, `secret`, or reveal-mode fields to `SecretEnv` / `SecretItem`; `e2e/desktop-alt/secrets-never-leak.spec.ts` exists to lock this down.
- The current V4 route and UI contract lives in `docs/design/v4/IMPLEMENTATION-NOTES.md`; `docs/design/v4/SPEC.md` is a historical design input and must not be treated as the current screen inventory.

## Config Files (User Machine)

| File | Written By | Purpose |
|------|-----------|---------|
| `~/.hq/config.json` | hq-installer | Company UID, slug, person, bucket, vault URL, HQ folder path |
| `~/.hq/menubar.json` | This app | HQ path override, syncOnLaunch, notifications, startAtLogin, autostartDaemon, realtimeSync, personalSyncEnabled, instantSync, driftStagingRepo, shareNotifications, releaseChannel, machineId, firstRunCompleted, autoSyncNoticeShown, cliAutoUpdate, cliUpdateDismissedVersion (the hq-CLI version the user dismissed the "update available" notice for — sticky until a newer version publishes), dockIcon (macOS Dock icon on/off, default ON) |
| `~/.hq/cognito-tokens.json` | hq-installer / this app | Cognito access + refresh + id tokens |

## HQ Folder Path Resolution

Priority order (in `util/paths.rs::resolve_hq_folder`):

1. **`menubar.json` -> `hqPath`** — user override via Settings, OR canonical path written by hq-installer ≥0.1.28 at end of install wizard
2. **`config.json` -> `hqFolderPath`** — legacy path from older hq-installer flows
3. **Discovery via `core.yaml` signature** — scans candidate locations (`~/HQ`, `~/hq`, `~/Documents/HQ`, `~/Documents/hq`, `~/Desktop/HQ`, `~/Desktop/hq`) for a folder containing a valid `core.yaml` with `version` + `hqVersion` fields. First match wins
4. **`~/HQ`** — hardcoded last-resort default

### Why core.yaml is the discovery signature

- It exists at the root of every hq-core install (locked file)
- It has a verifiable schema (`version: 1` + `hqVersion: "12.0.0"`), not just a presence check — random folders won't false-match
- It's not present anywhere else in an HQ tree (unlike `companies/manifest.yaml`, which exists in many sub-locations and would cause false matches deep in the tree)

### Why this exists

The installer wizard lets the user pick any folder for their HQ install. Prior to hq-installer v0.1.28, it didn't communicate that path to HQ Sync, so HQ Sync's old fallback was a hardcoded `~/HQ` — a user who picked anything else (or whose `~/HQ` got moved) saw "0 files synced" forever. The v0.1.28 paired release fixed this:

- **hq-installer v0.1.28** writes `hqPath` to `~/.hq/menubar.json` after extraction, restoring Priority 1 as the canonical path for new installs
- **hq-sync v0.1.28** added Priority 3 (discovery) as a safety net for installs that already happened under the old flow

Discovery is the safety net, not the primary mechanism — once a user runs the v0.1.28+ installer, Priority 1 is always populated.

## Workspaces & Connect Flow

The desktop window renders a row per workspace. Workspaces are computed in `commands/workspaces.rs` as the **union** of:

1. **Manifest companies** — every company present in `companies/manifest.yaml` on disk (always includes `personal`, even if not yet provisioned in HQ-Cloud)
2. **Cloud memberships** — companies the signed-in user belongs to according to hq-ops `/v1/users/me/memberships`

Each row carries a `connectState` (`connected | needs_connect | provisioning | error`) and exposes a per-row **Connect** button when the company exists in the manifest but has no S3 vault yet. Replaced the older "No companies yet" empty-state dead-end (v0.1.21) — there is now always at least one row (`personal`) to act on.

The `personal` row is special-cased: if it's missing from the manifest at sync time, `commands/personal.rs` auto-provisions the directory + bucket so first-time users always have a working sync target.

### "You've been added" Membership Prompt

When the signed-in user has an **active cloud membership with no local folder yet** (`state === 'cloud-only'` + `membershipStatus === 'active'`) — they accepted an invite via the email link or HQ Console but never pulled the workspace to this machine — the desktop window surfaces a one-click banner: "You've been added to {company} — Sync to pull it". This is the primary local-attach fix for modern tokenless, email-keyed invites: an accepted teammate shouldn't have to know any CLI command, since the membership already arrives in the `workspaces` data (recomputed on window open / mount / post-sync).

- The eligible rows are computed by the pure helper `joinableMemberships()` in `src/lib/workspaces.ts` (dedupe → keep only `cloud-only` + `active` → exclude the `personal` slug), unit-tested in `src/lib/workspaces.test.ts`. Pending (unaccepted/ungranted) invites are excluded — those render as NOT CONNECTED invite rows on the V4 Companies surface instead.
- The banner is `MembershipSyncBanner` in the desktop shell (`packages/ui/src/shell/DesktopApp.svelte`). Its Sync action runs the existing full sync, which pulls the new company and flips the row to `synced`, clearing the prompt for good. Dismiss is session-scoped (`dismissedMemberships` `$state`) and non-destructive.
- **The personal vault is never a "you've been added" target** (fixed #249, v0.8.4). The personal vault is assembled as the canonical `kind=Personal` / `state=Personal` row and auto-provisions via the person entity — it must never surface as a `cloud-only` company prompt. This is guarded in two places (defense-in-depth): `assemble_workspaces` §2 (the cloud-only pass in `commands/workspaces.rs`) skips `entity.slug == "personal"` so the phantom `company:personal` row is never emitted, and `joinableMemberships()` enforces the same `slug !== 'personal'` exclusion on the consumer side. Without the Rust guard the phantom row leaked under a different dedupe key (`kind=Company` vs. the real `kind=Personal`), so the composite `kind:slug` dedupe couldn't collapse it and it drove a bogus "You've been added to Personal — sync to pull it" prompt. Rust + frontend regression tests cover both legs.
- Otherwise it rides the data `list_syncable_workspaces` already returns. The proactive "notify even while the window is closed" piece (native notification + idle poll) is a separate, not-yet-shipped story.

## First-Run Onboarding

There are no onboarding pages. The welcome carousel (`FirstRunWelcome`) and the one-time auto-sync notice (`AutoSyncNotice`) were removed — on a brand-new install the app simply shows the onboarding card and starts syncing.

The launch kind is still classified once at `.setup()` (`commands/first_run.rs`) and drives `App.svelte`'s `runOnboarding`:

- **FirstRun** (brand-new install) — the onboarding card force-opens, the first cloud sync auto-starts (`handleSyncNow`), and `mark_first_run_complete` is persisted immediately (writes `firstRunCompleted` + `autoSyncNoticeShown`, and makes "sync is on" explicit via `realtimeSync` + `personalSyncEnabled` true). Never repeats — every later launch classifies as `Normal`, so the card only force-opens once.
- **ExistingUpdate** / **Normal** — no forced window, no UI. (`should_show_auto_sync_notice` / `mark_auto_sync_notice_shown` remain registered for back-compat but are no longer called by the frontend.)

Sync-on-launch (`syncOnLaunch`) defaults **ON**, matching the always-on auto-sync (`realtimeSync`) default, so a fresh install syncs as soon as it opens.

Classification rationale (why it runs before `ensure_machine_id`) is documented at the top of `commands/first_run.rs`.

### Welcome flow (onboarding UI)

`Onboarding.svelte` hands `main` to the welcome flow with `set_welcome_window` (`src-tauri/src/welcome_window.rs`), which fits the window to the current monitor's work area in logical units with no shadow (first run does the same in `main.rs` before the window is shown, and `tray::show_onboarding_window` re-fits instead of anchoring under the tray icon while `welcome_window_active()`). It then calls `get_desktop_wallpaper`: on macOS the screen's wallpaper via `NSWorkspace desktopImageURLForScreen:`, scaled to at most 1600px and returned as a JPEG data URL, which `OnboardingWizard` paints as `.wallpaper` under a veil that blurs (backdrop-filter 34px, saturate 125%) and dims it over 1.8s. When no wallpaper comes back (non-macOS or any failure) it falls back to `set_welcome_backdrop`: an `NSVisualEffectView` (HUDWindow, behind-window, DarkAqua, tagged `hq.welcome-backdrop`) at the back of the content view, or the dark Acrylic backdrop on Windows. No screen-recording permission is involved. Unmount removes the backdrop, calls `set_welcome_window(false)`, and restores the centered 288x360 popover material. While the welcome flow owns `main` the window has native close and minimize controls (`welcome_window::apply_window_controls`: macOS traffic lights over an overlay title bar with the title hidden, set as one synchronous style mask; Windows caption buttons plus a taskbar button). Zoom stays disabled. Close hides the window (the `main` `CloseRequested` handler) and the install keeps running; the menu-bar item and the Dock reopen it through `activate_primary_surface` -> `show_onboarding_window`, which un-minimizes. A blur never hides the welcome window (`BlurHideInputs::welcome_window`). `OnboardingWizard.svelte` renders five story scenes (welcome, folder, cloud, shortcut, ready) over the unchanged step model; the `consent` scene is only the consent-only runs (`mode: 'consent'` / `'reprompt'`). The welcome scene is the first-run sign-in screen. Its "Continue with Google" and "Continue with Microsoft" buttons render when the mark animation settles and reveals the sign-in block (`signInActionsReady`, set by the mark engine's `onSettle`, at once under Reduce Motion, or when the motion fails). Nothing opens in the browser until the person clicks one: the click calls `start_oauth_login` and opens the URL it returns. The wizard starts no browser session continuation. On the sign-in step it only records the first-launch receipt (`recordLaunch`, through `desktop-session-continuation.ts`); automatic continuation remains only in `SignInPrompt.svelte`. The scene model, chrome (ticks, Back, Skip intro), install-card model and ready gate are pure helpers in `src/lib/welcome-flow.ts`. "Install here" starts the existing install stages in the background; the corner card on the two explainers reads real stage progress. The ready screen leads with a large white HQ Desktop card (icon, name, one line). Under it, smaller dark pill buttons for Claude Code and Codex appear only for tools `detect_ai_tools` reports installed (none while detection is pending; the 3s re-probe adds one that gets installed). The cards sit in the ready scene's `.nav`, whose height the ready engine measures, so the layout holds for zero, one or two tool buttons. Under them is only the usage-data line: there is no Advanced section, no manual folder or copy tools and no install links (the install/download handlers and the Claude readiness watch were removed with them). A failed launch shows the inline `onboarding-escape` note (`src/lib/onboarding-escape.ts`), worded to point at HQ Desktop rather than manual tools. That line is one "Share anonymous usage data" checkbox (checked by default) with a "What's collected" link. Motion lives in `src/components/onboarding/welcome/` (`engines.ts`, one rAF `controller.ts` that runs only the visible scene, stops while the window is hidden, excludes hidden time, renders settled frames under Reduce Motion, and retires a throwing engine to the `motion-failed` fallback). Styles are global in `welcome.css` under `.hq-welcome` (Svelte scoped CSS would strip imperatively added classes); Fraunces is bundled in `src/assets/fonts/`. The usage-data answer is recorded in `finishWithRecovery`, before any finish from the ready screen (Open HQ Desktop, a Claude Code or Codex launch), with the same `post_telemetry_opt_in` payload; a server failure blocks the finish until Retry, an offline failure with a cached answer offers "Finish setup, send later". The ready screen cannot finish while the install runs (HQ Desktop and the tool buttons wait for it), so the deferred path in `src/lib/deferred-consent.ts`, which caches the answer locally and holds it until the person entity exists, is a guard that the ready screen does not normally reach. `mode: 'replay'` (tray "Replay welcome intro") shows scenes 0-3 with Next/Done and writes no flags. Dev preview: `/dev-harness/index.html?view=onboarding` (`&mode=replay`).

### Guided tour (desktop window)

After the welcome flow hands off to the desktop window, a fresh install gets an eight-step spotlight tour: (1) the setup bot (the DM composer when the bot's DM is open, else the #welcome hero, else its sidebar row); (2) the titlebar Files button (`titlebar-files`; the tour does not open the explorer, and the web host, which hides the button, gets a centered card); (3) the sidebar "+" button (`chat-new-message`), which opens the create modal whose picker has New bot (the tour does not open the modal); (4) invites, pointed at the sidebar's Companies section because the desktop shell mounts no send-invite control (the Team panel's `team-invite` wins if one appears; with no company the card is centered and says invites open once setup creates it); (5) the titlebar meetings button; (6) the titlebar web-console globe; (7) the titlebar Launch menu, held open through V4TitleBar's `launchMenuForcedOpen` prop; (8) the command palette. The tour never navigates: steps point at the control a person clicks to get somewhere, and the only surfaces it opens are the Launch menu and the palette, which it closes when it leaves their step. Starting it, Done, Skip and Esc leave the route and the selected conversation as they are, so a conversation that opens mid-tour (the auto-started setup bot's DM, or one the person clicks) stays open. Step 1 re-resolves its target while it is showing, so it moves to the DM composer when the setup bot's DM opens. The model (steps, transitions, target resolution, cutout and card geometry, the auto-start gate) is `packages/ui/src/tour/guided-tour.ts`; the layer is `packages/ui/src/tour/GuidedTour.svelte` (z-index 20000, `data-hq-tour`, which the Launch menu's outside-click handler ignores; its window capture-phase key handler stops Escape and Tab it handles from reaching listeners registered later); `DesktopApp.svelte` wires it. Steps advance only on Next; Esc and Skip end it. A step whose target is missing shows the card centered after 1.5s (at once when the step has no target). It starts by itself once, 600ms after `onShellReady`, when `get_setup_status` answers `welcomeSetupOwed: true` and `welcomeTourShown: false` and #welcome or the setup bot's DM is on screen. It is recorded as shown the moment it appears: `mark_welcome_tour_shown` writes `welcomeTourShown: true` to `~/.hq/menubar.json` (the adapter method is `settings.markWelcomeTourShown`), and the localStorage key `hq.welcome.tour.v1` is the fallback for hosts without it. "Take the tour" in the command palette replays it at any time. Preview: `npm run dev:preview`, then `/dev-harness/index.html?view=shell&persona=multi-company&tour=1` (the mock host answers as a fresh install and the harness clears the local key).

### Calm First-Sync Labeling

The first sync of a fresh HQ uploads the entire release-shipped `core/` scaffold (docs, hooks, knowledge, policies, scripts, skills, workers) — identical for every user, not the user's own content. `src/lib/progressLabel.ts` collapses any `core/…` path (`isCorePath` → `CORE_SETUP_LABEL` = "Setting up HQ core files…") so the live label reads as one-time setup rather than a flood of unfamiliar files. Wired into the desktop-alt status line (`desktop-alt/lib/sync-model.ts` `currentSyncLabel`). Display-only — the honest file counter and what actually gets stored are unchanged.

## First-Push Protection

`commands/first_push.rs` runs before any company's first upload and rejects the push if any of these would be sent to S3:

| Excluded path | Reason |
|---|---|
| `**/settings/` | Credentials, OAuth tokens, vault refs |
| `**/data/` | Company datasets (added v0.1.x cloud-sync exclude) |
| `**/workers/` | Prompt libraries — same privacy class as settings |
| `**/.git/` | Git internals |
| Anything matched in `util/ignore.rs` | General sync ignore set |

Enforced via `util::ignore::tests::company_local_dirs_are_ignored`. A failed first-push protection check surfaces as a `sync:error` event with code `FIRST_PUSH_BLOCKED` and the offending path.

## Telemetry Collector

`commands/telemetry.rs` runs after each successful sync (best-effort, async, errors swallowed):

1. Read `~/.hq/telemetry-cursor.json` (last-sent state)
2. Walk the HQ tree, count files / sizes / company breakdown
3. Diff against cursor
4. Check opt-in: vault `/v1/usage/opt-in` (authoritative) → falls back to `telemetryEnabled` in `~/.hq/menubar.json` if vault is unreachable
5. If opted in, POST diff to `/v1/usage`
6. Update cursor

The cursor is per-machine (keyed by `machineId` in menubar.json) so re-installs don't double-count.

## Auto-Provisioning (UJ-006)

On first sync after a fresh install, `commands/provision.rs` and `commands/personal.rs` perform two background provisions:

1. **Person entity** — POSTs to vault `/v1/people` to create the user's `person` record in HQ-Cloud (idempotent — server returns existing if already created). Uses Cognito email from the access token as the lookup key.
2. **Personal company bucket** — if `companies/personal/` exists locally but has no `bucket` mapping in vault, requests S3 bucket creation + writes the bucket ref back to the local `companies/personal/settings/vault.json`.

Both are best-effort and don't block the sync. Failures log to the diagnostic log (`util/logfile.rs`) with a `PROVISION_*` code so Connect-diagnostics surfaces them.

## Sync Event Protocol

`hq sync --json` emits ndjson lines. Types defined in `events.rs`:

```
{"type":"progress","company":"indigo","path":"docs/a.md","bytes":42,"direction":"down","author":"user@example.com"}
{"type":"conflict","path":"file.txt","localHash":"aaa","remoteHash":"bbb","canAutoResolve":true}
{"type":"error","code":"NET_FAIL","message":"Connection reset"}
{"type":"complete","filesChanged":7,"bytesTransferred":204800,"journalPath":"/tmp/j.log"}
{"type":"new-files","company":"indigo","files":[{"path":"docs/new.md","bytes":1024,"addedBy":"user@example.com"}]}
```

On `progress`, `direction` (`"up"`/`"down"`, hq-cloud ≥5.29) and `author` (download-only, from S3 `created-by`, hq-cloud ≥5.31) are optional — older runners omit them. The activity log uses `author` to attribute each downloaded file ("{author} added/updated") and reconciles the per-company `new-files` event onto the matching download rows to flip the verb from "updated" to "added" and back-fill `addedBy` where `author` was absent (`commands/activity.rs::record_new_files`).

Parsed via `#[serde(tag = "type")]` discriminated union. Unknown types silently skipped.

All ndjson consumers go through `events::parse_sync_line` so that guarantee holds on both the manual-sync and watch-daemon paths. hq-cloud's post-sync manifest-upload hook (sync-reconciliation-audit, US-004) emits an additive `manifest-upload` event per scope after `all-complete` that this app does not model; it is diagnostic-only and must keep being skipped — never routed through `is_alertable_error`, never allowed to change a sync verdict or block the UI.

The `HQ_CLOUD_VERSION` pin in `crates/hq-desktop-core/src/hq_cloud.rs` is `~6.18.17`. 6.18.17 (hard-stop readiness, US-012) treats plan-limit refusals as skipped files with a reason: the company stays `complete`, refused paths arrive on the `plan-limit` event, `complete` gains optional `filesPlanLimited`, and refused keys pause for up to an hour. The desktop already handled both runner shapes, so it adds no behavior floor, and the runner-error vocabulary is unchanged (no new identity). The previous pin, `~6.18.16`, fixes the watcher dropping files saved while an ignored folder (`node_modules/`, `build/`) is created inside a watched tree or during the macOS FSEvents stream recreation; those files waited for the six-hourly rescan. It adds no behavior floor, and the runner-error vocabulary is unchanged (its two new identities are caught before runner-event serialization). `RESCUE_CONTRACT_FLOOR` stays 6.18.0 (it moved there with the `~6.18.5` pin) so the desktop pill and `hq rescue` (hq-cli bundles hq-cloud `~6.18.13`) stay on one minor line. `MANIFEST_UPLOAD_MIN_HQ_CLOUD` (6.16.23), `UNROUTED_OVERFLOW_MIN_HQ_CLOUD` (6.16.24), `ROOT_BIN_EXCLUSION_MIN_HQ_CLOUD` (6.16.25), and `AREA_COLLISION_HEAL_MIN_HQ_CLOUD` (6.16.26) are desktop-visible behavior floors and remain unchanged. The runner-error vocabulary gained five hq-cloud identities at the `~6.18.5` pin (52 -> 57). The previous 6.16.53 pin notes follow. The 6.16.53 runner stops one company skill from wedging a whole company's sync: a renamed or copied skill folder reserves its identity for its new path before upload, a landed 409 is recovered instead of aborting the leg, every other per-skill registration failure is contained to that skill (new `not-shipped` reason `skill-registration-failed`), and registration errors name the file and service code. Runner bug fixes, not a new desktop-visible capability, so this pin bump deliberately adds no behavior floor. Semver admission is not delivery: changing the requested spec is what moves npm's npx cache key, while the exact-pin test keeps that move deliberate.

## Process Management

- Singleton handle per process type (`hq-sync` for sync, `hq-sync-daemon` for daemon)
- `try_register_handle()` is TOCTOU-safe (atomic check-and-register)
- SIGTERM with 5s grace before SIGKILL
- 10-minute hard timeout on sync runs

## Daemon (V2 Prep)

Feature-flagged behind `autostartDaemon: true` in `~/.hq/menubar.json` (default: false). UI does NOT expose daemon controls in V1. Commands exist (`start_daemon`, `stop_daemon`, `daemon_status`) but are only reachable via Tauri devtools.

State files: `.hq-sync.pid`, `.hq-sync-daemon.json` in the HQ folder.

## App Icon (Dock)

`src-tauri/icons/*` are generated, not hand-edited. Pipeline:

```
src-tauri/icons/source/app-icon-master.png   1024 dock-ready artwork
  -> python3 scripts/generate-app-icon.py    verifies the grid, passes through
  -> src-tauri/icons/app-icon.png            1024 canvas, grid-aligned
  -> pnpm tauri icon src-tauri/icons/app-icon.png -o src-tauri/icons
```

The master is now exported dock-ready from the design file: already on Apple's
grid, with its own continuous-curvature squircle and a soft drop shadow beneath
the tile, as Apple's own template has. `generate-app-icon.py` detects that (the
body already sits at the grid inset) and passes it through untouched — masking
it again would inset it a second time and clip the shadow. Feed it full-bleed
art, such as `source/app-icon-flat.png`, and it falls back to the original
behaviour of shrinking to the body and masking with the grid squircle.

Because the shadow legitimately extends past the grid, geometry is measured
against the icon *body* — pixels at alpha >= 250 — not against any non-zero
alpha, which would read the shadow as part of the tile.

**macOS does NOT mask or inset app icons.** Whatever the bundle ships is drawn
into the Dock tile verbatim, so the rounded-rect shape and the margin around it
must be baked into the artwork. HQ shipped a full-bleed 512x512 square with
fully opaque corners, so the Dock rendered a hard-edged square that read
visibly larger than the inset squircles every other Mac app ships.

Apple's grid on a 1024 canvas: body **824x824 centred** (100px transparent
margin every side), corner radius **185.4**. The mask is supersampled 4x and
downsampled with `Image.BOX` — a coverage mask is an area-average, and `LANCZOS`
rings, leaving faint alpha ~3px OUTSIDE the geometric edge (measured bbox
97..927 instead of 100..924) plus a halo.

⚠ **`src-tauri/icons/app-icon.svg` is STALE — never regenerate from it.** It
describes a near-black tile with a gradient wordmark; HQ actually ships a
pink/violet gradient tile with a white wordmark (shipped raster mean opaque RGB
~(195,119,173); the SVG rasterises to ~(52,44,50)). Running `tauri icon` against
it silently rebrands the app. The master PNG was recovered from the 1024x1024
`ic10` representation inside the previously shipped `icon.icns`.

`__tests__/stories/app-icon-grid.test.ts` decodes the generated PNG and asserts
transparent corners, the exact grid inset of the body, corner rounding, that the
drop shadow stays soft and falls below the tile, and that the mean colour is
still the pink/violet brand — so both a full-bleed regeneration and an
accidental rebrand fail in CI. Verified non-vacuous: a full-bleed icon fails 5
of its assertions and a near-black flat fill fails the colour assertion.

Note the runtime `NSApp.applicationIconImage` override in `main.rs` still feeds
the Dock `128x128@2x.png` (256px), which is exactly the Dock's max size
(128pt @2x) — adequate, but it does replace the multi-rep `.icns` for every
surface, so a larger source would be needed if a bigger rendering ever matters.

## Tray Icon

4 embedded PNG icons (`src-tauri/icons/tray-*.png`) are generated from the official HQ mark at `src-tauri/icons/source/HQ.svg` by `scripts/generate-tray-icons.py`. The generated canvases are 38x22 at @1x and 76x44 at @2x, monochrome black on transparent so macOS can template-invert them for light/dark menu bars. Runtime icons are cached via `OnceLock` after first decode. State swaps go through the `set_state_icon()` helper, which calls `set_icon()` then re-asserts `set_icon_as_template(true)` — macOS drops `isTemplate` on every `set_icon()`, so without the re-assert the template glyph would render as raw pixels after the first state change.

Left-click opens the desktop window (`activate_primary_surface`), or the onboarding card while setup still owns `main`. Right-click shows context menu (Sync Now / Open desktop view / Sign Out / Quit HQ — aligned to the 0.9.8 notifications-first redesign). Tray state auto-updates from sync event listeners.

## Build & Release

- **Dev:** `npm run tauri dev`
- **Build:** `npm run tauri build`
- **DMG:** `scripts/create-dmg.sh`
- **Notarize:** `scripts/notarize.sh`
- **CI:** `.github/workflows/release.yml` builds the complete macOS/Windows matrix, uploads all 15 assets to a hidden draft, verifies the exact remote contract, then publishes with one PATCH. Publication is serialized across tags; stable rollbacks fail closed, and an exact healthy public release is a read-only rerun success.
- **Auto-updater:** the workflow generates a four-platform `latest.json` inline. Stable uses GitHub's `/releases/latest/` alias; beta and alpha resolve tag-pinned manifests and cannot replace stable latest.
- **Windows prerelease packaging:** `scripts/windows-msi-version.mjs` maps `X.Y.Z-beta.N` / `X.Y.Z-alpha.N` to numeric MSI-only `X.Y.Z`; full SemVer remains on the app, NSIS, updater, tag, and artifact names.
- **Update notification banner:** when an update is detected, a native banner with an "Update now" chip surfaces. Its action (`kind === 'update'`, `action === 'update'` in `App.svelte`) must open a window (`show_main_window`, which PL-05 retargeted at the desktop window) AND run the install through the SAME guarded path the in-app Install button uses (`handleInstallUpdate`), with dedupe + error handling (fixed #248, v0.8.3). A bare `invoke('install_update')` from the notification installed invisibly — no window opened and `updateInstalling` never flipped — so it read as "nothing happened" until the app abruptly restarted.
- **Release operations:** see `../../docs/RELEASE.md` for version stamping, signing variables, channel behavior, artifact shape, and retry semantics.

## Performance Budgets

Documented in `tests/PERF.md`:
- Idle memory: <50 MB
- Bundle size: <15 MB
- Window open: <100 ms

## Testing

Release testing still uses `tests/MANUAL_TESTING.md` plus Loom proof. Rust unit tests cover serialization, config parsing, process management. Frontend and story tests run with `npm test`. Desktop-alt gate/window/page/secrets coverage runs with `npm run test:e2e:desktop-alt`; it uses a scripted source-contract harness by default and can switch to live `tauri-driver` with `HQ_SYNC_DESKTOP_ALT_LIVE=1` plus `HQ_SYNC_DESKTOP_ALT_APP` or `HQ_SYNC_DESKTOP_ALT_APP_PATH`.

Channel-native lifecycle coverage (0.10.194): `e2e/desktop-alt/lifecycle-company-channel.spec.ts`, `__tests__/stories/lifecycle-{cards,browser-scenario}.test.ts`, and under `packages/ui/src/chat` the `US-*.story.test.ts` files plus `messaging/LifecycleCard.test.ts`, `card-action.test.ts`, `agent-channel.test.ts`, `tabs/*.test.ts`. For visual QA run `npm run dev:preview` and open `/dev-harness/index.html?view=lifecycle` (`&role=member` for a viewer who cannot act, `&state=blocked` for the blocked states).

**Company-isolation seam test.** `packages/ui/src/shell/DesktopApp.company-switch.test.ts` is the canonical guard for the tenant boundary, and the place to add coverage when a new tenant-scoped surface appears. It mounts the real `DesktopApp` with two companies, drives the real scope switcher in the sidebar, and asserts four things across the switch: every tenant-scoped surface re-scopes to the company now on screen; none of the first company's data is readable as the second through a store, a storage key, or the rendered DOM; switching back restores the first company's pins, drafts and rail; and requests still in flight when the switch happens (channel fetch and contact roster) cannot paint into the new company's view. Only the platform adapter is mocked, and only at the network boundary — `createTenantStorage`, the sidebar stores and the shell wiring all run for real, so a regression at the seam fails here rather than in a mock. Two details are deliberate. The storage-key sweep exempts `hq.chat.conversation-cache`, which is the account-wide directory snapshot and is a superset at rest by design; the DOM assertions are what pin it to a correctly scoped rail. The mention-picker assertion is paired with a positive check that the second company's own roster is still offered, so an empty picker can never pass the leak assertion for free.

The two harness modes run disjoint spec sets, enforced in `e2e/desktop-alt/vitest.config.ts`:

- **Scripted** (default, `Desktop-alt E2E` in ci.yml) owns everything that assumes a signed-in user — including `smoke-pages.spec.ts` and `window-lifecycle.spec.ts`, which mirror the Rust gate for an authenticated email.
- **Live** (`HQ_SYNC_DESKTOP_ALT_LIVE=1`, the two Windows jobs in windows-check.yml) runs only `live-preauth.spec.ts`. A CI runner has no Cognito session and must not be given a fake one, so the live smoke asserts signed-out reality against a real binary: the app boots, the `main` window paints its sign-in surface with zero console errors, and `open_desktop_alt_window` is refused by `feature_gate::desktop_features_enabled` with `desktop-alt requires a signed-in user`. It shares ONE WebDriver session across the file (`beforeAll`) because `tauri_plugin_single_instance` folds a second launch into the running process, leaving later sessions attached to a webview with no Tauri bridge.
- Live mode on Windows additionally requires the app to be built `--features e2e-automation` (see `src-tauri/src/util/webview2_automation.rs`); without it msedgedriver's `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` never reaches the WebView2 browser process and session creation dies with `DevToolsActivePort file doesn't exist`.

## Exit Lifecycle — and why Windows session end is not `ExitRequested`

There are **two** exit paths, and they are not interchangeable. Assuming
otherwise is what caused HQ-DESKTOP-44, a fatal fleet-wide native panic.

| Path | What fires | What runs |
|---|---|---|
| App-initiated quit (tray Quit, `quit_app`, Cmd-Q, last window closed) | `RunEvent::ExitRequested`, then `RunEvent::Exit` | the `ExitRequested` teardown, then tauri's `cleanup_before_exit()`, then tao's own `process::exit(exit_code)` |
| Windows session end (shutdown / logoff / forced restart) | `RunEvent::Exit` **only** | the Windows-gated session-end branch in the `Exit` arm |

`RunEvent::ExitRequested` is raised by `tauri-runtime-wry` in exactly two
places: when the last window is destroyed, and on `Message::RequestExit` (what
`AppHandle::exit` sends). Windows `WM_ENDSESSION` produces neither. So
`ExitRequested` is the chokepoint for every *app-initiated* quit, and for
nothing else — the comment in `main.rs` that once called it "the single
chokepoint for every quit path" was wrong for OS shutdown, and its consequence
was that at session end the app ran no teardown at all.

The failure was worse than a skipped teardown. tao handles `WM_ENDSESSION` by
calling `event_loop_runner.loop_destroyed()`, which moves the runner to
`RunnerState::Destroyed` and returns, leaving tao's own
`GetMessageW`/`DispatchMessageW` pump running. Every subsequent
`poll`/`send_event`/`main_events_cleared`/`redraw_events_cleared` routes through
`move_state_to`, whose final arm is
`(Destroyed, _) => panic!("cannot move state from Destroyed")` — and that panic
unwinds out of an `unsafe extern "system"` window procedure installed with
`SetWindowSubclass`, which aborts the process. tao's `catch_unwind` wraps only
`call_event_handler`, not `move_state_to`, so nothing catches it. The same
defect is present in tao 0.34.8 and 0.35.3, so a dependency bump is not a
remedy.

The remedy is app-level and lives at the only seam available:
`handle_run_event_exit` in `main.rs`. tao dispatches `Event::LoopDestroyed`
synchronously from inside the `WM_ENDSESSION` handler, `tauri-runtime-wry` maps
it to `RunEvent::Exit`, and tauri invokes the application callback *before*
`cleanup_before_exit()` — so no pump iteration intervenes between that callback
and the fatal dispatch. On the session-end branch the app runs the bounded
teardown (session-end observer shutdown, `terminate_all_for_exit`, then a capped
Sentry flush — children before flush, ~1.75s total against Windows' 5s default
`WaitToKillAppTimeout`) and then exits, denying the pump another iteration.

### The re-entrant second path (HQ-DESKTOP-44 regression reopen)

`RunEvent::Exit` only fires when tao's handler was **free** at `WM_ENDSESSION`.
There is a second delivery it can never see: a `WM_ENDSESSION` that arrives while
the handler is **taken** — the main thread is inside a nested Win32 message pump
that wry runs during WebView2 environment/controller creation
(`webview2_com::wait_with_pump` looping on `GetMessageW`), which tauri drives from
inside the event loop (a webview built off the main thread, and the config
windows + `.setup()` that run inside the `RunEvent::Ready` dispatch). tao's
`WM_ENDSESSION` arm then calls `loop_destroyed()` re-entrantly,
`call_event_handler` does `event_handler.take().expect(...)` on a `None`, and tao
panics **`either event handler is re-entrant (likely), or no event handler is
registered (very unlikely)`** out of its window procedure — aborting the process
before `RunEvent::Exit` is ever reached. That is the regression this issue
reopened: the prior fix holds for the free-handler path, but this one was
untouched.

The remedy is a seam **before** tao's arm: a thread-local `WH_CALLWNDPROC` hook
installed on the event-loop thread in `main()`
(`commands::session_end_intercept::install_session_end_intercept`). The system
calls a `WH_CALLWNDPROC` hook for every message *sent* to a window on the thread,
before the destination window procedure, and `WM_ENDSESSION` is a sent message.
The hook sees the committed `WM_ENDSESSION(TRUE)`, runs the **same** bounded
teardown, and exits — whether or not tao's handler is currently taken. The
`RunEvent::Exit` arm stays as the fallback for the non-re-entrant path; both route
through the shared, idempotent `windows_session_end_teardown` (a process-wide
once-latch), so whichever fires first wins and the other is a no-op.

Rules for anyone touching this area:

- **Do not** move the session-end fast exit off its `#[cfg(target_os = "windows")]`
  gate. On macOS and Linux it would skip `cleanup_before_exit()`, which tears
  down the tray icon and hides windows.
- **Do not** make the app-initiated branch exit the process. That path must stay
  exactly as it is, or tray and window resources leak on every quit.
- **Do not** use `APP_EXIT_REQUESTED` as the discriminator. It is set inside
  `terminate_all_for_exit`, which *both* paths call. The discriminator is
  `APP_INITIATED_EXIT`, written only by the `ExitRequested` arm.
- Everything in the session-end teardown runs inside a Windows window
  procedure. Keep every step individually capped, and keep it panic-free — a
  panic there aborts the process just as the original bug did.
- **Do not** move `install_session_end_intercept()` after
  `tauri::Builder::build()`. The `WH_CALLWNDPROC` intercept must be installed on
  the event-loop thread in `main()` *before* the builder, or a `WM_ENDSESSION`
  landing during the config-window WebView2 creation inside `RunEvent::Ready`
  (handler already taken) is missed. Pinned by
  `scripts/native-seam-wiring.test.ts`.
- **Do not** let the intercept and the `RunEvent::Exit` arm diverge. Both call
  the one `windows_session_end_teardown`, guarded by a process-wide once-latch;
  the intercept records `NativePanicSeam::AppSessionEndIntercepted`, the arm
  records `AppSessionEndExit`, and the teardown itself records the rest. Keep the
  teardown panic-free and idempotent.
- The deterministic re-entrancy proof is **double-gated** — compiled only under
  the `e2e-automation` feature AND armed only by
  `HQ_SYNC_SESSION_END_REENTRANCY_PROBE` — so it can never park the main thread of
  a shipped build. It parks the main thread in a `wait_with_pump`-shaped nested
  pump so the live `windows-session-end.spec.ts` re-entrant case can drive
  `WM_ENDSESSION` into it (red on the base, green on the candidate).
- **Do not** reorder the ownership report after `terminate_all_for_exit`.
  Immediately before terminating, the session-end branch writes
  `registered_pids()` to the path named by `HQ_SYNC_SESSION_END_OWNED_PIDS`
  (unset in every shipped build, so the path is inert in production). The live
  proof asserts against that report: its existence proves the branch ran, and
  the pids it names must all be dead. Emitted after the teardown it would
  truthfully name an empty registry and the proof would pass vacuously —
  `scripts/native-seam-wiring.test.ts` pins the ordering.
- **Do not** scope the surviving-child claim by process name. OS-level
  parentage is not ownership in either direction: `resolve_bin("npx")` picks up
  `npx.cmd`, which Rust batch-dispatches through `cmd.exe`, so an app-spawned
  npx child appears as a plain `cmd.exe` — and those particular children come
  from `materialize_hq_cloud_cache`, which uses a bare `std::process::Command`,
  is never entered in the process registry, and is therefore orphaned by an
  ordinary tray Quit too. Ownership comes from the app's own report.
- The wiring is pinned by `scripts/native-seam-wiring.test.ts` (mutation-checked
  against deletion, same-file relocation, and reordering) and proved end-to-end
  by `e2e/desktop-alt/windows-session-end.spec.ts`, which drives the real
  message sequence at a real binary in the `windows-check` workflow.

## Gotchas

- `tauri_plugin_updater::Update` is not `Clone` -- must call `updater.check()` again in `install_update`. This is a plugin constraint, not redundant.
- OAuth uses loopback port **53682** -- must match Cognito app client redirect URIs exactly.
- `hq sync --json` double-binds the HQ folder path (both `HQ_ROOT` env var and `--hq-path` CLI flag) for defense-in-depth.
- Tray icons must be `@2x` PNGs for Retina. `icon_as_template(true)` is required for macOS menu bar dark/light adaptation, but it is **not sticky**: macOS resets `isTemplate` to NO on every `set_icon()`, so each runtime swap must re-assert `set_icon_as_template(true)`. Always swap through the `set_state_icon()` helper rather than calling `set_icon()` directly.
- `nix::sys::signal::kill(pid, None)` (kill-0) can false-positive on PID reuse -- acceptable for V2 prep scope.
- **Multi-window ready handshake:** Secondary windows (e.g. `new-files-detail`) use a managed-state + `detail_window_ready` command pattern instead of timed `emit_to` delays. The renderer calls `detail_window_ready` after mounting its `listen()` handler, which emits the data and shows the window. This avoids the race where `emit_to` fires before the webview's JS event listener is registered.
- `on_window_event` in main.rs is scoped to the `main` window label -- the detail window can close independently without quitting the app.
- New files state (`newFilesList`) in App.svelte accumulates across companies within a single sync run and resets when a new sync starts.
- The desktop-alt window is not a ready-handshake window. It self-loads from Tauri commands after mount, so failures usually come from missing capability permissions, command registration drift in `main.rs`, or the Indigo gate rejecting the caller.
- **Deep links arrive two ways.** A cold start reads the URL out of `startup_args`; a warm second launch arrives through the `single-instance` plugin's `argv` (which is why `tauri-plugin-single-instance` carries the `deep-link` feature). Both funnel into `deep_link::spawn_open_hq_desktop_url`. Handling only `on_open_url` silently drops the cold-start case.
