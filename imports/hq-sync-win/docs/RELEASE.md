# Releasing hq-sync-win

End-to-end release process for the Windows fork, plus the rotation runbooks for
the two independent signing keys involved:

| Key material | Purpose | Where the secret lives | Where the public half lives |
|--------------|---------|------------------------|------------------------------|
| **Updater keypair** (minisign) | Signs `latest.json` + the `.msi.zip` so an installed app can verify an update came from us | `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (GitHub Actions secrets) | `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` |
| **Code-signing cert** (Authenticode PFX) | Signs the `.exe` / `.msi` so Windows SmartScreen trusts the installer | `WINDOWS_SIGNING_CERT` (base64 PFX) + `WINDOWS_SIGNING_CERT_PASSWORD` | embedded in the signed binaries |

These are **separate** keys with separate rotation cycles. See
[`code-signing-windows.md`](./code-signing-windows.md) for cert details.

---

## 1. Cut a release

1. Bump the version triple in lockstep (owned by the version-bump story; keep
   `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` equal).
2. Commit, then tag: `git tag v0.4.0 && git push origin v0.4.0`.
3. `.github/workflows/release.yml` runs on the tag:
   - `npm ci` → `npm run tauri build --target x86_64-pc-windows-msvc --bundles msi nsis updater`
   - the build is signed with the **updater** key (env `TAURI_SIGNING_PRIVATE_KEY`),
     producing `*.msi.zip` + `*.msi.zip.sig`
   - the **SignTool** step Authenticode-signs **both** the `.msi` and the `.exe`
     (guarded by `if: env.WINDOWS_SIGNING_CERT != ''` — unsigned dogfood builds
     skip it cleanly)
   - the `release` job publishes a GitHub release with the artifacts + `latest.json`
4. Installed apps poll `plugins.updater.endpoints`
   (`…/releases/latest/download/latest.json`), verify its signature against the
   embedded `pubkey`, download, and apply.

### Verify the updater end-to-end

- `signtool verify /pa /v <installer>.exe` → signature valid, not expired.
- Install an older build, publish a newer release, confirm the popover footer
  shows the new version after the app relaunches.
- `latest.json` must carry a `signature` field that verifies against the
  `pubkey` currently in `tauri.conf.json` (mismatched key ⇒ silent no-update).

---

## 2. Rotate the updater pubkey

Do this if the private key is lost/leaked, or on a planned rotation.

> **Caveat:** an installed base signed against the *old* pubkey can only verify
> updates signed by the *old* private key. After a rotation, already-installed
> apps stop auto-updating until they are manually reinstalled from a freshly
> built (new-key) installer. There is currently no real installed base (the
> pre-US-010 pubkey was a placeholder), so the first rotation is free.

1. Generate a fresh keypair (writes the private key outside the repo; never commit it):
   ```powershell
   pwsh scripts/generate-updater-keypair.ps1
   ```
   or directly:
   ```powershell
   npx tauri signer generate -w "$env:USERPROFILE\.hq-sync-keys\hq-sync-win-updater.key" --password ""
   ```
2. Put the **public** half into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`. The field is the **base64 of the `.pub` file
   contents**:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.hq-sync-keys\hq-sync-win-updater.key.pub"))
   ```
3. Push the **private** half to GitHub Actions secrets (value never printed):
   ```powershell
   gh secret set TAURI_SIGNING_PRIVATE_KEY --repo indigoai-us/hq-sync-win < "$env:USERPROFILE\.hq-sync-keys\hq-sync-win-updater.key"
   # passphrase: empty for the dogfood key
   "" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo indigoai-us/hq-sync-win
   ```
4. Commit the `tauri.conf.json` pubkey change, cut a new release (§1). All
   future installers carry the new pubkey.

---

## 3. Rotate the code-signing cert

The Authenticode cert is independent of the updater key — rotating one does not
affect the other.

1. Obtain/renew the cert (self-signed for dogfood, OV/EV for public — see
   [`code-signing-windows.md`](./code-signing-windows.md) §"V2 — real EV / OV cert").
2. Export to PFX, base64-encode, update the secrets (values never printed):
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("hq-sync-win.pfx")) | gh secret set WINDOWS_SIGNING_CERT --repo indigoai-us/hq-sync-win
   "<pfx-password>" | gh secret set WINDOWS_SIGNING_CERT_PASSWORD --repo indigoai-us/hq-sync-win
   ```
3. Cut a new release. The SignTool step picks up the new PFX automatically.
4. Verify: `signtool verify /pa /v <installer>.exe` shows the new cert,
   timestamped via `http://timestamp.digicert.com` (so signatures remain valid
   after the cert expires).

---

## Current state (US-010)

- Updater `pubkey` in `tauri.conf.json` is a **real** key (the V1 placeholder
  was replaced). Its private half is set as `TAURI_SIGNING_PRIVATE_KEY`
  (passwordless dogfood key) in the repo's Actions secrets.
- `release.yml` signs both `.msi` and `.exe` and emits the updater manifest.
- Code-signing cert is **optional/self-signed for dogfood** — full EV/OV cert
  procurement remains a non-goal (carried forward from V1). When
  `WINDOWS_SIGNING_CERT` is unset, the SignTool step is skipped and unsigned
  dogfood installers ship (SmartScreen will warn on first run).
