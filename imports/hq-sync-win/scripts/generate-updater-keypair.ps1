# Generate a fresh minisign keypair for the hq-sync-win Tauri auto-updater.
#
# The macOS hq-sync app uses a different keypair (committed to that repo).
# We MUST NOT reuse it — sharing keys means a macOS-signed update could
# install on Windows users (or vice versa). This script generates a Windows-
# specific keypair, then:
#   - prints the public key (paste into src-tauri/tauri.conf.json
#     under plugins.updater.pubkey)
#   - writes the private key to ~/.tauri/hq-sync-win.key (default
#     location for `tauri signer generate`)
#   - prints the base64-encoded private key (paste into GitHub
#     repository secret TAURI_SIGNING_PRIVATE_KEY, and the passphrase
#     into TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
#
# Run once per repo. Do NOT commit the private key.

[CmdletBinding()]
param(
    [string]$KeyName = "hq-sync-win",
    [string]$KeyPath = (Join-Path $env:USERPROFILE ".tauri\hq-sync-win.key")
)

$ErrorActionPreference = "Stop"

Write-Host "Generating Tauri updater keypair..." -ForegroundColor Cyan
Write-Host "  Key name: $KeyName"
Write-Host "  Key file: $KeyPath"
Write-Host ""

# Tauri's signer subcommand is shipped with @tauri-apps/cli. Use npx so
# the script works without a global install.
$generate = "npx --yes @tauri-apps/cli signer generate --write-keys `"$KeyPath`" --force"
Write-Host "Running: $generate"
Invoke-Expression $generate

if (-not (Test-Path $KeyPath)) {
    Write-Error "Key generation appears to have failed — $KeyPath was not created."
    exit 1
}

$privatePath = $KeyPath
$publicPath  = "$KeyPath.pub"

Write-Host ""
Write-Host "================ PUBLIC KEY (copy into tauri.conf.json) ================" -ForegroundColor Green
Get-Content $publicPath -Raw

Write-Host ""
Write-Host "================ PRIVATE KEY (set as GH secret TAURI_SIGNING_PRIVATE_KEY) ================" -ForegroundColor Yellow
$privateContent = Get-Content $privatePath -Raw
$privateB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($privateContent))
Write-Host $privateB64

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Copy the public key (the dW50cnVzdGVkIGNvbW1lbnQ6 ... blob) into"
Write-Host "     src-tauri/tauri.conf.json -> plugins.updater.pubkey"
Write-Host "  2. Set the GitHub secret TAURI_SIGNING_PRIVATE_KEY to the base64 blob"
Write-Host "     above:  gh secret set TAURI_SIGNING_PRIVATE_KEY"
Write-Host "  3. Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD to the passphrase you entered"
Write-Host "     during key generation (use an empty value if you skipped it)."
Write-Host "  4. Commit the tauri.conf.json change. Do NOT commit the .key file."
