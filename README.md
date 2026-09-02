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

Freshly scaffolded: histories imported, single-app skeleton in place. The app still
builds from `apps/sync` as imported; the onboarding port, command merge, Windows fold-in,
shared-crate extraction, and unified release pipeline are staged work. The authoritative
plan — install→sync state machine, command merge, phased migration with verifiable
done-criteria, and open questions — lives in [`MIGRATION.md`](MIGRATION.md).
