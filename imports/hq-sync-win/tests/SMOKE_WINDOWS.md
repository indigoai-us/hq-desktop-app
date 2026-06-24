# SMOKE TEST — Windows 11 (V1 dogfood)

Goal: a Win 11 user with no terminal can download a signed MSI, install, autostart at login, sync to S3, and manage sync state from the tray. This checklist is the V1 acceptance gate.

**Target host:** Win 11 ARM64 (Stefan's Surface Pro 11) is primary. Win 11 x64 VM is the secondary target — repeat the same steps if hardware available, otherwise document the gap and rely on CI's x64 build.

**Pre-flight:**

- [ ] `hq-installer-win` V1 already shipped + dogfood cohort has it installed (i.e. `%LOCALAPPDATA%\IndigoHQ\toolchain\bin\hq.exe` exists; legacy `%LOCALAPPDATA%\Indigo HQ\toolchain\bin\hq.exe` is also resolved for backward compat). If the installer hasn't shipped, this smoke test pre-stages `hq.exe` by manual copy.
- [ ] User has Cognito credentials (HQ account at `getindigo.ai`).
- [ ] User has a valid HQ folder somewhere on disk (or accepts the auto-create at `%USERPROFILE%\HQ`).

---

## 1. Install

- [ ] Download `hq-sync-win_<version>_x64_en-US.msi` (or ARM64 equivalent) from the GitHub release at <https://github.com/indigoai-us/hq-sync-win/releases>.
- [ ] Double-click the MSI to launch.
- [ ] **Expected:** no console flash, no UAC prompt (user-scoped install per `tauri.conf.json` `bundle.windows.nsis.installMode: currentUser`).
- [ ] **Expected:** installer completes in <15 sec on a typical SSD.
- [ ] **Expected:** `HQ Sync` appears in `Settings → Apps → Installed apps` with:
  - Publisher: `Indigo AI`
  - Version: matches the release tag
  - Install size: <50 MB
  - Icon: HQ logo (not generic application icon)

Record: install time `___ sec` / total disk usage `___ MB`.

## 2. First launch

- [ ] **Expected:** within 5 sec of install completion, the tray icon appears in the notification area (no need to manually run from Start Menu — the MSI launches the app post-install).
- [ ] Tray icon shows the **Idle** state visually.
- [ ] Hover the tray icon: tooltip reads `HQ Sync — Idle`.

If the tray icon is hidden in the overflow chevron (common on Win 11), drag it onto the always-visible row for the rest of the smoke test.

## 3. Popover open + vibrancy

- [ ] Left-click the tray icon.
- [ ] **Expected:** a 320×400 popover appears above-right of the tray icon (right edge of popover aligns with right edge of tray icon, bottom of popover sits ~8px above the taskbar).
- [ ] **Expected:** popover has **Mica blur** (Win 11) — you can see the desktop wallpaper colors bleeding through the panel. On Win 10 dogfood machines, Acrylic blur is the fallback.
- [ ] **Expected:** popover shows the welcome / setup UI (sign in prompt for first-launch users; workspace list for returning users).

If Mica didn't apply, check `%USERPROFILE%\.hq\logs\hq-sync.log` — `[ui] apply_mica:` / `apply_acrylic:` line confirms which path ran.

## 4. Hide-on-blur

- [ ] With the popover open, click anywhere outside it (e.g. desktop).
- [ ] **Expected:** popover hides immediately. State (DOM, scroll position, sign-in progress) is preserved.
- [ ] Re-open via tray click — same state, no reload flash.

## 5. Folder picker (Change HQ Folder)

- [ ] Open popover, navigate to Settings → Change HQ Folder.
- [ ] **Expected:** a native Windows folder dialog opens (IFileOpenDialog — breadcrumb nav, supports network paths). Looks identical to the Explorer "Open folder" dialog.
- [ ] **Expected:** popover **stays visible behind the picker** (does not auto-hide while the picker has focus).
- [ ] Pick `C:\Users\<you>\hq` (or any valid HQ folder), Click "Select Folder".
- [ ] **Expected:** popover updates to show the new path.
- [ ] Click Cancel on a fresh picker session.
- [ ] **Expected:** popover stays unchanged.

## 6. Cognito sign-in

- [ ] Click Sign In in the popover.
- [ ] **Expected:** default browser opens to the Cognito Hosted UI.
- [ ] Complete sign-in. Browser redirects to the custom protocol (`hqsync://`) handler.
- [ ] **Expected:** popover updates to show signed-in state. Tokens stored in `%USERPROFILE%\.hq\cognito-tokens.json` (DPAPI-encrypted per-user).

Record: full sign-in round-trip time `___ sec`.

## 7. First sync

- [ ] In the popover, click `Sync Now`.
- [ ] **Expected:** tray icon transitions to the **Syncing** visual.
- [ ] **Expected:** popover shows per-file progress as the sync uploads to S3.
- [ ] **Expected:** sync completes within ~30 sec for an empty/small HQ. Tray icon returns to **Idle**.
- [ ] Verify in AWS S3 console (or `aws s3 ls s3://<bucket>/<userprefix>/`): the expected paths exist.

## 8. Right-click context menu

- [ ] Right-click the tray icon.
- [ ] **Expected:** native Windows context menu appears with: `HQ Sync v<version>` (dimmed), separator, `Sync Now`, separator, `Settings`, `Quit`.
- [ ] Click `Sync Now`.
- [ ] **Expected:** triggers a sync (verified by tray icon **Syncing** state + log entry in `%USERPROFILE%\.hq\logs\hq-sync.log`).
- [ ] Click `Settings`.
- [ ] **Expected:** popover opens to the settings pane.

## 9. Autostart

- [ ] In Settings, toggle **Start at Login: ON** (default; verify it's already on).
- [ ] Verify the Registry value exists:
  ```powershell
  reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v HQSync
  ```
- [ ] **Expected:** output shows `HQSync   REG_SZ   "<path to HQ Sync.exe>"`.
- [ ] Log out of the Windows user account.
- [ ] Log back in.
- [ ] **Expected:** within 10 sec of login, tray icon reappears without user action.
- [ ] Verify in Task Manager → Startup tab: `HQSync` listed with status "Enabled", impact "Low".

## 10. Autostart opt-out

- [ ] Toggle **Start at Login: OFF** in Settings.
- [ ] Verify:
  ```powershell
  reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v HQSync
  # Expected: ERROR: The system was unable to find the specified registry key or value.
  ```
- [ ] Log out + back in.
- [ ] **Expected:** tray icon does NOT auto-appear.
- [ ] Manually launch HQ Sync from Start Menu.
- [ ] Re-toggle **Start at Login: ON** for the rest of the smoke test.

## 11. Quit

- [ ] Right-click tray → `Quit`.
- [ ] **Expected:** tray icon disappears.
- [ ] Verify no orphan processes:
  ```powershell
  Get-Process | Where-Object { $_.ProcessName -like "*HQ Sync*" -or $_.ProcessName -like "*hq-sync*" }
  ```
- [ ] **Expected:** empty result. (US-004's Job Object KILL_ON_JOB_CLOSE ensures any spawned `hq.exe`/`node.exe` children die with the parent.)

## 12. Uninstall

- [ ] Open `Settings → Apps → Installed apps`.
- [ ] Click `HQ Sync` → `Uninstall`.
- [ ] **Expected:** uninstaller completes in <15 sec without UAC.
- [ ] Verify:
  - [ ] `HQ Sync` no longer in Installed apps
  - [ ] Tray icon gone (already, from step 11)
  - [ ] Run key removed: `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v HQSync` returns `ERROR_FILE_NOT_FOUND`
  - [ ] `%USERPROFILE%\.hq\` directory still exists (user-scoped data preserved; reinstall keeps prefs)
  - [ ] HQ folder (e.g. `C:\Users\<you>\hq`) untouched (user content preserved)

## 13. (Bonus) x64 VM smoke

If a Windows 11 x64 VM is available (Parallels, Hyper-V, VMware), repeat steps 1–12 with the x64 MSI. Otherwise document the gap and rely on CI's x64 build artifact.

Record: x64 smoke `[ ] pass / [ ] skipped (CI-built artifact installed but not run-tested)`.

---

## Sign-off

| Step | Win 11 ARM64 | Win 11 x64 |
|------|--------------|------------|
| 1. Install | ☐ | ☐ |
| 2. First launch | ☐ | ☐ |
| 3. Popover + vibrancy | ☐ | ☐ |
| 4. Hide-on-blur | ☐ | ☐ |
| 5. Folder picker | ☐ | ☐ |
| 6. Cognito sign-in | ☐ | ☐ |
| 7. First sync | ☐ | ☐ |
| 8. Right-click menu | ☐ | ☐ |
| 9. Autostart | ☐ | ☐ |
| 10. Autostart opt-out | ☐ | ☐ |
| 11. Quit | ☐ | ☐ |
| 12. Uninstall | ☐ | ☐ |

Tester: `____________________`
Date: `____________________`
Release tag: `v_______________`
Notes / issues: `____________________`
