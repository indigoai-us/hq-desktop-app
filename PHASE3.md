# Phase 3 — Fold the Windows sync fork into `apps/sync`

Status: **in progress.** This document is the working checklist for making the
(macOS-only, but 691 commits ahead) `apps/sync` base compile and run on Windows,
using the older but cross-platform `imports/hq-sync-win` fork as the Windows
reference. It complements the high-level plan in `MIGRATION.md`.

## Key finding that shapes the work

`apps/sync` (macOS base) and `imports/hq-sync-win` (Windows fork) diverged mostly
because the **mac base advanced**, not because of Windows code. So this is **not**
a file-by-file three-way merge. The mac base is the source of truth for all shared
logic; we extract only the genuinely Windows-specific code from the fork and graft
it behind `cfg(target_os = "windows")`, while gating the mac-only code so it is
excluded on Windows.

Measured surface (mac base vs fork):

- mac base: **0** `cfg(windows)`, **0** `winreg`/`windows::`; **15** files use
  `nix`/`objc2`/`block2`/AppKit; **13** files already carry `cfg(target_os = "macos")`.
- fork: Windows code concentrated in **7 files** — `commands/autostart.rs`,
  `commands/daemon.rs`, `commands/notifications.rs`, `commands/process.rs`,
  `main.rs`, `tray.rs`, `util/paths.rs` (all using `winreg`/`windows::`).

## Verification reality

A Windows cross-compile **cannot be verified on the macOS dev box** (no per-target
Recall sidecar binary, no MSVC toolchain). The authoritative loop is the
`Windows check (Phase 3)` CI job (`.github/workflows/windows-check.yml`), which runs
`cargo check --target x86_64-pc-windows-msvc` on `windows-latest`. It is expected to
be **red until this checklist is complete**. Locally, every change must keep the mac
build green: `cd apps/sync/src-tauri && cargo check` (≈ 27s warm).

## Done in this pass (mac-verified)

- [x] `Cargo.toml`: moved `nix` out of unconditional deps to
  `[target.'cfg(unix)'.dependencies]`; added `[target.'cfg(target_os = "windows")'.dependencies]`
  (`windows` 0.58 with Foundation/Security/JobObjects/Threading/ToolHelp/Gdi/Dwm
  features, `winreg` 0.55) — copied from the fork with its rationale.
- [x] Ported `commands/new_files.rs` (cross-platform "New Files" detail window;
  the mac base already references the `new-files-detail` window) and registered it
  (`mod.rs`, `.manage(PendingNewFiles…)`, `generate_handler!`).
- [x] `tauri.windows.conf.json` overlay (auto-merged on Windows builds): Windows
  identifier `ai.indigo.hq-sync-win`, `msi`/`nsis` targets, WiX upgrade code
  `8E5B6C7F-…`, NSIS current-user installer, WebView2 embed bootstrapper, and the
  Windows updater pubkey + `hq-sync-win` endpoint (preserved for in-place updates).
- [x] `windows-check.yml` CI verification job.

## Remaining: graft Windows code behind `cfg(windows)` (CI-verified)

For each file, take the fork's `cfg(windows)` implementation, integrate it into the
mac base's newer structure, and gate the existing mac code as `cfg(target_os = "macos")`
(or `cfg(unix)`) so Windows excludes it.

- [ ] **`commands/process.rs`** — Windows Job Object + ToolHelp process-tree spawn/cancel
  (fork) vs `nix` process-group signals (mac). Gate `nix` usage under `cfg(unix)`.
- [ ] **`commands/autostart.rs`** — HKCU `…\Run` key via `winreg` (fork) vs macOS
  LaunchAgent. Gate each behind its platform.
- [ ] **`util/paths.rs`** — Windows path resolution: Git Bash discovery, `%LOCALAPPDATA%\IndigoHQ\toolchain`
  (with legacy `Indigo HQ` fallback), long-path handling. Gate mac path logic.
- [ ] **`tray.rs`** — Windows tray anchoring: `GetMonitorInfoW`/`MonitorFromWindow`
  work-area fallback + `DwmSetWindowAttribute` corner preference (fork) vs macOS
  NSStatusItem. Gate mac positioning.
- [ ] **`commands/notifications.rs`** — Windows Action Center toasts via
  `tauri-plugin-notification` vs macOS `UNUserNotificationCenter` (objc2/block2). Gate mac.
- [ ] **`commands/daemon.rs`** — reconcile Windows process/daemon handling.
- [ ] **`main.rs`** — Windows setup (`CREATE_NO_WINDOW`, WebView2, Mica/vibrancy)
  vs macOS setup (`macos-private-api`, the Swift `hq-tray-helper`). Gate mac setup.

## Remaining: gate mac-only code so Windows compiles

- [ ] Gate every mac-only module/usage behind `cfg(target_os = "macos")` so it is not
  compiled on Windows: `commands/folder_picker.rs` (objc2), `commands/permissions.rs`
  (objc2/block2), `commands/meetings.rs` + `commands/share_notify.rs` (mac-notification-sys),
  `glass.rs` (objc2-core-foundation), `util/recordings_ledger.rs`, `commands/un_notify.rs`,
  and the Recall-mac integration. Use the fork's gating as the reference.
- [ ] **`build.rs`** — compile the Swift `hq-tray-helper` only under
  `cfg(target_os = "macos")`; Windows build.rs must not invoke `swiftc`.
- [ ] **Per-platform bundle resources** — the base `tauri.conf.json` lists mac-only
  resources (`helper/hq-tray-helper`, the macOS Recall binary) unconditionally; move
  those to a `tauri.macos.conf.json` overlay so the Windows bundle does not try to
  ship mac binaries. Add the Windows Recall sidecar binary (or gate Recall off for
  Windows x64 until the sidecar ARM/x64 path is proven — see MIGRATION.md §6).

## Remaining: reconcile, expose, and confirm

- [ ] **`commands/rescue_script_cache.rs`** (fork-only) — a cross-platform update-flow
  fallback the **newer mac base does not use** (0 references). Decide: most likely
  obsolete (mac's update flow superseded it); port only if mac's flow still needs it.
- [ ] **Operator surfaces on Windows** (owner decision) — confirm `library_local`,
  `marketplace`, `messages`, `projects_local` compile cross-platform and are exposed
  on Windows; gate by feature/account, not OS.
- [ ] **Frontend** — add the `new-files-detail` Svelte route/handler; reconcile the
  fork-only `src/packages` surface; Windows window chrome (Mica, controls).
- [ ] **Command contract is one union** — generate the command/event manifest on both
  OSes and confirm no unintended platform drift (feeds the `command-contract` CI gate).
- [ ] **Green the CI job** — once `cargo check --target x86_64-pc-windows-msvc` passes,
  enable the commented-out clippy + `cargo test` steps in `windows-check.yml` and make
  it a required check.

## Done criteria (from MIGRATION.md)

Unified app builds/checks on **Windows x64** and macOS still passes; the command
contract is one union; `imports/hq-sync-win` can then be deleted once every accepted
delta is represented in `apps/sync`.
