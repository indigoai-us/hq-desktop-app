# HQ Desktop App — Consolidation Plan

**One application that installs, then syncs.** Merging `hq-installer`, `hq-sync`, and
`hq-sync-win` into a single Tauri 2 app: it launches as an onboarding installer when HQ
is not yet set up, then becomes the long-lived HQ Sync menu-bar / tray agent. One binary,
one download, one version, one updater stream.

- **Status:** Proposed (planning artifact — repo scaffolded, no port work done yet)
- **Date:** 2026-06-24
- **Base:** `hq-sync` (Svelte 5). The React installer's wizard is ported into Svelte as
  first-run onboarding; `hq-sync-win` is folded back in for Windows.

## Locked owner decisions (2026-06-24)

1. **Single app, Svelte-only.** One Tauri binary + one merged Rust backend. The React
   installer UI is ported into the Svelte sync app as first-run onboarding; no React in
   the shipped bundle, no second app.
2. **One product, one version.** A single version string across the whole app.
3. **Updater domain:** `https://downloads.getindigo.ai/hq-desktop-app/{stable,beta,alpha}/latest.json`.
   The unified app enables the updater (the installer currently disables it).
4. **Windows shows the operator surfaces** (`library_local`, `marketplace`, `messages`,
   `projects_local`) — gated by feature/account, not by OS.
5. **Windows identifier → `ai.indigo.hq`** at a *deliberate later cutover*. For the first
   unified release the existing identifiers (`ai.indigo.hq-sync-menubar` on macOS,
   `ai.indigo.hq-sync-win` on Windows) are preserved so existing users keep in-place
   updates; the rename needs a one-time bridge build (identifier, AUMID, upgrade code,
   shortcuts, notification settings, updater key) — tracked below.

## Method

Produced by a Codex planning pass over deep per-repo maps, the precise on-disk fork delta
between the macOS and Windows sync repos, and the condensed source bundle. Every version
number, bundle identifier, signing-account name, and the Windows MSI upgrade code was
verified against the actual repository configs. An earlier two-app monorepo plan was
superseded by the single-app decision above.

---

## 1. Executive summary, goals and non-goals (single app, install-then-sync lifecycle)

HQ Desktop is one Tauri 2 app: one binary, one download, one version, one updater stream. The app launches first as an onboarding installer when HQ is not yet installed, then becomes the long-lived HQ Sync tray/menu-bar agent after setup completes. The React installer is not shipped as a second app; its flow and native setup logic are ported into the Svelte 5 sync app.

**Goals:**

- Use `apps/sync` as the base product and port installer onboarding into Svelte.
- Ship one app named `hq-desktop-app` / product-facing `HQ Sync` or `HQ Desktop` as decided by product copy.
- Preserve macOS bundle identifier `ai.indigo.hq-sync-menubar`.
- Preserve Windows bundle identifier `ai.indigo.hq-sync-win` for the first unified release.
- Enable the Tauri updater in the unified app.
- Publish updater manifests under `https://downloads.getindigo.ai/hq-desktop-app/{stable,beta,alpha}/latest.json`.
- Fold `hq-sync-win` into the base sync app using the exact fork delta.
- Make Windows expose `library_local`, `marketplace`, `messages`, and `projects_local`.

**Non-goals:**

- No separate `hq-installer` shipped app.
- No React frontend in the final bundle.
- No Linux release path in this migration.
- No Windows identifier migration to `ai.indigo.hq` in the first unified release.
- No macOS universal sync payload or Windows ARM64 sync payload until Recall packaging supports it honestly.

## 2. The install-then-sync state machine — how the app decides first-run/install vs installed/steady-state on launch; how it reuses sync's existing first_run; what "installed" means and where that state is persisted; the handoff into the menu-bar/tray; relaunch/login-item behavior

Classify launch before anything writes `machineId`, preserving the current `first_run.rs` rule. Add one higher-level lifecycle classifier above sync’s existing first-run classifier:

| State | Condition | UI | Background behavior |
|---|---|---|---|
| `NeedsInstall` | No completed install marker and no valid legacy installed shape | Svelte onboarding window | Do not start sync daemon, pollers, updater install prompts, or tray-only flows |
| `InstallResume` | Install marker says in-progress or failed step | Svelte setup-progress repair/resume screen | Same as `NeedsInstall` |
| `NeedsAuthForInstall` | HQ files/config can be prepared but no usable Cognito token | Svelte onboarding sign-in | No steady-state sync yet |
| `InstalledFirstRun` | Install completed, but sync `firstRunCompleted` is false and no prior `machineId` existed at classification | Finish onboarding, then first sync/welcome behavior | Start tray agent and first sync |
| `InstalledLegacyUpdate` | Valid existing sync install with `machineId`, but no new onboarding flags | Normal popover plus existing auto-sync notice logic | Preserve user settings |
| `SteadyState` | Install completed and `firstRunCompleted` true | Hidden menu-bar/tray app | Normal sync agent |

**Installed means all of this is true or recoverably true:**

- `~/.hq/menubar.json` has `installCompleted: true` and `hqPath`.
- `~/.hq/config.json` parses as the sync `HqConfig` shape: company/person/bucket/vault wiring and HQ folder path.
- The HQ root exists and contains the installed `hq-core` template/manifest shape expected by sync.
- Auth is not part of “installed.” Missing or expired auth routes to sign-in, not reinstall.

Persist lifecycle state in `~/.hq/menubar.json` using the existing untyped merge + atomic rename pattern from `first_run.rs` and `config::ensure_machine_id`. Add keys such as:

```json
{
  "installCompleted": true,
  "installVersion": "x.y.z",
  "installCompletedAt": "2026-...",
  "hqPath": "/Users/.../hq",
  "firstRunCompleted": true,
  "autoSyncNoticeShown": true
}
```

Keep `~/.hq/config.json` as the authoritative HQ/vault configuration file. Keep detailed setup resumability in an install manifest under `~/.hq/`, but the launch classifier should key off `menubar.json` plus valid config/root checks.

For legacy sync users, if `installCompleted` is absent but `machineId`, valid `config.json`, and an HQ path exist, classify as installed and backfill `installCompleted: true` with a migration marker. Do not force these users through the installer wizard.

Handoff is an internal mode switch. On onboarding completion, the app writes config/tokens/preferences, marks install complete, closes or hides the onboarding window, creates/enables the tray icon, calls the existing first-run completion command, starts realtime sync if enabled, and enters the normal popover route. `install_menubar` no longer downloads or launches a second app.

On login/relaunch, the unified binary starts hidden as the tray app if installed. If setup was interrupted, login launch shows the onboarding resume screen. Autostart is reconciled after install completion only, defaulting to enabled unless `startAtLogin: false` is already persisted.

## 3. Repo structure for ONE app — where the Svelte frontend and the single src-tauri live, crates/, and the temporary port-source imports/ (apps/installer and imports/hq-sync-win)

Target structure:

```text
hq-desktop-app/
  apps/
    hq-desktop-app/              # git-moved from apps/sync after absorption
      package.json
      src/                       # Svelte 5 frontend: onboarding + tray UI
      src-tauri/                 # the only shipped Tauri app
      sidecar/recall-sdk-bridge/
      tests/
      e2e/

  crates/
    hq-desktop-core/
    hq-auth-vault/
    hq-cloud/
    hq-process/
    hq-platform/
    hq-updater/
    hq-telemetry/
    hq-content/
    hq-installer-setup/
    hq-sync-core/

  imports/
    hq-installer-react/          # temporary port source, git-moved from apps/installer
    hq-sync-win/                 # temporary port source, current imports/hq-sync-win

  scripts/
  .github/workflows/
```

During migration, keep `apps/sync` as the active app until the port is stable, then `git mv apps/sync apps/hq-desktop-app`. Immediately remove `apps/installer` from pnpm/Cargo workspaces and treat it as read-only port source. Delete both port-source trees once their commands, UI, tests, assets, signing details, and Windows fork deltas are absorbed.

## 4. Backend command merge — a concrete table mapping each installer command module to its new home and whether it is an onboarding-phase command or steady-state; explicitly resolve the duplicate oauth and process modules and the install_menubar/menubar/launch/autostart overlaps; note what becomes obsolete (e.g. installer launching a separate menu-bar app is now just an internal mode switch)

| Installer module | New home | Phase | Decision |
|---|---|---:|---|
| `ai_tools` | `hq-installer-setup::ai_tools`, thin `commands::onboarding` wrapper | Onboarding, optional steady action | Keep final “open AI tool” behavior, but reuse sync’s existing app/open-link affordances where possible. |
| `checksums` | `hq-installer-setup::windows::checksums` plus `hq-content` helpers | Onboarding/repair | Keep Windows checksum rewrite/validation for template extraction and repair. |
| `deps` | `hq-installer-setup::deps` plus `hq-platform::toolchain` | Onboarding/repair | Own managed toolchain install, `winget`/Node/HQ CLI checks, and path normalization. |
| `device` | `hq-desktop-core::device` | Both | One device fingerprint implementation for telemetry/auth/setup. |
| `directory` | `hq-installer-setup::directory` | Onboarding | Own HQ path validation, default `~/hq`, empty/non-empty/import decisions. |
| `fs` | `hq-installer-setup::fs` | Onboarding/repair | Keep guarded file operations and template writes. |
| `git` | `hq-content::git_init` / `hq-installer-setup::git` | Onboarding | Keep initial repo/git metadata setup; steady-state git mirror remains sync-owned. |
| `install_menubar` | Obsolete; replaced by `desktop_lifecycle::enter_sync_mode` | Internal handoff | Delete external app install/download/launch behavior. |
| `keychain` | `hq-auth-vault::storage` | Both | Merge with sync token/vault storage. First release reads/writes existing `~/.hq/cognito-tokens.json` for compatibility and may mirror to Keychain/Credential Manager. |
| `launch` | Split between `desktop_lifecycle`, `ai_tools`, and existing sync app commands | Onboarding | Separate-app launch is obsolete; relaunch becomes internal mode switch. |
| `long_paths` | `hq-platform::windows::long_paths` | Onboarding/repair | Keep Windows long-path awareness checks and remediation guidance. |
| `menubar` | `hq-sync-core::config` / `desktop_lifecycle` | Both | Merge installer writes to `menubar.json` into sync’s existing untyped merge strategy. |
| `oauth` | `hq-auth-vault::oauth`, one `commands::oauth` wrapper | Both | Single PKCE loopback/Cognito implementation. No installer-vs-sync OAuth split. |
| `process` | `hq-process`, one `commands::process` wrapper | Both | Single streamed process API. macOS uses process groups; Windows uses Job Objects. |
| `staging` | `hq-content::staging` / `hq-installer-setup::templates` | Onboarding/repair | Keep hq-core/template staging, align with sync hq-core staging/update modules. |

Resolve overlaps this way:

- `install_menubar` is deleted as product behavior.
- `menubar` becomes config/state persistence, not a product boundary.
- `launch` no longer launches another app; it moves the same app from onboarding to tray mode.
- `autostart` remains a steady-state platform command and is called after install completes.
- `daemon` remains sync-runner lifecycle and is disabled until installed.
- `keychain`, `auth`, `cognito`, `oauth`, and `vault_client` become one auth/vault layer with app-specific command payloads only at the edge.

## 5. Frontend — porting the React installer wizard (Welcome to install to sign-in to setup-progress to done) into Svelte onboarding screens; routing/stores for onboarding vs menu-bar; what Svelte UI is reused from hq-sync; what is genuinely new

Port the React wizard into Svelte under the active sync app:

```text
src/onboarding/
  OnboardingApp.svelte
  Welcome.svelte
  InstallLocation.svelte
  SignIn.svelte
  SetupProgress.svelte
  Done.svelte
  AnotherInstanceRunning.svelte
  onboardingStore.svelte.ts
  setupProgress.ts
```

The route/store model should be lifecycle-driven, not URL-driven:

- `desktopLifecycleStore`: `checking | onboarding | installResume | signIn | setupProgress | done | tray`.
- `authStore`: wraps existing sync `get_auth_state`, `has_stored_token`, and OAuth commands.
- `setupStore`: streams dependency/template/git/cloud/indexing progress from backend events.
- `trayStore`: existing sync state for popover, sync progress, conflicts, packages, messages, operator surfaces.

Reuse from hq-sync:

- `SignInPrompt` logic and OAuth command contract, restyled for full-window onboarding.
- Existing popover, settings, packages, notifications, activity, conflict, sync, update, and operator UI.
- Existing Sentry setup, before-send scrubber, update banner, release-channel settings, and sync progress event handling.

Genuinely new Svelte work:

- Full-window onboarding shell.
- Installer setup progress timeline.
- Directory selection/import-existing UX.
- Install resume/repair state.
- Done/handoff screen.
- E2E mocks for the old React installer walkthrough, rewritten against Svelte.

The old `FirstRunWelcome.svelte` carousel should be folded into the onboarding welcome/done copy or deleted after the new wizard owns first-run education.

## 6. Cross-platform — fold hq-sync-win using the exact fork delta; bring installer Windows handling (long_paths, checksums, junction/symlink fallback) into the unified backend; the cfg(target_os) seam; macOS arm64 / Windows x64 reality from Recall

Use macOS `hq-sync` as the base and apply the precise fork delta:

| Delta | Unified decision |
|---|---|
| mac-only `library_local`, `marketplace`, `messages`, `projects_local` | Keep and make available on Windows. UI gating is by feature/account, not OS. |
| mac-only `un_notify` | Keep as macOS notification implementation detail. |
| win-only `new_files` | Port into unified sync. Use on Windows immediately; enable macOS when UI/product behavior is validated. |
| win-only `rescue_script_cache` | Port if still used by Windows repair/rescue; otherwise replace with shared hq-core rescue cache. |
| util `recordings_ledger` exists only on mac base | Bring forward with cfg-backed implementation or no-op Windows equivalent as Recall requires. |
| package scripts/deps differ | Standardize on Svelte 5 + pnpm, restore `svelte-check`, notification plugin, sidecar install, and tests. |
| Cargo deps differ | `block2`, `objc2`, `nix`, `mac-notification-sys` under macOS cfg; `windows`, `winreg` under Windows cfg. |
| identifiers differ | Preserve `ai.indigo.hq-sync-menubar` on macOS and `ai.indigo.hq-sync-win` on Windows for first unified release. |

Installer Windows handling moves into the unified backend:

- Enable/check long paths using `long_paths`.
- Keep checksum rewrite/validation for extracted templates.
- Prefer symlink when permitted; fall back to junctions for directories; fall back to copy with explicit telemetry when neither is possible.
- Keep managed toolchain paths under `%LOCALAPPDATA%\IndigoHQ\toolchain`, with legacy `%LOCALAPPDATA%\Indigo HQ\toolchain` fallback.
- Hide spawned CLI consoles via `CREATE_NO_WINDOW`.
- Preserve Job Object process-tree cancellation.

The cfg seam is internal, not a fork:

```text
crates/hq-platform/src/
  autostart/{macos,windows}.rs
  process/{macos,windows}.rs
  tray/{macos,windows}.rs
  notifications/{macos,windows}.rs
  permissions/{macos,windows}.rs
  window_effects/{macos,windows}.rs
  setup_windows/{long_paths,links}.rs
```

Release reality:

- macOS sync build is `aarch64-apple-darwin` first because Recall/GStreamer is arm64-only and non-fat.
- Windows sync build is `x86_64-pc-windows-msvc` first because the Recall sidecar ARM64 path is not proven.
- Do not label artifacts universal/ARM64 until the payload is actually native.

## 7. Shared Rust crates appropriate for ONE app (still worth extracting: auth/vault, cloud, process, platform seam, updater, telemetry, content/hq-core, installer-setup core)

These crates are internal boundaries inside one product, not preparation for multiple shipped apps:

| Crate | Owns |
|---|---|
| `hq-desktop-core` | Paths, config dirs, machine/device identity, release channel parsing, common errors, file merge helpers. |
| `hq-auth-vault` | Cognito Hosted UI, PKCE loopback, token exchange/refresh, token file compatibility, Keychain/Credential Manager, vault API auth. |
| `hq-cloud` | S3/STS clients, first push, personal provisioning, vault/cloud handoff, DM MQTT SigV4 helpers. |
| `hq-process` | Streamed process spawn/cancel, event payloads, POSIX process groups, Windows Job Objects. |
| `hq-platform` | `cfg(target_os)` implementations for tray, autostart, folder picker, notifications, permissions, window effects, Windows setup primitives. |
| `hq-updater` | Tauri updater adapter, version gate, channel endpoint selection, manifest structs, signature validation/generation scripts. |
| `hq-telemetry` | Sentry init, scrubbers, telemetry endpoint client, lifecycle/setup/sync event taxonomy. |
| `hq-content` | hq-core extraction/update/staging/drift, git mirror/init, package install/update, checksum-aware content operations. |
| `hq-installer-setup` | Onboarding orchestration: deps, directory, template extraction, initial sync/setup, personalization, indexing, repair/resume. |
| `hq-sync-core` | Steady-state sync domain: config, settings, daemon policy, status, conflicts, workspaces, packages, operator surfaces. |

Tauri command modules should stay thin in `apps/hq-desktop-app/src-tauri/src/commands`: validate IPC input, call a crate, emit events, serialize errors.

## 8. Build, release, signing (macOS notarization + Windows Azure Trusted Signing), updater and versioning for ONE app — note the installer currently DISABLES the updater while sync ENABLES it, so the unified app must enable the updater; one version; .sig regeneration after Authenticode

The unified app has one version across:

```text
apps/hq-desktop-app/package.json
apps/hq-desktop-app/src-tauri/Cargo.toml
apps/hq-desktop-app/src-tauri/tauri.conf.json
apps/hq-desktop-app/src-tauri/tauri.*.conf.json
Cargo.lock
```

Use tags `vX.Y.Z`, `vX.Y.Z-beta.N`, and `vX.Y.Z-alpha.N`. A release is not stable unless both supported platforms publish the same version.

The unified app must enable `tauri-plugin-updater` and `bundle.createUpdaterArtifacts = true`. The React installer currently disables updater artifacts; that setting must not survive the merge.

Updater endpoints:

```text
https://downloads.getindigo.ai/hq-desktop-app/stable/latest.json
https://downloads.getindigo.ai/hq-desktop-app/beta/latest.json
https://downloads.getindigo.ai/hq-desktop-app/alpha/latest.json
```

For the first unified release, platform overlays may keep separate updater public keys to preserve in-place updates:

- macOS: existing `hq-sync` updater key and identifier.
- Windows: existing `hq-sync-win` updater key and identifier.

macOS release:

- Build raw `aarch64-apple-darwin` `.app`.
- Repair Recall/GStreamer framework symlinks after Tauri resource copy.
- Sign inside-out with hardened runtime and required entitlements.
- Do not use `codesign --deep`.
- Notarize with Apple notarytool credentials.
- Staple the app.
- Build updater archive and DMG from the signed, notarized, stapled app.
- Sign updater archive after final bytes exist.

Windows release:

- Build `x86_64-pc-windows-msvc` MSI and NSIS plus updater artifacts.
- Preserve Windows upgrade code and `ai.indigo.hq-sync-win` for first unified release.
- Sign MSI and NSIS installer exe using Azure Trusted Signing:
  - endpoint `https://eus.codesigning.azure.net/`
  - account `indigosigning`
  - profile `indigo-codesign`
- Verify `Get-AuthenticodeSignature` is `Valid`.
- Regenerate Tauri updater `.sig` files after Authenticode signing, because signing mutates bytes.
- Generate `latest.json` only after signatures match final uploaded artifacts.

## 9. Unified CI for one app (jobs, matrix, gates)

Use one CI workflow for the one shipped app:

| Job | Matrix | Gate |
|---|---|---|
| `frontend` | ubuntu or macOS | pnpm install, Svelte typecheck, lint, unit tests, build. |
| `rust-macos` | macOS arm64 runner | fmt, check, clippy, tests for workspace/app. |
| `rust-windows` | `x86_64-pc-windows-msvc` | fmt, check, clippy, tests, Windows cfg compile. |
| `onboarding-e2e` | macOS plus Windows smoke | Mock Cognito/OAuth, run full Welcome → install → sign-in → setup-progress → done flow. |
| `installer-regression` | macOS + Windows | Preserve canonical tar/template extraction parity tests. |
| `sync-e2e` | macOS | Existing desktop-alt/popover scripted tests. |
| `windows-bundle-smoke` | Windows x64 | Unsigned MSI/NSIS build with updater disabled only for smoke config. |
| `command-contract` | macOS + Windows | Generate command/event manifest and fail on accidental platform drift. |
| `release-dry-run` | manual | Signed/notarized macOS and signed Windows artifacts uploaded as workflow artifacts; no publish. |
| `download-manifest-smoke` | scheduled + release | Fetch public manifests/download URLs, verify signatures/checksums. |

CI must prove that Windows compiles the operator surfaces `library_local`, `marketplace`, `messages`, and `projects_local`, even if feature flags hide them for some accounts.

## 10. Phased migration FROM the already-imported repo (apps/installer React + apps/sync Svelte base + imports/hq-sync-win) TO the single Svelte app — ordered phases, each with explicit verifiable done-criteria; include moving apps/installer to a port source and deleting it once absorbed; include enabling the updater

| Phase | Work | Done criteria |
|---|---|---|
| 0. Freeze inventory | Record current command lists, identifiers, upgrade codes, updater keys, signing secrets, public URLs, and installer flow. | Inventory committed; release owners confirm identifiers and updater keys. |
| 1. Declare one active app | Remove `apps/installer` from active workspaces; mark or move it to `imports/hq-installer-react`. Keep `apps/sync` as the only buildable app. | `pnpm install`, Svelte build, and sync Tauri check run without installer package participation. |
| 2. Add lifecycle classifier | Implement install-state classifier above existing `first_run`; add `installCompleted` persistence and legacy backfill. | Unit tests cover fresh install, interrupted install, legacy sync user, normal user, missing auth. |
| 3. Fold Windows sync fork | Port exact `hq-sync-win` deltas into base: Windows process/autostart/tray/vibrancy, `new_files`, `rescue_script_cache`, Windows deps/config. | Unified app builds/checks on Windows x64; macOS build still passes; command contract is one union. |
| 4. Extract core crates | Extract `hq-process`, `hq-platform`, `hq-auth-vault`, `hq-content`, and setup helpers behind thin command wrappers. | No command behavior changes; tests pass before/after each extraction. |
| 5. Absorb installer Rust commands | Port installer modules into `hq-installer-setup` and unified command wrappers. Delete obsolete external menubar install paths. | Backend can run mocked setup sequence end-to-end from Svelte/Tauri IPC. |
| 6. Port onboarding UI | Rebuild React wizard screens in Svelte and wire progress events. | Playwright/Vitest walkthrough covers welcome, install location, sign-in, setup progress, done. |
| 7. Handoff to tray mode | Implement `enter_sync_mode`: write state, enable autostart, create tray, start sync if configured, hide onboarding. | Fresh install ends in working tray app without launching another binary. |
| 8. Enable updater | Keep sync updater enabled, move endpoints to `downloads.getindigo.ai/hq-desktop-app`, generate manifests per channel. | Release dry-run emits updater artifacts and valid `latest.json`; installer disabled-updater setting is gone. |
| 9. Unify release CI | One release workflow builds macOS arm64 and Windows x64, signs/notarizes, regenerates Windows `.sig`, publishes manifests. | Dry-run release validates signatures, notarization, updater install, and old endpoint compatibility. |
| 10. Delete port sources | Remove `imports/hq-installer-react` and `imports/hq-sync-win` after all mapped files have tracked destinations or explicit discard notes. | `rg`/manifest audit shows no unmapped command/UI/release logic; shipped app still passes full CI. |
| 11. Public cutover | Update install pages and old download links to the unified artifacts. | Public page smoke downloads one app per OS and updater manifests remain live for old clients. |

## 11. Cutover of the public download/install page (hqforwork.com/install + getindigo.ai/install) to ONE download that installs then syncs, replacing the separate installer and menu-bar downloads; preserve old updater endpoints during migration

Both public install pages should advertise one product and one download per OS:

- macOS: unified HQ desktop app DMG/zip.
- Windows: unified HQ desktop app NSIS exe as primary, MSI as admin/managed alternative if needed.
- No separate “installer” and “menu-bar” downloads.

The downloaded app always performs the same lifecycle:

```text
Open app → install HQ if needed → sign in → setup HQ → hand off to tray/menu-bar sync
```

Preserve old updater endpoints during migration:

- Old macOS sync endpoint continues to serve a manifest that can update `ai.indigo.hq-sync-menubar` clients to the unified macOS build.
- Old Windows sync endpoint continues to serve a manifest that can update `ai.indigo.hq-sync-win` clients to the first unified Windows build.
- Old installer download URLs should redirect to the unified app only after fresh-install smoke tests pass. Keep pinned legacy artifacts available for rollback during the migration window.
- Do not move Windows users to `ai.indigo.hq` until a later bridge release explicitly handles identifier, AUMID, upgrade code, shortcuts, notification settings, and updater key migration.

## 12. Top risks and mitigations (table) and open questions for the owner

| Risk | Mitigation |
|---|---|
| Existing sync users get forced through install again | Classify legacy installed state from valid `config.json`, `hqPath`, and `machineId`; backfill `installCompleted`. |
| Windows in-place updates break | Preserve `ai.indigo.hq-sync-win`, upgrade code, Run key value, AUMID behavior, and updater key for first unified release. |
| Updater signatures invalid on Windows | Regenerate `.sig` after Azure Trusted Signing and verify manifest signatures against final artifacts. |
| Auth/token storage diverges | Make `hq-auth-vault` the only writer; preserve token-file compatibility for first release. |
| Installer setup starts steady-state sync too early | Gate daemon, pollers, sync, and update prompts behind installed state. |
| React port misses installer behavior | Maintain a command/screen parity checklist and keep installer E2E walkthrough until Svelte equivalent passes. |
| Recall packaging fails | Keep macOS arm64-only and Windows x64-only initially; preserve symlink repair and inside-out signing. |
| Windows symlink/junction behavior varies by machine | Implement symlink → junction → copy fallback with telemetry and repair UX. |
| Command fork drift returns | Add command-contract CI over macOS and Windows generated command/event manifests. |
| Public cutover leaves stale downloads | Treat install-page smoke and old endpoint manifests as release blockers. |

**Open questions for the owner:**

- Final product display name in OS surfaces: `HQ Sync` or `HQ Desktop`.
- Exact Windows identifier cutover plan and timing for `ai.indigo.hq`.
- Whether token storage should remain file-primary for one release or move keychain-primary immediately with file fallback.
- Whether legacy sync users with valid config but no `installCompleted` should see any onboarding copy, or only the existing auto-sync notice.
- Required rollback window for old installer/menu-bar download URLs and updater endpoints.
