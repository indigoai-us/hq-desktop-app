# SMOKE TESTS — v0.6.3 parity surfaces (Windows 11)

Goal: confirm the surfaces added between **v0.4.0 and v0.6.3** work on Windows 11 before
shipping the v0.6.3 dogfood build. This is the **parity acceptance gate** for the
`hq-sync-win-parity-v0.6` project (stories US-001..US-013).

This checklist is **additive**. It assumes the V1 install/sync/tray/autostart gate in
[`tests/SMOKE_WINDOWS.md`](../tests/SMOKE_WINDOWS.md) already passes — run that first, then
run this for the new v0.6.3 surfaces. Full per-feature manual steps live in
[`tests/MANUAL_TESTING.md`](../tests/MANUAL_TESTING.md) (see the "v0.6.3 — Windows parity
surfaces" section). This file is the fast pre-release sweep.

**Target host:** Win 11 x64 is the shipping target (the Recall sidecar binary ships as
`recall-desktop-sdk-x86_64-pc-windows-msvc.exe` only). Win 11 ARM64 (Surface Pro 11) runs the
app under x64 emulation; record any ARM64-specific behavior in the sign-off table. A native
arm64 sidecar launcher is **deferred** (see US-012 in
[`specs/hq-sync-win-parity-v0.6-as-built.md`](../specs/hq-sync-win-parity-v0.6-as-built.md)).

**Conventions for this file:**

- Per-user state lives under `%USERPROFILE%\.hq\` (e.g. `%USERPROFILE%\.hq\logs\hq-sync.log`).
- Tray icon lives in the Windows **system tray** (notification area); if hidden in the
  overflow chevron, drag it onto the always-visible row for the duration of the sweep.
- Banners/toasts respect **Focus Assist** — turn Focus Assist OFF before notification checks.
- Where a surface is **flag-gated** or **Indigo-gated**, sign in with an `@getindigo.ai`
  account to exercise it; otherwise verify the gate hides it cleanly.
- All commands below are **PowerShell**.

---

## 0. Version gate (US-013)

- [ ] Open the popover → **Settings**. Confirm the **app version reads `0.6.3`** (sourced from
      `getVersion()` → Tauri/Cargo version).
- [ ] Right-click the tray icon. Confirm the dimmed header reads `HQ Sync v0.6.3`.
- [ ] Confirm the three version files agree (build provenance):
  ```powershell
  Select-String -Path package.json -Pattern '"version"'
  Select-String -Path src-tauri\Cargo.toml -Pattern '^version'
  Select-String -Path src-tauri\tauri.conf.json -Pattern '"version"'
  # Expected: all three read 0.6.3
  ```

---

## 1. Meeting detection + recording — Recall sidecar (US-001, US-002)

> The Recall Desktop SDK runs as a **sidecar process** (`recall-desktop-sdk-*.exe`) supervised
> by the Job Object daemon. Live meeting detection + recording requires Recall credentials
> (server-side `GET /v1/recall/credentials`) and an `@getindigo.ai` eligibility gate.

### 1a. Graceful degradation (no creds / no binary) — **always runnable**

- [ ] Launch HQ Sync on a host **without** Recall credentials (or with the sidecar binary
      absent from the bundle).
- [ ] Inspect the log:
  ```powershell
  Select-String -Path "$env:USERPROFILE\.hq\logs\hq-sync.log" -Pattern 'RECALL_SDK_UNAVAILABLE'
  ```
- [ ] **Expected:** `RECALL_SDK_UNAVAILABLE` is logged and the app **continues normally** (tray,
      popover, sync all work). No crash, no error dialog.

### 1b. Sidecar lifecycle (no orphan) — **always runnable**

- [ ] With the sidecar present and creds available, launch HQ Sync, then quit via tray → Quit.
- [ ] Confirm no orphaned sidecar:
  ```powershell
  Get-Process | Where-Object { $_.ProcessName -like "*recall-desktop-sdk*" }
  # Expected: empty (Job Object KILL_ON_JOB_CLOSE tore the sidecar down with the parent)
  ```

### 1c. Detection + recording (gated, needs creds + a live call)

- [ ] As an `@getindigo.ai` user with Recall creds, start a Zoom/Teams/Meet call.
- [ ] **Expected:** within ~1s of the SDK emitting `meeting:detected`, a meeting-detected banner
      appears and the meeting shows in the Meetings window.
- [ ] Click **Record** (on the banner or in the Meetings window). **Expected:** recording starts;
      the row reflects recording state.
- [ ] Confirm the **company attribution** dropdown: the default recording company is applied,
      and it is editable during recording (per-recording company picker + "Manage" label).
- [ ] End the call. **Expected:** recording **auto-stops** (meeting-closed → stopRecording).
- [ ] (Watchdog) If a recording sticks in `Stopping…`, **Expected:** it is force-stopped after
      the watchdog timeout (no indefinite hang).

---

## 2. Permissions wizard — Windows granted/not-required state (US-003)

> Windows has **no screen/microphone permission system**, so the macOS TCC/AVFoundation path
> is cfg-gated out. The wizard collapses to an **informational / granted** state.

- [ ] Open **Settings**. **Expected:** the **Meeting permissions** row renders (Indigo-gated)
      and shows a **granted / not-required** state — no "Grant access" call-to-action that
      would invoke a macOS API.
- [ ] Open the **Meeting permissions wizard** window. **Expected:** it renders a
      Windows-appropriate informational state (screen + microphone reported as
      granted/not-required), with **no** macOS permission prompts and **no** error.
- [ ] Confirm the wizard window has **Mica/Acrylic** vibrancy (desktop colors bleed through) and
      its CSS is scoped to its own window label (no bleed into the popover).

---

## 3. desktop-alt "Company OS" board — flag-gated (US-004, US-005)

> Gated behind `desktop_alt_enabled` (Indigo eligibility). **Scope note:** only the
> **Windows-bootable Company OS core + classic-surface parity** landed; the full upstream
> desktop-alt frontend tree (projects kanban, command palette, the desktop-alt sync/meetings
> PAGE tree) was **deferred** — see the as-built spec.

### 3a. Gate off (default / non-eligible) — **always runnable**

- [ ] As a **non-eligible** user (or with the flag off), open the app.
- [ ] **Expected:** desktop-alt is hidden; the **classic** surface (workspace list / sync /
      meetings) renders normally. No empty/black Company-OS window.

### 3b. Gate on (eligible)

- [ ] As an eligible `@getindigo.ai` user with `desktop_alt_enabled`, open the app.
- [ ] **Expected:** the **Company OS Board** renders with company-scoped **goals / projects /
      in-flight**. The desktop-alt **theme actually applies** on Windows (not unstyled).
- [ ] **Expected:** the Company summary **counts reflect real data** and do **not** stay stuck at
      zero (no zero-stuck refetch loop).
- [ ] Confirm the window **boots** on Windows (the `titleBarStyle` casing fix) — it does not fail
      to open or throw on the macOS-only title-bar enum.
- [ ] (Sync screen parity) **Expected:** workspaces use **classic ordering**, the personal
      workspace shows the **"Personal"** tag, and the **hover sync-mode toggle** (Windows
      control from v0.4.0) is preserved.

---

## 4. Notification-history window (US-006)

> A unified, **persistent** history of shares / DMs / updates / new-files that survives app
> restart. Stored under the Tauri app-data dir.

- [ ] Open the **notification-history** window (bell entry in the popover header).
- [ ] **Expected:** it lists prior DM / share / update / new-file entries; window has
      Mica/Acrylic vibrancy.
- [ ] With the window open, trigger a new share/DM/new-file. **Expected:** the new entry appears.
- [ ] **Quit and relaunch** HQ Sync, reopen the history window. **Expected:** prior-session
      entries **persist** (cross-session history, Phase 3).

---

## 5. Packages window (US-009)

> Manage installed/available HQ packs. Shelling out to `hq` requires the child PATH to resolve
> node's shebang on Windows (the v0.5.1 child-PATH fix via `paths::child_path` / Git Bash).

- [ ] Open the **Packages** window (Settings → Packages entry).
- [ ] **Expected:** installed HQ packs list; window has Mica/Acrylic vibrancy.
- [ ] Trigger a package action that shells out to `hq` (e.g. list/refresh). **Expected:** the node
      shebang resolves on Windows and the command runs (no `'node' is not recognized` / shebang
      failure). Confirm in the log:
  ```powershell
  Select-String -Path "$env:USERPROFILE\.hq\logs\hq-sync.log" -Pattern 'packages'
  ```

---

## 6. First-run onboarding (US-011)

> First-run welcome + calmer first sync + one-time auto-sync notice. First-run state is
> persisted so the welcome shows **once**.

- [ ] Reset first-run state (fresh install or clear the first-run marker under
      `%USERPROFILE%\.hq\`), then launch HQ Sync.
- [ ] **Expected:** the **first-run welcome** carousel shows.
- [ ] **Expected:** the **first sync is calmer** (reduced per-file noise) and the **auto-sync
      notice** is presented once.
- [ ] **Relaunch** the app. **Expected:** the welcome does **not** show again.

---

## 7. Banner refinements + notifications GA (US-007)

> HQ-branded **glass** banners (Windows Mica/Acrylic path, not macOS NSVisualEffectView),
> content-fit height, no draining lifebar, decluttered popover header, and DM/Share toggles
> opened to **all** users (no `@getindigo.ai` gate).

- [ ] Trigger a share or meeting event. **Expected:** the banner uses **Windows glass
      vibrancy**, **fits its content height** (no fixed 104px padding gap), and has **no draining
      lifebar**.
- [ ] On a share banner, confirm the **share cursor is not stuck** (pointer resets correctly).
- [ ] Inspect the **popover header**: **single** settings entry, **monochrome** icons (incl. the
      monochrome meeting icon), no clutter.
- [ ] Sign in with a **non-`@getindigo.ai`** account → open Settings → **Notifications**.
      **Expected:** the **Share notifications** and **Direct messages** toggles are **visible**
      and functional (GA — no eligibility gate), and there is exactly **one** Notifications
      section header.

---

## 8. DM conversation thread (US-008)

> The DM window shows the **full conversation thread**, not just the single triggering DM.

- [ ] Receive a DM from a sender with prior messages; open the **DM window** (click the banner
      body).
- [ ] **Expected:** the **full thread** renders in order (not just the latest message).
- [ ] Type a reply and **Send** (or `Ctrl+Enter`). **Expected:** the message sends, the textarea
      clears, and the reply appears in the thread. Confirm:
  ```powershell
  Select-String -Path "$env:USERPROFILE\.hq\logs\hq-sync.log" -Pattern 'DM_NOTIFY_SEND_OK'
  ```

---

## Sign-off

| # | Surface | Win 11 x64 | Win 11 ARM64 (x64-emulated) |
|---|---------|-----------|------------------------------|
| 0 | Version gate reads 0.6.3 | ☐ | ☐ |
| 1a | Recall graceful degradation | ☐ | ☐ |
| 1b | Recall sidecar no-orphan | ☐ | ☐ |
| 1c | Recall detect + record (gated) | ☐ | ☐ |
| 2 | Permissions wizard (granted/not-required) | ☐ | ☐ |
| 3a | desktop-alt gate OFF → classic | ☐ | ☐ |
| 3b | desktop-alt Company OS board (gated) | ☐ | ☐ |
| 4 | Notification-history window (persists) | ☐ | ☐ |
| 5 | Packages window | ☐ | ☐ |
| 6 | First-run onboarding | ☐ | ☐ |
| 7 | Banner refinements + notifications GA | ☐ | ☐ |
| 8 | DM conversation thread | ☐ | ☐ |

Tester: `____________________`
Date: `____________________`
Release tag: `v0.6.3`
Notes / issues: `____________________`
