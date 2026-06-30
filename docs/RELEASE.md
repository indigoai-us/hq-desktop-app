# HQ Release Process

This repository releases the unified `HQ` Tauri app from `apps/sync`.

The release workflow builds a signed and notarized macOS universal app/DMG, signed Windows MSI and NSIS installers for x64 and arm64, Tauri updater artifacts, `latest.json`, and a GitHub Release. The updater manifest currently points at GitHub Release asset URLs in this repository. Moving the endpoint to `downloads.getindigo.ai` is a separate follow-up; this workflow does not change `tauri.conf.json` or the platform overlays.

## Cut a Release

1. Bump the release version in all four files:
   - `apps/sync/package.json`
   - `apps/sync/src-tauri/tauri.conf.json`
   - `apps/sync/src-tauri/Cargo.toml`
   - `apps/sync/src-tauri/Cargo.lock`
2. Commit the version bump.
3. Create and push a `vX.Y.Z` tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The workflow also supports `workflow_dispatch` with a `tag` input, but production releases should be cut from pushed `vX.Y.Z` tags. The workflow validates that the tag and the four version files match exactly.

## Required GitHub Secrets

### macOS Signing and Notarization

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`.
- `APPLE_CERTIFICATE_PASSWORD`: password for the `.p12`.
- `APPLE_SIGNING_IDENTITY`: full identity string, for example `Developer ID Application: NAME (TEAMID)`.
- `APPLE_ID`: the Apple ID (email) used for notarization.
- `APPLE_PASSWORD`: an app-specific password for that Apple ID (notarytool).
- `APPLE_TEAM_ID`: the Apple Developer Team ID.

Notarization uses the Apple-ID method (`xcrun notarytool --apple-id/--password/--team-id`) — the same credential set as the legacy `hq-sync` / `hq-installer` repos. (The App Store Connect API-key method is **not** used; `scripts/notarize.sh` still implements it for local runs but the workflow inlines the Apple-ID call.)

### Tauri Updater (single stream)

HQ ships **one** updater stream for all platforms: a single signing key, one public key, and one endpoint. Both `apps/sync/src-tauri/tauri.conf.json` (macOS) and `apps/sync/src-tauri/tauri.windows.conf.json` (Windows) carry the **same** pubkey (`9DE1695B…`, the existing `hq-sync` key) and point at the same endpoint:

```
https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/latest.json
```

- `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the single private key matching that pubkey (the `hq-sync` macOS updater key — set it once; the macOS and Windows jobs both use it).

Each release publishes one `latest.json` covering `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, and `windows-aarch64`, signed with that one key. GitHub's `/releases/latest/download/` redirect makes the endpoint always resolve to the newest release.

### Versionless download aliases

Alongside the version-stamped assets, each release also publishes versionless copies for stable, marketing-friendly download links (the hq-installer pattern):

- `HQ_universal.dmg`, `HQ_x64-setup.exe`, `HQ_arm64-setup.exe` → e.g. `https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/HQ_universal.dmg`

(The auto-updater itself uses `latest.json` with the versioned URLs; these aliases are for direct human downloads.)

### Build-Time Telemetry

- `VITE_SENTRY_DSN`: Svelte/Vite Sentry DSN inlined into the web bundle.
- `HQ_SYNC_SENTRY_DSN`: Rust Sentry DSN read by `apps/sync/src-tauri/build.rs`.

No Cognito `VITE_*` secrets are required by the current unified app. Grepping the app shows only `VITE_SENTRY_DSN` is read by frontend release code.

## Required GitHub Repository Variables

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

If `AZURE_CLIENT_ID` is not set, the Azure login and Trusted Signing steps are skipped, matching the proven Windows workflow model for fork builds. Production releases must run with the Azure variables configured so the MSI and NSIS installers are Authenticode-signed. The workflow regenerates each Tauri updater `.sig` after Authenticode signing because signing mutates the installer bytes.

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
