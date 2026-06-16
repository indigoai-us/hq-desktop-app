# Security — Code Signing & CI Pipeline

This document describes the secrets and credentials required for the HQ Sync release pipeline on Windows.

## GitHub Secrets

The following secrets must be configured in the repository settings under **Settings > Secrets and variables > Actions**. Names match the workflow file at `.github/workflows/release.yml`.

### Windows Code Signing (Authenticode / SignTool)

| Secret | Description |
|--------|-------------|
| `WINDOWS_SIGNING_CERT` | Base64-encoded `.pfx` (PKCS#12) code-signing certificate. Standard or EV. EV is strongly preferred because it confers immediate SmartScreen reputation; standard certs need to accumulate trust via downloads. |
| `WINDOWS_SIGNING_CERT_PASSWORD` | Password used when exporting the `.pfx`. |

#### How to create the `.pfx`

1. Acquire a code-signing certificate from a CA Microsoft trusts (DigiCert, SSL.com, Sectigo, etc.). EV certs typically ship on a YubiKey or HSM and require a slightly different export flow — consult the CA's instructions if you can't export a `.pfx` directly.
2. Export it (with the private key) as `.pfx` with a strong password.
3. Base64-encode it:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("hq-sync-codesign.pfx")) | Set-Clipboard
   ```
4. Paste the base64 string as the `WINDOWS_SIGNING_CERT` secret.
5. Set `WINDOWS_SIGNING_CERT_PASSWORD` to the password from step 2.

The CI workflow base64-decodes the secret to a temporary `.pfx` on the runner, signs the unsigned binary + every bundle (MSI + NSIS) via `signtool sign /f <pfx> /p <password> /tr <timestamp-url> /td sha256 /fd sha256`, and deletes the `.pfx` in the cleanup step.

### Tauri Auto-Updater Signing

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key for signing update bundles |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |

The updater signature is OS-agnostic — it ensures end users can verify update authenticity regardless of platform. It does *not* replace Authenticode for SmartScreen; the two are layered.

#### How to generate updater keys

```powershell
npx @tauri-apps/cli signer generate -- -w $env:USERPROFILE\.tauri\hq-sync.key
```

This produces:
- `~/.tauri/hq-sync.key` — private key (set as `TAURI_SIGNING_PRIVATE_KEY`)
- `~/.tauri/hq-sync.key.pub` — public key (embed in `tauri.conf.json` under `plugins.updater.pubkey`)

Set the password you chose during generation as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### Sentry

| Secret | Description |
|--------|-------------|
| `HQ_SYNC_SENTRY_DSN` | Release-only Sentry DSN. PR/CI builds have it empty and the SDK no-ops cleanly (gated on emptiness in `src-tauri/build.rs`). |

### GitHub Token

`GITHUB_TOKEN` is automatically provided by GitHub Actions. No manual setup needed. It is used to create releases and upload artifacts.

## Local signing

For developers signing a release manually (not via CI), the workflow's signing steps are the source of truth — see `.github/workflows/release.yml`. The general shape:

```powershell
# 1. Build (per arch)
npm run tauri build -- --target x86_64-pc-windows-msvc
npm run tauri build -- --target aarch64-pc-windows-msvc

# 2. Locate signtool (Windows SDK)
$signtool = (Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" |
             Sort-Object { $_.FullName } -Descending | Select-Object -First 1).FullName

# 3. Sign each bundle (MSI + NSIS) with /td sha256 /fd sha256 + a timestamp URL
& $signtool sign /f hq-sync-codesign.pfx /p $password `
  /tr http://timestamp.digicert.com /td sha256 /fd sha256 `
  "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\HQ Sync_*_x64_en-US.msi"
```

`/tr` is required — without a timestamped countersignature, the binary's signature becomes invalid the day the cert expires. With one, signatures remain valid forever from the user's standpoint.

## Security Notes

- The Windows signing-cert private key never leaves the CI runner. It is base64-decoded to a temporary `.pfx` and deleted in the cleanup step.
- All secrets are masked in GitHub Actions logs.
- The Tauri updater Ed25519 signature ensures end users can verify that updates come from us before applying them — independent of the Authenticode signature.
- The Sentry scrubber (`sentry_scrub.rs`) strips Cognito tokens and home-directory paths from every event before send. The DSN is treated as a release-only secret; local dev builds run with an empty DSN and the SDK no-ops.

## Out of scope

- macOS Developer ID code signing + Apple notary submission (this is the Windows fork — see [`indigoai-us/hq-sync`](https://github.com/indigoai-us/hq-sync) for the macOS pipeline).
