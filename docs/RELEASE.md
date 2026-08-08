# HQ Release Process

This repository releases the unified `HQ` Tauri app from `apps/sync`.

The release workflow builds a macOS universal app/DMG, Windows MSI and NSIS
installers for x64 and ARM64, Tauri updater artifacts, `latest.json`, and a
GitHub Release. Verified production runs sign, notarize, and staple the macOS
artifacts and apply Azure Trusted Signing to both Windows architectures. The
ARM64 bundle uses a checksum-verified native ARM64 Node runtime for the Recall
SEA launcher; Recall's separate x64 agent runs through Windows on ARM's x64
emulation.

The updater manifests point at version-pinned GitHub Release assets. Stable,
beta, and alpha share one trust root and artifact contract, but their release
selection is isolated so a prerelease cannot replace stable latest.

## Cut a Release

1. Change `[product].version` in `versions.toml`.
2. Stamp and verify the four generated version files:

   ```bash
   pnpm version:app
   pnpm version:check
   ```

   This synchronizes `apps/sync/package.json`,
   `apps/sync/src-tauri/tauri.conf.json`, `apps/sync/src-tauri/Cargo.toml`,
   and the `hq-sync-menubar` entry in `apps/sync/src-tauri/Cargo.lock`.
3. Commit and merge the version bump to `main`.
4. Create and push a fresh annotated release tag. Supported forms are
   `vX.Y.Z`, `vX.Y.Z-beta.N`, and `vX.Y.Z-alpha.N`:

   ```bash
   git tag -a vX.Y.Z -m "HQ vX.Y.Z"
   git push origin vX.Y.Z
   ```

The workflow requires the tag commit to be contained in `main` and validates
the tag against `versions.toml` plus all four generated version files. Never
move a pushed tag after a failed release; fix the release path and cut a fresh
SemVer tag.

`workflow_dispatch` accepts an existing tag for a retry. It builds the immutable
tag contents while loading the reviewed publication helpers from the workflow
commit. If that tag is already public and healthy, the retry is read-only:
release creation/reset, asset deletion/upload, and publication are all skipped.

## Required GitHub Secrets

### macOS Signing and Notarization

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`.
- `APPLE_CERTIFICATE_PASSWORD`: password for the `.p12`.
- `APPLE_SIGNING_IDENTITY`: full identity string, for example `Developer ID Application: NAME (TEAMID)`.
- `APPLE_ID`: the Apple ID (email) used for notarization.
- `APPLE_PASSWORD`: an app-specific password for that Apple ID (notarytool).
- `APPLE_TEAM_ID`: the Apple Developer Team ID.

Notarization uses the Apple-ID method (`xcrun notarytool --apple-id/--password/--team-id`) — the same credential set as the legacy `hq-sync` / `hq-installer` repos. (The App Store Connect API-key method is **not** used; `scripts/notarize.sh` still implements it for local runs but the workflow inlines the Apple-ID call.)

### Tauri updater channels

HQ ships one updater trust root for all platforms: a single signing key and
public key. Both `apps/sync/src-tauri/tauri.conf.json` (macOS) and
`apps/sync/src-tauri/tauri.windows.conf.json` (Windows) carry the same pubkey
(`9DE1695B…`, the existing `hq-sync` key).

- Stable polls
  `https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/latest.json`.
- Beta and alpha resolve the highest eligible public release for their channel,
  then read that tag's
  `https://github.com/indigoai-us/hq-desktop-app/releases/download/<tag>/latest.json`.

- `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the single private key matching that pubkey (the `hq-sync` macOS updater key — set it once; the macOS and Windows jobs both use it).

Each release publishes one `latest.json` covering `darwin-aarch64`,
`darwin-x86_64`, `windows-x86_64`, and `windows-aarch64`, signed with that one
key. Stable releases use `make_latest=true`; beta and alpha use
`make_latest=false`, so GitHub's `/releases/latest/` alias remains stable.

### Versionless download aliases

Alongside the version-stamped assets, each release also publishes versionless copies for stable, marketing-friendly download links (the hq-installer pattern):

- `HQ.dmg`, `HQ_x64-setup.exe`, `HQ_arm64-setup.exe` → e.g. `https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/HQ.dmg`

(The auto-updater itself uses `latest.json` with the versioned URLs; these aliases are for direct human downloads.)

### Build-Time Telemetry

- `VITE_SENTRY_DSN`: Svelte/Vite Sentry DSN inlined into the web bundle.
- `HQ_SYNC_SENTRY_DSN`: Rust Sentry DSN read by `apps/sync/src-tauri/build.rs`.
- `SENTRY_AUTH_TOKEN`: an org-scoped Sentry token with `project:write` access
  to `indigo-d0/hq-desktop`. The release workflow uses it only to upload
  native debug files without source content. This token is required for
  server-side symbolication. Without it, the release still builds, but the job
  summary names the debug id that was not uploaded.

No Cognito `VITE_*` secrets are required by the current unified app. Grepping the app shows only `VITE_SENTRY_DSN` is read by frontend release code.

### Native debug-file contract

Each release build creates the native files that Sentry needs to resolve a
crash:

- macOS: the universal `HQ.app` and its adjacent `HQ.app.dSYM`.
- Windows: `hq-sync-menubar.exe` and the adjacent
  `hq_sync_menubar.pdb`, for both x64 and ARM64.

On macOS the shipped binary is stripped (`strip = "symbols"` in
`[profile.release]`) so the public `.app` stays under the 15 MB bundle budget
deterministically — without it, stale rust-cache / incremental artifacts
intermittently left full debug info embedded and blew the guard. Because a
stripped binary can no longer be re-processed by `dsymutil`, the workflow builds
`HQ.app.dSYM` from the packed per-arch dSYMs that `split-debuginfo = "packed"`
emits at link time (`lipo`-combining the two arch DWARFs into one universal
sidecar). The binary's `LC_UUID` debug id survives strip, so the app binary and
the sidecar dSYM still share the same debug id set.

The workflow verifies each executable and debug-file pair with `sentry-cli
difutil check` before upload. Sentry is the only retention path. The upload uses
`--no-sources`, and `.pdb` and `.dSYM` files are never published as GitHub
Release assets or GitHub Actions workflow artifacts.

If `SENTRY_AUTH_TOKEN` is missing or Sentry rejects it, the workflow adds a
warning to the log and job summary. The release still succeeds, but that build
has no recoverable symbols. After a successful upload, the workflow queries the
Sentry project's debug-file listing for every verified debug id and fails if a
matching record is missing.

To verify a release manually, list the debug files in `indigo-d0/hq-desktop`
and compare each returned debug id with the id printed by the build's debug-file
contract step.

## Required GitHub Repository Variables

`RELEASE_UNVERIFIED` controls platform trust signing. It defaults to `true`:
macOS is ad-hoc signed, Apple notarization is skipped, and Azure Authenticode is
skipped, while Tauri updater signatures are still generated. Set it to `false`
for a verified production release.

Windows signing uses Azure Trusted Signing through GitHub OIDC. Configure these repository variables:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

The workflow signs with:

- endpoint: `https://eus.codesigning.azure.net/`
- signing account: `indigosigning`
- certificate profile: `indigo-codesign`

## Azure Trusted Signing Setup

The Windows job is bound to the GitHub Actions `release` environment so the OIDC subject is stable for both tag pushes and manual dispatches.

Add a federated credential to the Azure identity referenced by `AZURE_CLIENT_ID` that trusts this repository and environment:

```text
repo:indigoai-us/hq-desktop-app:environment:release
```

The identity must have access to the `indigosigning` Trusted Signing account and the `indigo-codesign` certificate profile in the subscription configured by `AZURE_SUBSCRIPTION_ID`.

If `AZURE_CLIENT_ID` is not set, or `RELEASE_UNVERIFIED` is not `false`, the
Azure login and Trusted Signing steps are skipped. Verified production releases
must set `RELEASE_UNVERIFIED=false` and configure the Azure variables so the MSI
and NSIS installers are Authenticode-signed. The workflow regenerates each
Tauri updater `.sig` after Authenticode signing because signing mutates the
installer bytes.

## Windows prerelease versions

WiX/MSI `ProductVersion` accepts only three numeric fields. For
`X.Y.Z-beta.N` and `X.Y.Z-alpha.N`, `scripts/windows-msi-version.mjs` generates
a final Tauri config overlay containing numeric `X.Y.Z`. Full SemVer remains on
the app, NSIS installer, updater manifest, tag, and artifact names.

Windows Installer cannot order two prereleases that share the same `X.Y.Z`
MSI version. The SemVer-aware NSIS updater is the supported automatic update
path; a manual MSI install can replace another same-base MSI in either
direction.

## Atomic publication and retries

The publish job is globally serialized across release tags. It:

1. Rejects a stable rollback before native builds and rechecks stable order
   immediately before publication.
2. Creates or resets a hidden draft and uploads the complete 15-asset set.
3. Verifies the exact names, upload state, byte sizes, SHA-256 digests,
   updater-platform URLs, and detached signature sidecars.
4. Makes the release public with one final PATCH only after the draft passes.
5. Confirms the public asset/manifest contract and verifies that prereleases
   did not replace stable latest.

An already-published healthy tag is accepted as a read-only rerun success.
Signed, notarized, and timestamped rebuilds are not byte-deterministic, so the
rerun validates the existing public release rather than overwriting its assets.
The control-plane helpers are `scripts/release-asset-contract.mjs` and
`scripts/release-stable-order.mjs`.

## Artifact Shape

The publish job attaches these assets to the GitHub Release:

- `HQ_<version>_universal.dmg`
- `HQ_<version>_universal.app.tar.gz`
- `HQ_<version>_universal.app.tar.gz.sig`
- `HQ_<version>_x64.msi`
- `HQ_<version>_x64.msi.sig` if Tauri emits an MSI updater signature
- `HQ_<version>_x64-setup.exe`
- `HQ_<version>_x64-setup.exe.sig`
- `HQ_<version>_arm64.msi`
- `HQ_<version>_arm64.msi.sig` if Tauri emits an MSI updater signature
- `HQ_<version>_arm64-setup.exe`
- `HQ_<version>_arm64-setup.exe.sig`
- `latest.json`

`latest.json` contains four updater platform entries:

- `darwin-aarch64`
- `darwin-x86_64`
- `windows-x86_64`
- `windows-aarch64`

Both macOS entries point at the universal `HQ.app.tar.gz` updater archive.
