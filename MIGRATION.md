# HQ Desktop App — Consolidation Plan

Merging `hq-installer`, `hq-sync`, and `hq-sync-win` into a single monorepo, `indigoai-us/hq-desktop-app`.

- **Status:** Proposed (planning artifact — no code changes made)
- **Date:** 2026-06-24
- **Scope:** Three repos. `hq-installer` (React 19, already cross-platform) co-locates; `hq-sync` (Svelte 5, macOS) and `hq-sync-win` (Svelte 5, Windows) — a drifted fork of the same app — are reunited into one cross-platform sync app. `hq-desktop` and `hq-installer-win` are explicitly out of scope.
- **Method:** Produced by a multi-stage Codex workflow — independent per-repo maps, then two competing architectures (JS-monorepo-first vs Rust-workspace-first), then a reconciled synthesis — cross-checked against a separate holistic Codex pass and a precise on-disk fork delta. Every version number, bundle identifier, signing-account name, dev port, and the Windows MSI upgrade code below was verified against the actual repository configs before this document was finalized.

---

## 1. Executive summary, goals, and non-goals

Create `indigoai-us/hq-desktop-app` as a two-app monorepo:

- `apps/installer`: the existing React 19 + Tauri 2 cross-platform installer.
- `apps/sync`: one reunified Svelte 5 + Tauri 2 cross-platform sync app replacing both `hq-sync` and `hq-sync-win`.

The monorepo uses pnpm workspaces and Turborepo for JavaScript orchestration, plus one root Cargo workspace for Rust app crates and shared crates. `hq-sync-win` is an import and migration source only, not a long-lived third app.

The strongest reconciled calls are:

- Use a root `Cargo.toml`, not a nested `crates/Cargo.toml`, because Tauri app crates and shared crates need one root lockfile, workspace graph, and release validation surface.
- Use Turborepo for JS tasks despite the Rust-first proposal, because it gives affected React/Svelte caching without replacing Cargo as the Rust build system.
- Use `git-filter-repo` over raw subtree import, because permanent subdirectory history and tag renaming are cleaner and easier to audit.
- Keep React and Svelte app-local; share only framework-neutral TypeScript and Rust.
- Use independent app versions, but one locked sync version across macOS and Windows after reunion.

Goals:

- Reunite sync into one product and one source tree.
- Preserve installed app identity and updater continuity for existing macOS and Windows sync users.
- Share CI, signing, release tooling, updater manifest generation, version checks, telemetry conventions, and Rust infrastructure.
- Keep app command surfaces stable while moving implementation into shared crates.
- Preserve useful git history from all three repos.

Non-goals for the first migration release:

- No Linux support.
- No long-lived `apps/sync-win`.
- No shared React/Svelte component library.
- No updater key rotation.
- No installer self-updater rollout; the installer joins the shared updater tooling, but runtime self-update stays disabled until the monorepo migration is stable.

## 2. Current state of the three repos (a compact table)

| Repo | App role | Stack | Current version | Current platforms | Identity | Updater | Release/signing notes |
|---|---|---|---:|---|---|---|---|
| `hq-installer` | Guided HQ installer and bootstrapper | React 19, Vite 6, Tauri 2, pnpm 9 | `0.12.0` | macOS universal, Windows x64, Windows ARM64 | `ai.indigo.hq-installer` | Disabled in config; docs/scripts are ahead of implementation | macOS uses `tauri-action@v0` with Developer ID notarization; Windows uses Azure Trusted Signing for MSI/NSIS |
| `hq-sync` | macOS menu bar sync app | Svelte 5, Vite 6, Tauri 2, pnpm 10 in release | `0.7.24` | macOS arm64 in practice because Recall SDK is arm64-only | `ai.indigo.hq-sync-menubar` | Enabled, GitHub `hq-sync` `latest.json`, macOS updater key | Manual inside-out signing, GStreamer symlink repair, notarization, DMG/updater generation |
| `hq-sync-win` | Windows tray sync fork | Svelte 5, Vite 6, Tauri 2, npm | `0.6.4` | Windows x64 release path; Windows ARM64 blocked by Recall sidecar launcher | `ai.indigo.hq-sync-win` | Enabled, GitHub `hq-sync-win` `latest.json`, Windows updater key | Azure Trusted Signing for MSI/NSIS; updater `.sig` must be regenerated after Authenticode signing |

## 3. Recommended architecture, with a concrete directory tree

The repo has one root JavaScript workspace and one root Cargo workspace. The only shipped desktop apps are installer and sync.

```text
hq-desktop-app/
  README.md
  RELEASE.md
  MIGRATION.md
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  eslint.config.mjs
  rust-toolchain.toml
  Cargo.toml
  Cargo.lock
  versions.toml
  .cargo/
    config.toml
  .github/
    workflows/
      ci.yml
      release.yml
      nightly-regression.yml
      sync-contract.yml
      download-page-smoke.yml
    actions/
      setup-node-pnpm/
      setup-rust-tauri/
      apple-sign-notarize/
      azure-trusted-signing/
  apps/
    installer/
      package.json
      vite.config.ts
      tsconfig.json
      index.html
      src/
      templates/
      tests/
      scripts/
      src-tauri/
        Cargo.toml
        build.rs
        tauri.conf.json
        tauri.smoke.conf.json
        capabilities/
        icons/
        src/
          main.rs
          lib.rs
          commands/
    sync/
      package.json
      svelte.config.js
      vite.config.ts
      vite.preview.config.ts
      tsconfig.json
      index.html
      desktop-alt.html
      src/
      tests/
      sidecar/
        recall-sdk-bridge/
      scripts/
      src-tauri/
        Cargo.toml
        build.rs
        tauri.conf.json
        tauri.macos.conf.json
        tauri.windows.conf.json
        tauri.release.conf.json
        tauri.dogfood.conf.json
        Info.plist
        Entitlements.plist
        capabilities/
        icons/
        binaries/
        src/
          main.rs
          lib.rs
          commands/
          events.rs
          sentry_scrub.rs
          tray.rs
          updater.rs
          util/
  crates/
    hq-desktop-core/
    hq-ipc/
    hq-auth-vault/
    hq-cloud/
    hq-process/
    hq-platform/
    hq-notifications/
    hq-meetings-recall/
    hq-cli/
    hq-content/
    hq-updater/
    hq-telemetry/
    hq-sync-core/
    hq-installer-core/
  packages/
    config/
    tauri-ipc/
    auth/
    cloud/
    telemetry/
    release/
    design-tokens/
    testing/
    tsconfig/
    eslint-config/
  imports/
    hq-sync-win/
      README.md
  tooling/
    scripts/
      version-app.ts
      assert-versions.ts
      generate-latest-json.ts
      publish-updater-manifest.ts
      verify-downloads.ts
      diff-sync-forks.ts
  docs/
    architecture.md
    signing.md
    updater.md
    release.md
    sync-fork-reunification.md
```

`imports/hq-sync-win` is temporary. It exists only between history import and fork reconciliation, then is deleted after every accepted Windows delta is represented in `apps/sync`.

## 4. Shared Rust crate boundaries (name each crate and what moves into it)

| Crate | Boundary and source movement |
|---|---|
| `hq-desktop-core` | Product-neutral primitives: paths, release channels, feature gates, client info, journals, ignore rules, logfile helpers, common errors. Move sync `util/client_info`, `feature_gate`, `ignore`, `journal`, `logfile`, `paths`, `release_channel`, shared installer device/path helpers where not app-specific. |
| `hq-ipc` | Shared serde payloads, command result/error types, Tauri event names, generated TypeScript bindings. App crates still own command registration. |
| `hq-auth-vault` | Cognito Hosted UI, OAuth loopback, token serialization, keychain/Credential Manager storage, auth handoff types. Move installer `oauth`, `keychain`; sync `auth`, `cognito`, `oauth`; token-store portions of `vault_client`. |
| `hq-cloud` | HQ API, Vault HTTP client, S3/STS helpers, AWS SigV4 MQTT setup. Move sync `vault_client`, `first_push`, `personal`, `provision`, `dm_mqtt`; expose installer-safe subsets. |
| `hq-process` | Process spawn, streaming output, cancellation, tree kill. Move installer `process`; sync `process`; macOS `nix` signal handling; Windows Job Object and ToolHelp handling from `hq-sync-win`. |
| `hq-platform` | All `cfg(target_os)` OS seams: autostart, folder picker, tray anchoring, window vibrancy, app icon/AUMID/LoginItem, permission shims, platform paths. Move sync `autostart`, `folder_picker`, tray/window-effect code, mac AppKit/Objective-C code, Windows DWM/Mica/Registry code. |
| `hq-notifications` | Notification state, native delivery facade, history, banners, share/DM/unread actions. Move sync `notifications`, `notification_history`, `banner`, `share_notify`, `dm_notify`, and mac-only `un_notify`; keep native action behavior in platform backends. |
| `hq-meetings-recall` | Recall SDK bridge contract, meeting detection, active recordings, ledgers, recording permissions. Move sync `meetings`, `recall_sdk`, `meeting_ledger`, and mac-only `recordings_ledger` plus `recordings_ledger_test`. |
| `hq-cli` | Locate and run `hq`, provision/status/sync parsing, CLI update checks. Move sync `hq_cli_update`, `run_cli_provision`, `status`, `sync`, `sync_mode`, `conflicts`, relevant `hq_resolver` logic. |
| `hq-content` | HQ core/package state, staging, drift, git mirror, rescue cache. Move sync `hq_core_state`, `hq_core_update`, `hq_core_staging`, `hq_core_drift`, `git_mirror`, `packages`, Windows `rescue_script_cache`, installer `staging` where reusable. |
| `hq-updater` | Tauri updater adapter, channel resolution, `latest.json` schema, manifest generation/validation, signature ordering checks. Move sync `updater.rs`, release-channel resolver use, installer updater scripts into one implementation. |
| `hq-telemetry` | Sentry initialization, scrubbers, telemetry opt-in state, app/platform/channel tags. Move sync `sentry_scrub.rs`, sync `telemetry`, installer telemetry/Sentry setup. |
| `hq-sync-core` | Sync product domain orchestration: `activity`, `config`, `daemon`, `desktop_alt`, `drift_detail`, `first_run`, `prewarm`, `settings`, `version_gate`, `workspaces`, operator surfaces, and cross-platform command-neutral sync state. |
| `hq-installer-core` | Installer product domain: `ai_tools`, `deps`, `directory`, `fs`, `git`, `install_menubar`, `launch`, `menubar`, Windows `checksums`, Windows `long_paths`, installer flow orchestration. |

Tauri app crates become thin shells: parse IPC inputs, call shared crates, emit Tauri events, own windows/plugins/capabilities.

## 5. Reuniting hq-sync + hq-sync-win into one cross-platform sync app - use the exact fork delta; describe the cfg(target_os) seam, which divergent modules move where, and how to preserve updater continuity given the identifier/version divergence

Use `hq-sync` as the base because it is newer and broader: macOS is `0.7.24`; Windows fork is `0.6.4`. Port Windows deltas into `apps/sync`; do not keep a forked app directory.

The fork delta to preserve is exact:

- There are 44 shared command modules.
- Mac-only command modules are `library_local`, `marketplace`, `messages`, `projects_local`, `un_notify`.
- Windows-only command modules are `new_files`, `rescue_script_cache`.
- In `src-tauri/src/util`, mac adds `recordings_ledger` and `recordings_ledger_test`.
- Cargo platform split is mac `nix`/`block2` versus Windows `windows`/`winreg`.
- Bundle identifiers and versions diverged: macOS is `ai.indigo.hq-sync-menubar` at `0.7.24`; Windows is `ai.indigo.hq-sync-win` at `0.6.4`.

The seam is `#[cfg(target_os = "...")]` inside shared crates, not separate app trees. Keep one command contract and compile command wrappers on both OSes. Platform-specific behavior lives behind backends such as:

```text
crates/hq-platform/src/
  autostart/
    mod.rs
    macos.rs
    windows.rs
  tray/
    mod.rs
    macos.rs
    windows.rs
  window_effects/
    mod.rs
    macos.rs
    windows.rs
  folder_picker/
    mod.rs
    macos.rs
    windows.rs
  permissions/
    mod.rs
    macos.rs
    windows.rs
```

Divergent module decisions:

| Delta | New home | Decision |
|---|---|---|
| `library_local` | `hq-sync-core::operator::library_local` | Keep. Compile shared logic where possible; gate UI by operator eligibility and platform readiness. |
| `marketplace` | `hq-sync-core::operator::marketplace` | Keep. Treat as product surface, not mac-only architecture. |
| `messages` | `hq-sync-core::operator::messages` | Keep. Hide on Windows until frontend and backend parity are tested. |
| `projects_local` | `hq-sync-core::operator::projects_local` | Keep. Move platform file/path details into `hq-platform`. |
| `un_notify` | `hq-notifications::macos::un_notify` | Keep as macOS native notification action behavior; expose through shared notification facade. |
| `new_files` | `hq-sync-core::new_files` plus Windows backend | Port from Windows fork. Svelte calls it only on Windows in v1; mac returns typed unsupported or empty state until behavior is defined. |
| `rescue_script_cache` | `hq-content::rescue_cache` | Port from Windows fork and make it reusable for staged HQ-core rescue flows. |
| `recordings_ledger` | `hq-meetings-recall::recordings_ledger` | Preserve mac-only ledger and tests; compile behind macOS or Recall feature gates. |

Tauri config uses one common base plus platform overlays:

- Common `tauri.conf.json`: product name, shared windows where valid, plugins, capabilities, `createUpdaterArtifacts` default, command permissions.
- `tauri.macos.conf.json`: `identifier: ai.indigo.hq-sync-menubar`, mac private APIs, `Info.plist`, entitlements, Recall/GStreamer resources, mac updater pubkey/endpoint.
- `tauri.windows.conf.json`: `identifier: ai.indigo.hq-sync-win`, MSI/NSIS, WebView2 bootstrapper, existing Windows upgrade code `8E5B6C7F-3A2D-4B1E-9F0C-1D2E3F4A5B6C`, Windows AUMID behavior, Windows updater pubkey/endpoint.

Updater continuity is a release blocker:

1. First unified sync version is `0.8.0`, greater than both `0.7.24` and `0.6.4`.
2. Preserve macOS bundle identifier `ai.indigo.hq-sync-menubar`.
3. Preserve Windows identifier `ai.indigo.hq-sync-win` and MSI upgrade code.
4. Sign first unified updater artifacts with the existing platform-specific updater keys; do not rotate keys.
5. Publish compatibility `latest.json` at both old endpoints used by installed clients:
   - `https://github.com/indigoai-us/hq-sync/releases/latest/download/latest.json`
   - `https://github.com/indigoai-us/hq-sync-win/releases/latest/download/latest.json`
6. New binaries switch to app/channel-specific manifest URLs under the new release domain.
7. Keep old endpoints alive for at least two stable sync releases and 90 days.

## 6. Frontend strategy (React installer + Svelte sync coexisting; what TS is shared vs not)

Keep the frontend frameworks separate:

- Installer remains React 19 with Vite, Tailwind 4, shadcn/Base UI, Playwright, and Vitest.
- Sync remains Svelte 5 with Vite, Svelte Check, Vitest, desktop-alt harness, and Recall sidecar scripts.
- No shared React/Svelte component package.
- No attempt to make installer screens and sync popover share UI primitives.

Use pnpm 10 at the repo root. Convert `hq-sync-win` from npm to pnpm during migration. Convert Tauri `beforeDevCommand` and `beforeBuildCommand` from `npm run ...` to `pnpm ...`. Keep dev ports stable: installer `1420`, sync `1421`.

Shared TypeScript is framework-neutral only:

| Package | Shared content |
|---|---|
| `@indigo/config` | Env parsing, release channels, product constants, endpoint construction. |
| `@indigo/tauri-ipc` | Typed `invoke` wrappers, generated command/event payload types, shared error normalization. |
| `@indigo/auth` | Cognito config types, OAuth handoff payloads, token state shapes. |
| `@indigo/cloud` | API client types, retry policy, request attribution helpers. |
| `@indigo/telemetry` | Event names, Sentry tags, scrubber fixtures, opt-in payloads. |
| `@indigo/release` | Version/channel helpers and updater manifest types. |
| `@indigo/design-tokens` | CSS custom properties and token exports, not components. |
| `@indigo/testing` | IPC mocks, Cognito mocks, fixture builders, manifest fixtures. |

The sync frontend should carry one cross-platform UI with platform tokens for window size, vibrancy assumptions, and tray placement. The Windows fork’s `src/packages` surface is imported into unified sync only if its corresponding backend commands are present and covered.

## 7. Unified build, release, signing (macOS notarization + Windows Azure Trusted Signing), updater (.sig regeneration after Authenticode) and versioning (decide independent vs locked, and justify)

Versioning decision: use independent app versions, with one locked sync version across macOS and Windows.

Justification: installer `0.12.0`, mac sync `0.7.24`, and Windows sync `0.6.4` have different release cadences and user impact. Locking installer and sync together creates unnecessary releases. Letting mac sync and Windows sync diverge again recreates the fork.

Use app-scoped tags:

```text
installer-v0.12.1
sync-v0.8.0
sync-v0.8.1-beta.1
sync-v0.8.1-alpha.1
```

`versions.toml` is the source of truth. `tooling/scripts/version-app.ts` writes app `package.json`, Tauri config, app `Cargo.toml`, and validates the root `Cargo.lock` package entry. Release refuses mismatched versions.

Build targets:

| App | macOS | Windows |
|---|---|---|
| Installer | `universal-apple-darwin`, signed/notarized app/zip | `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`, MSI/NSIS |
| Sync | `aarch64-apple-darwin` initially, because Recall SDK is arm64-only | `x86_64-pc-windows-msvc` initially, because Windows Recall sidecar ARM64 is not valid yet |

macOS signing:

- Installer continues with `tauri-apps/tauri-action@v0`, Developer ID Application signing, notarization, stapling, and `ditto --keepParent --sequesterRsrc` zip creation.
- Sync keeps the manual release flow: build raw `.app`, repair Recall/GStreamer symlinks, sign inside-out with hardened runtime and entitlements, never use `codesign --deep`, notarize with `notarytool`, staple, then create updater archive and DMG from the signed/stapled app.

Windows signing:

- Use Azure Trusted Signing for both apps.
- Use GitHub OIDC with `id-token: write` and `environment: release`.
- Endpoint: `https://eus.codesigning.azure.net/`.
- Account/profile: `indigosigning` / `indigo-codesign`.
- Sign MSI and NSIS outputs after Tauri build.
- Verify every signed artifact with `Get-AuthenticodeSignature`.

Updater:

- Sync emits updater artifacts immediately.
- Installer uses the shared updater crate and manifest tooling, but runtime updater stays disabled for the first monorepo release.
- Publish manifests per app and channel, not one global GitHub `latest.json`:

```text
https://downloads.getindigo.ai/hq-desktop-app/sync/stable/latest.json
https://downloads.getindigo.ai/hq-desktop-app/sync/beta/latest.json
https://downloads.getindigo.ai/hq-desktop-app/sync/alpha/latest.json
https://downloads.getindigo.ai/hq-desktop-app/installer/stable/latest.json
```

The Windows updater rule is mandatory: Authenticode signing mutates installer bytes, so Tauri updater `.sig` files must be regenerated after Azure Trusted Signing and verified against the final signed bytes before publishing `latest.json`.

## 8. Unified CI design (jobs, matrix, gates)

Use one required PR workflow plus release/nightly/smoke workflows.

| Job | Matrix | Required gates |
|---|---|---|
| `workspace` | Ubuntu | `pnpm install --frozen-lockfile`, `cargo metadata`, version file consistency, workspace package naming, no nested lockfiles. |
| `frontend` | `app: installer/sync` on Ubuntu | Turbo affected build, typecheck, lint, unit tests. Installer runs React/Vitest; sync runs Svelte Check/Vitest. |
| `rust` | `os: macos-latest/windows-latest` | `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` where target support exists. |
| `tauri-smoke` | installer macOS, installer Windows x64/ARM64, sync macOS arm64, sync Windows x64 | Unsigned or dogfood builds with signing/updater disabled where needed; verifies bundle creation and resources. |
| `installer-e2e` | macOS | Playwright full mocked Cognito/OAuth walkthrough and installer parity tests. |
| `sync-e2e` | macOS plus Windows smoke | Desktop-alt harness, popover smoke, command fixture tests, tray/autostart/platform tests. |
| `sync-contract` | macOS and Windows | Generate command/event manifest from unified sync and fail if command surfaces drift without an intentional manifest update. |
| `release-dry-run` | manual dispatch | Build signed/notarized/signed artifacts without publishing; verify updater signatures and artifact manifests. |

Nightly regression runs:

- Installer canonical tar extraction parity on macOS and Windows.
- Sync path resolution, release-channel selection, conflict payload, notification history, meeting state, and hq-core drift fixtures from both forks.
- Recall resource layout smoke.
- Sync performance budgets: idle memory under 50 MB, popover open under 100 ms, bundle under 15 MB.
- Download page smoke after cutover.

CI must include path filters for speed, but full matrix runs on `main`, release tags, and any PR touching shared crates, release tooling, Tauri config, signing scripts, or updater code.

## 9. Phased migration plan with git-history preservation (git-filter-repo per repo into subdirs), each phase having explicit verifiable done-criteria

Phase 0: Freeze and inventory.

- Freeze non-critical releases in all three repos.
- Record source SHAs, current versions, updater pubkeys/private key owners, Apple secrets, Azure signing config, Sentry projects, Cognito vars, old updater endpoints, MSI upgrade codes, and public download URLs.
- Done criteria: inventory committed to private migration notes; backup tags exist in all source repos; current release status is known.

Phase 1: Create monorepo skeleton.

- Add root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `Cargo.toml`, `versions.toml`, `.cargo/config.toml`, initial workflows, and empty app/crate directories.
- Done criteria: `pnpm install`, `cargo metadata`, and empty CI scaffold pass.

Phase 2: Import histories with `git-filter-repo`.

```bash
git clone git@github.com:indigoai-us/hq-installer.git /tmp/hq-imports/installer
cd /tmp/hq-imports/installer
git filter-repo --to-subdirectory-filter apps/installer --tag-rename '':'installer-'

git clone git@github.com:indigoai-us/hq-sync.git /tmp/hq-imports/sync
cd /tmp/hq-imports/sync
git filter-repo --to-subdirectory-filter apps/sync --tag-rename '':'sync-mac-'

git clone git@github.com:indigoai-us/hq-sync-win.git /tmp/hq-imports/sync-win
cd /tmp/hq-imports/sync-win
git filter-repo --to-subdirectory-filter imports/hq-sync-win --tag-rename '':'sync-win-'
```

Merge all three filtered histories with `--allow-unrelated-histories`.

- Done criteria: `git log -- apps/installer`, `git log -- apps/sync`, and `git log -- imports/hq-sync-win` show source histories; namespaced tags are present.

Phase 3: Normalize JS workspace.

- Rename packages to `@indigo/hq-installer` and `@indigo/hq-sync`.
- Convert npm scripts to pnpm.
- Delete nested lockfiles after root lockfile is generated.
- Keep installer port `1420` and sync port `1421`.
- Done criteria: root `pnpm install --frozen-lockfile`, app typechecks, app tests, and Turbo graph all pass.

Phase 4: Establish root Cargo workspace without behavior changes.

- Add both Tauri app crates as workspace members.
- Move shared dependency versions to `[workspace.dependencies]`.
- Keep app commands intact.
- Done criteria: `cargo check --workspace` passes on macOS and Windows; existing app-specific Rust tests pass.

Phase 5: Reunite sync fork.

- Keep `apps/sync` from macOS sync as the base.
- Port Windows-only modules `new_files` and `rescue_script_cache`.
- Port Windows diffs in `Cargo.toml`, `tauri.conf.json`, capabilities, tray, process, autostart, DWM/Mica, sidecar, and release scripts.
- Add `tauri.macos.conf.json` and `tauri.windows.conf.json`.
- Delete `imports/hq-sync-win` only after accepted deltas are represented in `apps/sync`.
- Done criteria: unified sync compiles and smoke-builds on macOS and Windows; 44 shared modules remain shared; exact divergent modules are accounted for; no `apps/sync-win` exists.

Phase 6: Extract shared Rust crates incrementally.

- Extract in order: `hq-desktop-core`, `hq-ipc`, `hq-process`, `hq-platform`, `hq-auth-vault`, `hq-updater`, `hq-notifications`, `hq-meetings-recall`, `hq-cloud`, `hq-cli`, `hq-content`, app cores.
- Done criteria after each crate: both apps compile, command names and IPC payloads remain compatible, tests pass on macOS and Windows.

Phase 7: Unify release workflows.

- Replace repo-specific release workflows with one app-scoped release workflow.
- Implement version validation, signing, notarization, Azure signing, updater manifest generation, compatibility manifest publishing, and dry-run dispatch.
- Done criteria: signed dry-run releases succeed for installer macOS, installer Windows x64/ARM64, sync macOS, sync Windows x64; updater signatures verify over final bytes.

Phase 8: Production cutover.

- Ship `sync-v0.8.0` first as the fork-reunion release.
- Ship `installer-v0.12.1` from the monorepo after installer artifact parity is verified.
- Archive old repos only after one successful stable release cycle.
- Done criteria: existing mac sync updates in place; existing Windows sync updates in place; fresh installs work from public pages; old updater endpoints still serve valid migration manifests.

## 10. Cutover of the public download/install page (hqforwork.com/install + getindigo.ai/install)

Treat the download page as part of release, not marketing.

Cutover plan:

1. Inventory current links and asset names on `hqforwork.com/install` and `getindigo.ai/install`.
2. Define canonical artifact URLs from `hq-desktop-app` releases and the download CDN.
3. Keep stable versionless aliases for public pages, backed by immutable versioned artifacts.
4. Update both pages in the same deployment window so they advertise the same app versions.
5. Keep old GitHub release URLs and old sync updater endpoints alive during the migration window.
6. Add visible internal release notes linking legacy repos to `indigoai-us/hq-desktop-app`.
7. Add `download-page-smoke.yml` that fetches both public pages, extracts every advertised URL, downloads artifacts, and verifies:
   - macOS notarization/stapling where applicable.
   - Windows Authenticode validity.
   - Checksums.
   - `latest.json` shape.
   - Tauri updater signatures.
   - Cache headers and redirect behavior.

The pages should advertise:

| OS | Primary public download | Notes |
|---|---|---|
| macOS | signed/notarized installer universal artifact | Sync direct download may remain available for existing sync-only users. |
| Windows x64 | signed installer MSI/NSIS | Sync direct download uses signed Windows x64 artifact. |
| Windows ARM64 | signed installer MSI/NSIS | Sync Windows ARM64 stays hidden until Recall sidecar emits a real ARM64 launcher. |

Done criteria for cutover: both pages serve monorepo artifacts, no page points at stale old-repo assets, fresh install works on macOS and Windows, and the smoke workflow is required before public announcement.

## 11. Top risks and mitigations (table)

| Risk | Mitigation |
|---|---|
| Existing sync users cannot update to unified sync | Preserve platform identifiers, Windows MSI upgrade code, old updater pubkeys, old updater endpoints, and publish `sync-v0.8.0` as greater than both fork versions. |
| Windows updater signatures become invalid | Regenerate `.sig` after Azure Trusted Signing and verify signatures against final signed installer bytes before publishing manifests. |
| Sync fork drift reappears | Keep one `apps/sync`, add `sync-contract.yml`, and fail CI when macOS/Windows command manifests diverge unintentionally. |
| Recall SDK breaks macOS universal or Windows ARM64 | Ship sync macOS arm64 and Windows x64 only until Recall provides valid universal/ARM64 artifacts. Label artifacts honestly. |
| macOS sync signing fails after migration | Preserve manual inside-out signing, symlink repair, hardened runtime entitlements, notarization, and the no `codesign --deep` rule. |
| Shared crates become dumping grounds | Enforce crate boundaries and keep Tauri handles/window lifecycle in app crates. Extract incrementally with tests after each move. |
| React/Svelte tooling conflicts | Root tooling stays minimal; app configs own framework-specific behavior; shared TS packages are framework-neutral. |
| Version files drift | Use `versions.toml`, `version-app.ts`, and release-time `assert-versions.ts` before any build starts. |
| CI becomes too slow | Use Turbo affected tasks, Cargo package targeting, path filters, caches, and full matrices only on main/tags/high-risk paths. |
| Public pages keep serving old assets | Make download-page smoke a release gate and keep old endpoint compatibility for 90 days and two stable sync releases. |
| Installer updater scope expands during migration | Shared updater tooling is built now; installer runtime self-update remains off until a separate owner-approved release. |

## 12. Open questions for the owner

1. What exact CDN/domain should own production updater manifests: `downloads.getindigo.ai`, `releases.getindigo.ai`, or another existing property?
2. Can the old `hq-sync` and `hq-sync-win` repos publish compatibility `latest.json` releases that point to monorepo artifacts, or do they require one final bridge binary?
3. Should `ai.indigo.hq-sync-win` remain the Windows identifier indefinitely, or should a later explicit migration move Windows to a unified identifier?
4. Which mac-only operator surfaces should be visible on Windows in `sync-v0.8.0`: `library_local`, `marketplace`, `messages`, and `projects_local`, or all hidden until parity tests exist?
5. Who owns the deployment path for `hqforwork.com/install` and `getindigo.ai/install`, and can release CI trigger that deployment?
6. Should Sentry keep separate historical product names for migration tags, or standardize immediately on `hq-installer` and `hq-sync`?
7. What is the rollback policy if one legacy sync updater path fails after `sync-v0.8.0` ships?
8. When should installer self-update be enabled after the monorepo release stabilizes?
