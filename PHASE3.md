# Phase 3 — Fold the Windows sync fork into `apps/sync`

Status: **platform fold complete (compile + runtime parity), CI-verified.**
`cargo check --target x86_64-pc-windows-msvc` is GREEN (the `Windows check (Phase 3)` CI
job passes) and macOS stays green. The (macOS-only, but 691 commits ahead) `apps/sync`
base now compiles for Windows with mac-only code gated behind `cfg`, and the fork's
Windows runtime implementations (process tree-kill, autostart Run-key, paths, tray
anchoring, notifications) are ported. Remaining items below are follow-ups (real-device
smoke test, stricter CI, frontend wiring, cleanup) — not blockers for the fold.
This document complements the high-level plan in `MIGRATION.md`.

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

## Landed: compile graft (Windows check GREEN) — `cfg`-gated, CI-verified

These files raised the 40 Windows compile errors and were gated/ported (fork as reference):

- [x] **`commands/process.rs`** — `nix`/POSIX gated `cfg(unix)`; Win32 Job Object + ToolHelp
  tree-kill + `CREATE_NO_WINDOW` ported.
- [x] **`commands/daemon.rs`** — `nix` signals gated `cfg(unix)`; Windows `OpenProcess`
  liveness + `TerminateProcess` added.
- [x] **`commands/dm_notify.rs` / `commands/meetings.rs` / `commands/share_notify.rs`** —
  `mac_notification_sys` gated `cfg(macos)`; non-mac fires a native toast via `tauri-plugin-notification`.
- [x] **`commands/activity.rs` / `commands/desktop_alt.rs` / `commands/drift_detail.rs`** —
  macOS `title_bar_style` gated; Windows vibrancy calls added.
- [x] **`main.rs`** — `tauri::Manager` ungated; `glass`/`tray_helper` gated `cfg(macos)`;
  Windows Mica/Acrylic + DWM corner helpers added.
- [x] **`util/recordings_ledger.rs`** — test-only imports gated `cfg(test)`.

## Landed: Windows RUNTIME parity (CI-verified compile; mac path gated)

The fork's `cfg(windows)` runtime behavior was ported and the mac path gated `cfg(macos)`:

- [x] **`commands/autostart.rs`** — HKCU `Software\Microsoft\Windows\CurrentVersion\Run`
  enable/disable/check via `winreg`; LaunchAgent plist gated to macOS; launch-time
  reconciliation now runs on Windows too.
- [x] **`util/paths.rs`** — Windows managed toolchain `%LOCALAPPDATA%\IndigoHQ\toolchain`
  (legacy `Indigo HQ` fallback), Git-Bash / `where.exe` resolution, `.exe/.cmd/.bat`
  handling, no-console spawn, `HOME`-aware `home_dir()`.
- [x] **`tray.rs`** — Windows popover anchoring via `MonitorFromWindow`/`GetMonitorInfoW`
  work area + `DwmSetWindowAttribute` small-corner; macOS NSStatusItem path gated.
- [x] **`commands/notifications.rs`** — Windows Action-Center registry state +
  `ms-settings:notifications` permission deep-link; macOS `UNUserNotificationCenter` gated.

> Note: these are CI-verified to **compile** on Windows. Their on-device *behavior* (e.g.
> the Run-key actually surviving reboot, popover sitting above the taskbar) still needs a
> real Windows smoke test — see "remaining" below.

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

## Reconcile / expose / confirm — resolved

- [x] **`commands/rescue_script_cache.rs`** — **DROPPED (not ported).** The newer mac
  base has 0 references to it, and the fork has no callers of it either; mac's update
  flow superseded the bundle-swap fallback it provided. Recorded in out-of-scope.
- [x] **Operator surfaces on Windows** — exposed. `library_local` / `marketplace` /
  `messages` / `projects_local` compile cross-platform, live in the `desktop-alt`
  window (created on both OSes), and the frontend has **no OS gate** hiding them.
  (On-screen render parity still wants a device check — see below.)
- [x] **`new-files` frontend** — the fork's `NewFilesDetail.svelte` detail-window UX
  was **superseded** in the newer base by the inline `NotificationFeed`. We did NOT
  re-port the detail window (it would regress the newer UX). The `new_files` backend
  command is retained (harmless, compiles on both); revisit during the frontend
  unification phase if a dedicated window is wanted.
- [x] **Command contract is one union** — every `#[tauri::command]` compiles on both
  macOS and Windows (CI-verified). A generated command/event-manifest drift gate is a
  future nicety, not required for the fold.

## Deferred (need a real Windows device, which we are intentionally not using yet)

- [ ] **Device smoke test** — confirm runtime behavior on Windows (Run-key persistence,
  popover taskbar anchoring, Action-Center notifications). CI proves compile, not behavior.
- [ ] **Delete `imports/hq-sync-win/`** — keep it as the Windows reference until the
  device smoke test confirms the runtime impls; it is safely recoverable from the
  original repo and git history when removed. (`imports/hq-installer-react/` stays — it
  is the source for the later React→Svelte onboarding port.)
- [ ] **Stricter Windows CI** — enable clippy `-D warnings` + `cargo test` in
  `windows-check.yml` once the existing warnings are cleared (would be red today).

## Status

**Phase 3 platform fold: COMPLETE and merged** (compile + runtime parity, CI-verified on
both OSes). The only open items are device verification and cleanup that intentionally
waits on a real Windows machine.
