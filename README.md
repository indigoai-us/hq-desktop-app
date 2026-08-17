# hq-desktop-app

One HQ desktop application: **it installs, then it syncs.**

A single Tauri 2 binary that launches as an onboarding installer when HQ is not yet
set up, then becomes the long-lived HQ Sync menu-bar / tray agent once setup completes.
One download, one version, one updater stream.

This repository consolidates three previously separate repositories — `hq-installer`
(React), `hq-sync` (Svelte, macOS), and `hq-sync-win` (Svelte, Windows) — into one
source tree. The Svelte sync app is the base; the React installer's wizard and native
setup logic are being **ported into Svelte** as the app's first-run onboarding, and the
Windows sync fork is being folded back in for cross-platform support. Each source
repository's full git history was preserved under its destination subdirectory via
`git-filter-repo`.

## Layout

- `apps/sync/` — the one shipped app (Svelte 5 + Tauri 2). Onboarding/install + steady-state
  sync. Renamed to `apps/hq-desktop-app/` once the port stabilizes.
- `crates/` — shared Rust crates (auth/vault, cloud, process, platform seam, updater,
  telemetry, hq-content, installer-setup, sync-core). Extracted incrementally.
- `imports/hq-installer-react/` — **temporary** port source: the React installer, kept
  read-only until its flow, native commands, tests, and assets are absorbed, then deleted.
- `imports/hq-sync-win/` — **temporary** port source: the Windows sync fork, kept until
  its platform deltas (`new_files`, `rescue_script_cache`, Windows backends) are folded
  into `apps/sync`, then deleted.
- `scripts/` — repository tooling (versioning, release, updater manifests, fork-diff).
- `docs/` — architecture, signing, updater, and release docs.

## Status

The app ships from `apps/sync` with the **V2 desktop shell** as the current desktop
window (shipped in `v0.10.105-beta.1`, beta channel — PR #422). The consolidation
plan — install→sync state machine, command merge, phased migration with verifiable
done-criteria, and open questions — lives in [`MIGRATION.md`](MIGRATION.md).

## V2 shell release notes (v0.10.105-beta.1)

The HQ Desktop V2 redesign (PR #422) rebuilt every desktop screen on a new shell:

- **Workspace switcher: Cmd+0–9.** `⌘0` opens the Personal workspace and `⌘1`–`⌘9`
  switch to companies in connected-first sidebar order. **`⌘1`–`⌘4` no longer open
  Inbox / Meetings / Marketplace / Library** — those destinations remain reachable
  from the sidebar and the command palette.
- **Console-drop removals.** Deployments, Secrets, the Activity feed, and fleet
  Mission Control are no longer desktop surfaces — they moved to the HQ web
  console. Legacy deep links resolve to the nearest V2 screen or open the console
  in the system browser. The `get_company_secrets` command was deleted.
- **Conflict resolution: discard removed.** Conflict cards offer only
  **Keep local** and **Keep cloud**.
- **Popover rescue card** — conflicts (keep local/cloud), drift restore, and
  updates surface in one rescue card in the menubar popover.
- **Cloud Connected / Cloud Off** device-wide sync pause.
- **Library + Marketplace fold-in** — Marketplace lives in the Library sub-nav.
- **Settings → Appearance** — theme, opacity, interface size, Show in Dock.
- Goal–project linking, team vault analytics, Home portfolio + Today rail, and
  delivery states in Messages.
