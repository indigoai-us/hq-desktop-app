# hq-desktop-app

Monorepo for HQ's desktop applications.

| App | Path | Frontend | Platforms |
|-----|------|----------|-----------|
| **Installer** | `apps/installer` | React 19 + Tauri 2 | macOS, Windows |
| **Sync** | `apps/sync` | Svelte 5 + Tauri 2 | macOS, Windows (reunified) |

This repository consolidates three previously separate repositories — `hq-installer`,
`hq-sync` (macOS), and `hq-sync-win` (Windows) — into a single source tree. The two
sync repositories were a drifted fork of the same application and are being reunited
into one cross-platform sync app. Each source repository's full git history was
preserved under its destination subdirectory via `git-filter-repo`.

## Layout

- `apps/` — shipped desktop applications (`installer`, `sync`).
- `crates/` — shared Rust crates (auth/vault, cloud, process, platform seam, updater,
  notifications, telemetry, and per-app cores). Populated incrementally — see the plan.
- `packages/` — shared, framework-neutral TypeScript (config, IPC types, telemetry,
  design tokens). Populated incrementally.
- `imports/hq-sync-win/` — **temporary.** The imported Windows sync fork, kept only
  until every Windows-specific delta is represented in `apps/sync`, then removed.
- `tooling/scripts/` — versioning, release, updater-manifest, and download-page tooling.
- `docs/` — architecture, signing, updater, and release documentation.

## Status

This is a **freshly scaffolded** monorepo (history import + workspace skeleton). The
imported apps still carry their own lockfiles and build configuration; workspace
normalization, shared-crate extraction, the sync fork reunification, and the unified
release pipeline are staged work. The authoritative plan, including phased migration
steps with verifiable done-criteria, lives in [`MIGRATION.md`](MIGRATION.md).
