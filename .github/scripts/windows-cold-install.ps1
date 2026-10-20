# Cold-run the customer Windows install on a runner with no HQ state.
# Fails the job with one line. Company creation, invites, and sign-in are
# recorded as "needs Beaker / owner" and are not attempted.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "indigoai-us/hq-desktop-app"
$OutRoot = Join-Path $env:GITHUB_WORKSPACE "cold-install-out"
$LogRoot = Join-Path $OutRoot "logs"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

$summary = [ordered]@{
  schema = "hq-windows-cold-install.v1"
  ok = $false
  failure = $null
  release = $null
  installer = $null
  install_location = $null
  start_menu = $null
  desktop_shortcut = $null
  binary = $null
  headless = $null
  cli = $null
  hook = $null
  needs_beaker_owner = @(
    "company creation",
    "invites",
    "sign-in",
    "hq doctor against a real HQ tree"
  )
}

function Save-Summary {
  $path = Join-Path $OutRoot "summary.json"
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding utf8
}

function Fail([string]$Reason) {
  $one = (($Reason -replace "\s+", " ").Trim())
  $summary.failure = $one
  $summary.ok = $false
  Save-Summary
  Write-Host "::error::$one"
  throw $one
}

function Test-InsideHqTree([string]$FilePath) {
  $dir = Split-Path -Parent $FilePath
  while ($dir) {
    $claude = Join-Path $dir ".claude"
    $core = Join-Path $dir "core"
    if ((Test-Path -LiteralPath $claude -PathType Container) -and (Test-Path -LiteralPath $core -PathType Container)) {
      return $true
    }
    $parent = Split-Path -Parent $dir
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
  }
  return $false
}

function Add-WindowProbeType {
  if ("HqWindowProbe" -as [type]) { return }
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class HqWindowProbe {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static string[] VisibleFor(uint[] pids) {
    var wanted = new HashSet<uint>(pids);
    var hits = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!wanted.Contains(pid)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      hits.Add(pid.ToString() + " " + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return hits.ToArray();
  }
}
"@
}

function Invoke-HookProcess([string]$FileName, [string]$Arguments, [hashtable]$EnvVars, [string]$Label) {
  Add-WindowProbeType
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FileName
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $false
  foreach ($key in $EnvVars.Keys) {
    $psi.EnvironmentVariables[$key] = [string]$EnvVars[$key]
  }
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $payload = '{"hook_event_name":"PreToolUse","tool_name":"Read"}'
  $proc.StandardInput.Write($payload)
  $proc.StandardInput.Close()

  $visible = New-Object System.Collections.Generic.List[string]
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while (-not $proc.HasExited) {
    if ($timer.Elapsed.TotalSeconds -gt 60) {
      & taskkill.exe /F /T /PID $proc.Id | Out-Null
      Fail "$Label timed out after 60 seconds"
    }
    $pids = @([uint32]$proc.Id)
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue
    foreach ($child in $children) { $pids += [uint32]$child.ProcessId }
    foreach ($hit in [HqWindowProbe]::VisibleFor($pids)) {
      if (-not $visible.Contains($hit)) { $visible.Add($hit) }
    }
    Start-Sleep -Milliseconds 50
  }
  return [ordered]@{
    exit_code = $proc.ExitCode
    stdout = $proc.StandardOutput.ReadToEnd()
    stderr = $proc.StandardError.ReadToEnd()
    visible = @($visible)
  }
}

Save-Summary

function Get-PeMachine([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 0x40 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    Fail "Installed application is not a PE file: $Path"
  }
  $pe = [BitConverter]::ToInt32($bytes, 0x3C)
  return [BitConverter]::ToUInt16($bytes, $pe + 4)
}

try {
  if (-not $env:GH_TOKEN) { Fail "GH_TOKEN is empty; cannot read the public release API" }

  $headers = @{
    Authorization = "Bearer $($env:GH_TOKEN)"
    Accept = "application/vnd.github+json"
    "User-Agent" = "hq-windows-cold-install"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/releases/latest"
  if ($release.prerelease) {
    Fail "Latest GitHub release $($release.tag_name) is a pre-release"
  }
  $asset = $release.assets | Where-Object { $_.name -eq "HQ_x64-setup.exe" } | Select-Object -First 1
  if (-not $asset) {
    Fail "Stable release $($release.tag_name) has no HQ_x64-setup.exe asset"
  }
  $summary.release = [ordered]@{
    tag = $release.tag_name
    prerelease = [bool]$release.prerelease
    asset = $asset.name
    size = $asset.size
  }
  Save-Summary

  $installer = Join-Path $env:RUNNER_TEMP "HQ_x64-setup.exe"
  Write-Host "Downloading $($release.tag_name) $($asset.name)"
  Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $installer
  if ((Get-Item -LiteralPath $installer).Length -lt 1MB) {
    Fail "Downloaded installer is unexpectedly small"
  }

  $defaultApp = Join-Path $env:LOCALAPPDATA "HQ\hq-sync-menubar.exe"
  if (Test-Path -LiteralPath $defaultApp) {
    Fail "Runner already had $defaultApp before install; this is not a cold machine"
  }

  Write-Host "Running silent NSIS install"
  $installTimer = [Diagnostics.Stopwatch]::StartNew()
  $installProc = Start-Process -FilePath $installer -ArgumentList "/S" -Wait -PassThru
  $installTimer.Stop()
  $installExit = $installProc.ExitCode
  $summary.installer = [ordered]@{
    exit_code = $installExit
    duration_seconds = [math]::Round($installTimer.Elapsed.TotalSeconds, 3)
    path = $installer
  }
  Save-Summary
  if ($installExit -ne 0) {
    Fail "NSIS installer exited $installExit"
  }
  if (-not (Test-Path -LiteralPath $defaultApp)) {
    Fail "NSIS installer exited 0 but did not create $defaultApp"
  }

  $machine = Get-PeMachine $defaultApp
  if ($machine -ne 0x8664) {
    Fail ("Installed application is not x64 (PE machine 0x{0:X4})" -f $machine)
  }
  $summary.install_location = Split-Path -Parent $defaultApp
  $summary.binary = [ordered]@{
    path = $defaultApp
    pe_machine = "0x{0:X4}" -f $machine
  }

  $programs = [Environment]::GetFolderPath("Programs")
  $startMenu = @(
    Get-ChildItem -LiteralPath $programs -Filter "HQ.lnk" -File -Recurse -ErrorAction SilentlyContinue
  )
  $summary.start_menu = @($startMenu | ForEach-Object { $_.FullName })
  $desktop = Join-Path ([Environment]::GetFolderPath("Desktop")) "HQ.lnk"
  $summary.desktop_shortcut = $(if (Test-Path -LiteralPath $desktop) { $desktop } else { $null })
  Save-Summary
  if ($startMenu.Count -lt 1) {
    Fail "Silent install did not create a Start menu shortcut HQ.lnk under $programs"
  }

  Get-ChildItem -LiteralPath $summary.install_location -File |
    Select-Object Name, Length |
    Format-Table -AutoSize |
    Out-String |
    Set-Content -LiteralPath (Join-Path $LogRoot "install-dir.txt") -Encoding utf8

  $headlessJson = Join-Path $LogRoot "headless-install.json"
  $headlessOut = Join-Path $LogRoot "headless.stdout.txt"
  $headlessErr = Join-Path $LogRoot "headless.stderr.txt"
  $env:HQ_HEADLESS_INSTALL_DEPS = $headlessJson
  $env:HQ_CI_FIRST_LAUNCH_TELEMETRY_SUPPRESSED = "1"
  $env:HQ_SYNC_SENTRY_DSN = ""

  Write-Host "Launching headless dependency install"
  $launchTimer = [Diagnostics.Stopwatch]::StartNew()
  $launched = $false
  try {
    $appProc = Start-Process -FilePath $defaultApp -PassThru `
      -RedirectStandardOutput $headlessOut -RedirectStandardError $headlessErr
    $launched = $true
  } catch {
    Write-Host "Stdio redirect failed ($($_.Exception.Message)); launching without it"
    $appProc = Start-Process -FilePath $defaultApp -PassThru
    $launched = $true
  }
  if (-not $launched) { Fail "Failed to start $defaultApp" }

  $deadline = (Get-Date).AddMinutes(45)
  while (-not $appProc.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
  }
  if (-not $appProc.HasExited) {
    & taskkill.exe /F /T /PID $appProc.Id | Out-Null
    Fail "Headless install timed out after 45 minutes"
  }
  $launchTimer.Stop()
  $appProc.Refresh()
  $headlessExit = $appProc.ExitCode
  $headless = $null
  if (Test-Path -LiteralPath $headlessJson) {
    $headless = Get-Content -LiteralPath $headlessJson -Raw | ConvertFrom-Json
  }
  $productSeconds = $null
  if ($headless -and $null -ne $headless.duration_secs) {
    $productSeconds = [int]$headless.duration_secs
  }
  $summary.headless = [ordered]@{
    exit_code = $headlessExit
    duration_seconds = [math]::Round($launchTimer.Elapsed.TotalSeconds, 3)
    product_duration_seconds = $productSeconds
    ok = $(if ($headless) { [bool]$headless.ok } else { $false })
    error = $(if ($headless) { $headless.error } else { $null })
    result_path = $(if (Test-Path -LiteralPath $headlessJson) { $headlessJson } else { $null })
  }
  Save-Summary
  if (-not $headless) {
    Fail "Headless install exited $headlessExit without writing $headlessJson"
  }
  if ($headlessExit -ne 0 -or -not $headless.ok) {
    $why = $headless.error
    if (-not $why) { $why = "exit $headlessExit" }
    Fail "Headless dependency install failed: $why"
  }
  $summary.timings = [ordered]@{
    installer_seconds = $summary.installer.duration_seconds
    headless_dependency_install_seconds = $summary.headless.product_duration_seconds
    headless_wall_seconds = $summary.headless.duration_seconds
  }
  Save-Summary
  Write-Host ("Headless dependency install timing: {0} s (wall {1} s)" -f $summary.timings.headless_dependency_install_seconds, $summary.timings.headless_wall_seconds)

  $hqCandidates = @(
    (Join-Path $env:LOCALAPPDATA "IndigoHQ\toolchain\npm-prefix\hq.cmd"),
    (Join-Path $env:LOCALAPPDATA "Indigo HQ\toolchain\npm-prefix\hq.cmd")
  )
  $hq = $hqCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $hq) {
    $roots = @(
      (Join-Path $env:LOCALAPPDATA "IndigoHQ"),
      (Join-Path $env:LOCALAPPDATA "Indigo HQ")
    ) | Where-Object { Test-Path -LiteralPath $_ }
    if ($roots) {
      $hq = Get-ChildItem -LiteralPath $roots -Filter "hq.cmd" -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    }
  }
  if (-not $hq) {
    Fail "Onboarding did not install hq.cmd under the managed toolchain"
  }
  $prefix = Split-Path -Parent $hq
  $nodeDir = Join-Path $env:LOCALAPPDATA "IndigoHQ\toolchain\node"
  if (Test-Path -LiteralPath $nodeDir) {
    $env:PATH = "$nodeDir;$prefix;$env:PATH"
  } else {
    $env:PATH = "$prefix;$env:PATH"
  }

  $versionText = & $hq --version 2>&1 | Out-String
  $versionExit = $LASTEXITCODE
  Set-Content -LiteralPath (Join-Path $LogRoot "hq-version.txt") -Value $versionText -Encoding utf8
  if ($versionExit -ne 0 -or [string]::IsNullOrWhiteSpace($versionText)) {
    Fail "hq --version failed (exit $versionExit): $versionText"
  }

  $doctorDir = Join-Path $env:RUNNER_TEMP "hq-doctor-cwd"
  New-Item -ItemType Directory -Force -Path $doctorDir | Out-Null
  Push-Location $doctorDir
  try {
    $doctorText = & $hq doctor 2>&1 | Out-String
    $doctorExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  Set-Content -LiteralPath (Join-Path $LogRoot "hq-doctor.txt") -Value $doctorText -Encoding utf8
  $doctorNote = $null
  if ($doctorExit -ne 0) {
    if ($doctorText -match "not inside an HQ tree") {
      $doctorNote = "needs Beaker / owner: hq doctor requires an HQ tree, and this runner has no company checkout"
    } else {
      Fail "hq doctor failed (exit $doctorExit): $doctorText"
    }
  }
  $summary.cli = [ordered]@{
    path = $hq
    version = $versionText.Trim()
    doctor_exit = $doctorExit
    doctor_note = $doctorNote
  }
  Save-Summary

  $searchRoots = @(
    $summary.install_location,
    (Join-Path $env:LOCALAPPDATA "IndigoHQ"),
    (Join-Path $env:LOCALAPPDATA "Indigo HQ"),
    (Join-Path $env:USERPROFILE ".hq"),
    (Join-Path $env:USERPROFILE ".claude")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $native = $null
  foreach ($root in $searchRoots) {
    $found = Get-ChildItem -LiteralPath $root -Filter "hq-hook.exe" -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
      Select-Object -First 1
    if ($found) { $native = $found.FullName; break }
  }
  $launcherNames = @("master-hook.sh", "hqd-hook-shim.sh")
  $outsideTree = @()
  foreach ($root in $searchRoots) {
    foreach ($name in $launcherNames) {
      $hits = @(Get-ChildItem -LiteralPath $root -Filter $name -File -Recurse -ErrorAction SilentlyContinue)
      foreach ($hit in $hits) {
        if ($hit.FullName -match '\\node_modules\\') { continue }
        if (Test-InsideHqTree $hit.FullName) { continue }
        $outsideTree += $hit.FullName
      }
    }
  }
  $shippedPath = $outsideTree | Select-Object -First 1
  $summary.hook = [ordered]@{
    searched = @($searchRoots)
    native = [ordered]@{
      binary = $native
      status = $null
      reason = $null
      exit_code = $null
      visible_windows = @()
      stdout = $null
    }
    shipped = [ordered]@{
      path = $shippedPath
      status = $null
      reason = $null
      exit_code = $null
      visible_windows = @()
      stdout = $null
    }
  }
  $pending = New-Object System.Collections.Generic.List[string]
  Save-Summary

  if (-not $native) {
    $summary.hook.native.status = "PENDING"
    $summary.hook.native.reason = "native hook binary ships with hq-cli PR 1986"
    $pending.Add("native hook binary ships with hq-cli PR 1986")
    Write-Host "PENDING: native hook binary ships with hq-cli PR 1986"
  } else {
    $fixture = Join-Path $env:RUNNER_TEMP "hq-hook-fixture"
    $hookDir = Join-Path $fixture ".claude\hooks"
    New-Item -ItemType Directory -Force -Path $hookDir | Out-Null
    $master = Join-Path $hookDir "master-hook.sh"
    $masterBody = "#!/usr/bin/env bash`ncat >/dev/null`necho fixture-ok`nexit 0`n"
    [System.IO.File]::WriteAllText($master, $masterBody.Replace("`r`n", "`n"))
    $nativeResult = Invoke-HookProcess $native "PreToolUse" @{ HQ_ROOT = $fixture } "hq-hook PreToolUse"
    Set-Content -LiteralPath (Join-Path $LogRoot "hq-hook.stdout.txt") -Value $nativeResult.stdout -Encoding utf8
    Set-Content -LiteralPath (Join-Path $LogRoot "hq-hook.stderr.txt") -Value $nativeResult.stderr -Encoding utf8
    $summary.hook.native.exit_code = $nativeResult.exit_code
    $summary.hook.native.visible_windows = @($nativeResult.visible)
    $summary.hook.native.stdout = $nativeResult.stdout.Trim()
    Save-Summary
    if ($nativeResult.visible.Count -gt 0) {
      Fail "hq-hook opened a visible window: $($nativeResult.visible[0])"
    }
    if ($nativeResult.exit_code -ne 0) {
      Fail "hq-hook PreToolUse exited $($nativeResult.exit_code): $($nativeResult.stderr)"
    }
    if ($nativeResult.stdout -notmatch "fixture-ok") {
      Fail "hq-hook PreToolUse exited 0 but did not return the fixture marker"
    }
    $summary.hook.native.status = "passed"
  }

  if (-not $shippedPath) {
    $summary.hook.shipped.status = "PENDING"
    $summary.hook.shipped.reason = "no hook path exists without an HQ tree"
    $pending.Add("no hook path exists without an HQ tree")
    Write-Host "PENDING: no hook path exists without an HQ tree"
  } else {
    $bash = @(
      (Join-Path $env:ProgramFiles "Git\bin\bash.exe"),
      (Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $bash) {
      $bashCmd = Get-Command bash.exe -ErrorAction SilentlyContinue
      if ($bashCmd) { $bash = $bashCmd.Source }
    }
    if (-not $bash) {
      Fail "Shipped hook script $shippedPath exists but bash.exe was not found"
    }
    $quoted = '"' + $shippedPath + '"'
    $shippedResult = Invoke-HookProcess $bash "$quoted PreToolUse" @{ BASH_ENV = "/dev/null" } "shipped hook PreToolUse"
    Set-Content -LiteralPath (Join-Path $LogRoot "shipped-hook.stdout.txt") -Value $shippedResult.stdout -Encoding utf8
    Set-Content -LiteralPath (Join-Path $LogRoot "shipped-hook.stderr.txt") -Value $shippedResult.stderr -Encoding utf8
    $summary.hook.shipped.exit_code = $shippedResult.exit_code
    $summary.hook.shipped.visible_windows = @($shippedResult.visible)
    $summary.hook.shipped.stdout = $shippedResult.stdout.Trim()
    Save-Summary
    if ($shippedResult.visible.Count -gt 0) {
      Fail "Shipped hook opened a visible window: $($shippedResult.visible[0])"
    }
    if ($shippedResult.exit_code -ne 0) {
      Fail "Shipped hook PreToolUse exited $($shippedResult.exit_code): $($shippedResult.stderr)"
    }
    $summary.hook.shipped.status = "passed"
  }
  $summary.pending = @($pending)

  $summary.ok = $true
  $summary.failure = $null
  Save-Summary
  # hq doctor exits 1 outside an HQ tree. GitHub's pwsh wrapper turns that
  # leftover native exit code into a failed step even after we accepted it.
  $global:LASTEXITCODE = 0
  Write-Host "Cold install passed ($($summary.release.tag))"
  exit 0
} catch {
  if (-not $summary.failure) {
    $summary.failure = (($_.Exception.Message -replace "\s+", " ").Trim())
    $summary.ok = $false
    Save-Summary
  }
  throw
}
