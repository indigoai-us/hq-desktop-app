# Installs the msedgedriver build that matches the machine's WebView2 runtime.
#
# tauri-driver spawns whatever `msedgedriver.exe` is first on PATH. GitHub's
# windows runners preinstall an Edge WebDriver that tracks the Edge *browser*
# channel, but the app under test embeds the WebView2 *runtime* — a separately
# updated component. When the two drift by a major version (browser 151,
# runtime 150), session creation fails with:
#   session not created: This version of Microsoft Edge WebDriver only
#   supports Microsoft Edge version 151. Current browser version is 150.x
#
# So: read the installed WebView2 runtime version from the registry, download
# the exact-matching driver (falling back to the latest driver for that major
# version when the exact build was never published), and prepend its directory
# to GITHUB_PATH so it shadows the runner's preinstalled driver.

$ErrorActionPreference = 'Stop'

function Get-WebView2RuntimeVersion {
    # Per-machine Evergreen runtime registry locations, 64-bit OS first.
    $keys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    foreach ($key in $keys) {
        $pv = (Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue).pv
        if ($pv -and $pv -ne '0.0.0.0') { return $pv }
    }
    throw 'WebView2 Evergreen runtime not found in the registry; cannot pick a matching msedgedriver.'
}

$runtimeVersion = Get-WebView2RuntimeVersion
Write-Host "WebView2 runtime version: $runtimeVersion"

$cdn = 'https://msedgedriver.microsoft.com'
$arch = 'win64'

# The driver CDN publishes per-build zips; not every runtime build has one, so
# fall back to the newest driver of the same major version. Same-major drivers
# accept any same-major browser, which is exactly the compatibility rule the
# failing error message enforces.
$candidates = @($runtimeVersion)
$major = $runtimeVersion.Split('.')[0]
try {
    $latest = (Invoke-WebRequest -Uri "$cdn/LATEST_RELEASE_${major}_WINDOWS" -UseBasicParsing).Content
    # The version files are UTF-16 with a BOM; normalize to a bare version string.
    $latest = ($latest -replace '[^\d.]', '').Trim()
    if ($latest -and $latest -ne $runtimeVersion) { $candidates += $latest }
} catch {
    Write-Host "No LATEST_RELEASE_${major}_WINDOWS marker ($($_.Exception.Message)); trying the exact build only."
}

$installDir = Join-Path $env:RUNNER_TEMP 'msedgedriver-webview2'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$zipPath = Join-Path $installDir 'edgedriver.zip'

$installed = $null
foreach ($version in $candidates) {
    $url = "$cdn/$version/edgedriver_$arch.zip"
    try {
        Write-Host "Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
        Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
        $installed = $version
        break
    } catch {
        Write-Host "No driver published for $version ($($_.Exception.Message))"
    }
}

if (-not $installed) {
    throw "Could not download an msedgedriver matching WebView2 runtime $runtimeVersion (tried: $($candidates -join ', '))."
}

$driver = Join-Path $installDir 'msedgedriver.exe'
if (-not (Test-Path -LiteralPath $driver)) {
    throw "Downloaded archive for $installed did not contain msedgedriver.exe."
}

& $driver --version
Write-Host "Installed msedgedriver $installed for WebView2 runtime $runtimeVersion at $driver"

# Prepend so this driver shadows the runner's preinstalled Edge WebDriver for
# every later step in the job.
$installDir | Out-File -FilePath $env:GITHUB_PATH -Append
