# Code signing — Windows

Windows installers need a code-signing certificate so SmartScreen and Windows Defender don't block them. For V1 dogfood we ship with a placeholder cert subject `Indigo AI` (or unsigned if the cert isn't provisioned) — users see a SmartScreen warning on first install but can click through. **Resolve before any external rollout.**

This doc captures the V1 placeholder flow and the V2 EV-cert flow.

## V1 — placeholder / unsigned

Behavior when secrets are empty (PR builds, fork builds):

- `release.yml` skips the "Decode signing certificate" step (`if: env.WINDOWS_SIGNING_CERT != ''`).
- `release.yml` skips the SignTool step (`if: env.PFX_PATH != ''`).
- MSI + NSIS installers ship unsigned.
- Users get SmartScreen prompts; "More info" → "Run anyway" works.

To run a placeholder-signed build for the internal dogfood cohort:

1. Generate a self-signed cert (only for internal use):
   ```powershell
   $cert = New-SelfSignedCertificate -Type CodeSigningCert `
       -Subject "CN=Indigo AI (Dogfood)" `
       -CertStoreLocation Cert:\CurrentUser\My `
       -KeyExportPolicy Exportable
   $pwd = ConvertTo-SecureString -String "dogfood-placeholder" -Force -AsPlainText
   Export-PfxCertificate -Cert $cert -FilePath ./hq-sync-win-dogfood.pfx -Password $pwd
   ```

2. Base64 the PFX and set as the GitHub secret `WINDOWS_SIGNING_CERT`:
   ```powershell
   $bytes = [IO.File]::ReadAllBytes("./hq-sync-win-dogfood.pfx")
   $b64 = [Convert]::ToBase64String($bytes)
   gh secret set WINDOWS_SIGNING_CERT -b $b64
   gh secret set WINDOWS_SIGNING_CERT_PASSWORD -b "dogfood-placeholder"
   ```

3. Push a `v*` tag — `release.yml` decodes the cert, runs SignTool, and produces signed installers.

The self-signed cert is **not trusted by any user's machine**. SmartScreen still warns. The benefit is that the digital signature surface in `Properties → Digital Signatures` shows `Indigo AI (Dogfood)` as the publisher, which builds confidence for internal users.

## V2 — real EV / OV cert

Cost: ~$300–$500/year (Sectigo, DigiCert, etc.). EV certs are HSM-bound (USB dongle) and require a separate signing flow; OV certs are file-based PFX (same flow as the placeholder above).

Recommendation: **share one cert with `hq-installer-win`** at the GitHub Org level rather than per-repo. Same publisher subject, lower cost, fewer secrets to rotate.

Once provisioned:

1. Set the organization-level GitHub secret:
   ```
   gh secret set WINDOWS_SIGNING_CERT --org indigoai-us --visibility all -b @hq-sync-win.pfx.base64
   gh secret set WINDOWS_SIGNING_CERT_PASSWORD --org indigoai-us --visibility all -b "<password>"
   ```

2. Both `hq-sync-win` and `hq-installer-win` `release.yml` workflows pick up the secret automatically.

3. After 6–12 months of consistent signing, SmartScreen reputation accrues and the warning disappears for OV-signed binaries. EV-signed binaries get immediate reputation.

## Verification

After install (signed or unsigned):

```powershell
# Inspect the digital signature
Get-AuthenticodeSignature "C:\Program Files\HQ Sync\HQ Sync.exe"
```

`Status: Valid` with the expected Subject means signing worked. `NotSigned` means the build ran without secrets in scope.

## Timestamping

The CI flow uses `http://timestamp.digicert.com` as the timestamp authority via `signtool /tr`. This embeds a counter-signature from DigiCert proving when the file was signed — without it, the signature would expire when the code-signing cert expires (typically 1–3 years). Timestamping makes the signature valid forever.

## Updater signature (separate)

Tauri's auto-updater uses a **second** signature stream — minisign keypair, not a Windows code-signing cert. See `scripts/generate-updater-keypair.ps1` for keypair generation and the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The minisign signature is checked client-side before the updater applies an update; the SignTool signature is checked OS-side at install time.
