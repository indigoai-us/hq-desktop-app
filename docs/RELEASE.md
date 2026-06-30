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
- `APPLE_API_KEY`: App Store Connect API key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer UUID.
- `APPLE_API_KEY_P8`: full contents of the App Store Connect `.p8` key file.

### Tauri Updater

- `TAURI_SIGNING_PRIVATE_KEY`: private key for Tauri updater signatures.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password for the private key.

These keys must correspond to the updater public keys already committed in `apps/sync/src-tauri/tauri.conf.json` and `apps/sync/src-tauri/tauri.windows.conf.json`.

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
