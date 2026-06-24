# Regenerate the Windows app icon (src-tauri/icons/icon.ico) and tray
# icons from the canonical source SVG (src-tauri/icons/app-icon.svg).
#
# Tauri's `tauri icon` CLI generates the right multi-resolution icon
# tree for both Windows (icon.ico, 32/128 PNGs) and macOS (.icns). We
# only need the Windows outputs; the script preserves icon.icns
# absence (US-002 deleted it from the Windows fork — keep it deleted).

[CmdletBinding()]
param(
    [string]$Source = (Join-Path $PSScriptRoot "..\src-tauri\icons\app-icon.svg")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Source)) {
    Write-Error "Source SVG not found: $Source"
    exit 1
}

Write-Host "Regenerating Windows app icons from $Source ..." -ForegroundColor Cyan

# `tauri icon` regenerates icon.ico (Windows multi-res), 32x32.png,
# 128x128.png, 128x128@2x.png. We delete any icon.icns it produces —
# the Windows fork doesn't bundle macOS-shaped icons.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    npx --yes @tauri-apps/cli icon $Source
} finally {
    Pop-Location
}

$mac = Join-Path $repoRoot "src-tauri\icons\icon.icns"
if (Test-Path $mac) {
    Remove-Item $mac -Force
    Write-Host "  Removed regenerated icon.icns (macOS-only, not bundled in Windows fork)"
}

Write-Host ""
Write-Host "Done. Updated:" -ForegroundColor Green
Write-Host "  src-tauri/icons/icon.ico        (multi-res Windows .ico)"
Write-Host "  src-tauri/icons/32x32.png"
Write-Host "  src-tauri/icons/128x128.png"
Write-Host "  src-tauri/icons/128x128@2x.png"
Write-Host ""
Write-Host "Tray icons (tray-idle/syncing/error/conflict.ico) come from US-005;"
Write-Host "this script does not touch them."
