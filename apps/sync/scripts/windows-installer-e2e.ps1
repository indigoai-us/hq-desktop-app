[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet("install", "upgrade", "rollback", "uninstall")]
  [string]$Action,

  [string]$InstallerPath,

  [string]$HelperPath,

  [string]$TargetVersion,

  [Parameter(Mandatory)]
  [string]$InstallDir
)

$ErrorActionPreference = "Stop"

function Get-PeMachine([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "Invalid PE signature: $Path"
    }
    return $reader.ReadUInt16()
  } finally {
    $stream.Dispose()
  }
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$FailureMessage) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $FailureMessage
}

$resolvedInstallDir = [System.IO.Path]::GetFullPath($InstallDir)

if ($Action -eq "install") {
  if (-not $InstallerPath) {
    throw "InstallerPath is required for install"
  }

  $resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
  if (Test-Path -LiteralPath $resolvedInstallDir) {
    throw "InstallDir must not already exist: $resolvedInstallDir"
  }

  $process = Start-Process -FilePath $resolvedInstaller -ArgumentList @("/S", "/D=$resolvedInstallDir") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($process.ExitCode)"
  }

  Wait-Until -Condition { Test-Path -LiteralPath $resolvedInstallDir } -TimeoutSeconds 30 -FailureMessage "Installer did not create $resolvedInstallDir"

  $apps = @(Get-ChildItem -LiteralPath $resolvedInstallDir -Filter "hq-sync-menubar.exe" -File)
  if ($apps.Count -ne 1) {
    $names = ($apps | ForEach-Object Name) -join ", "
    throw "Expected one installed hq-sync-menubar.exe, found $($apps.Count): $names"
  }

  $machine = Get-PeMachine $apps[0].FullName
  if ($machine -ne 0x8664) {
    throw ("Installed application is not x64 (PE machine 0x{0:X4}): {1}" -f $machine, $apps[0].FullName)
  }

  Write-Output $apps[0].FullName
  return
}

if ($Action -eq "upgrade") {
  if (-not $InstallerPath -or -not $HelperPath -or -not $TargetVersion) {
    throw "InstallerPath, HelperPath, and TargetVersion are required for upgrade"
  }
  if (-not (Test-Path -LiteralPath $resolvedInstallDir)) {
    throw "InstallDir must contain the prior version before upgrade: $resolvedInstallDir"
  }

  $resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
  $resolvedHelper = (Resolve-Path -LiteralPath $HelperPath).Path
  $apps = @(Get-ChildItem -LiteralPath $resolvedInstallDir -Filter "hq-sync-menubar.exe" -File)
  if ($apps.Count -ne 1) {
    throw "Expected one prior-version application before upgrade, found $($apps.Count)"
  }
  $installedApp = $apps[0].FullName
  $oldHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedApp).Hash

  $stageDir = Join-Path $env:RUNNER_TEMP "hq-update-helper-e2e-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  $stagedHelper = Join-Path $stageDir "hq-update-helper.exe"
  $stagedInstaller = Join-Path $stageDir "hq-update-installer.exe"
  Copy-Item -LiteralPath $resolvedHelper -Destination $stagedHelper
  Copy-Item -LiteralPath $resolvedInstaller -Destination $stagedInstaller
  $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedInstaller).Hash.ToLowerInvariant()
  $helperHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedHelper).Hash
  $readyFile = Join-Path $stageDir "helper.ready"
  $receiptFile = Join-Path $stageDir "receipt.json"

  $parent = Start-Process -FilePath $installedApp -PassThru
  Start-Sleep -Seconds 2
  if ($parent.HasExited) {
    throw "Prior-version application exited before the upgrade handoff"
  }

  $helperArgs = @(
    "--hq-update-helper",
    "--parent-pid", $parent.Id,
    "--installer", $stagedInstaller,
    "--expected-sha256", $expectedHash,
    "--ready-file", $readyFile,
    "--receipt-file", $receiptFile,
    "--original-exe", $installedApp,
    "--target-version", $TargetVersion
  )
  $helper = Start-Process -FilePath $stagedHelper -ArgumentList $helperArgs -PassThru
  Wait-Until -Condition { Test-Path -LiteralPath $readyFile } -TimeoutSeconds 15 -FailureMessage "Update helper did not become ready"

  $hashWhileParentRuns = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedApp).Hash
  if ($hashWhileParentRuns -ne $oldHash) {
    throw "Installer modified the application before the parent exited"
  }
  if ($helper.HasExited) {
    throw "Update helper exited while the prior-version parent was still running"
  }

  Stop-Process -Id $parent.Id -Force
  $parent.WaitForExit()
  if (-not $helper.WaitForExit(120000)) {
    Stop-Process -Id $helper.Id -Force -ErrorAction SilentlyContinue
    throw "Update helper did not finish within 120 seconds"
  }
  if ($helper.ExitCode -ne 0) {
    $receipt = if (Test-Path -LiteralPath $receiptFile) { Get-Content -LiteralPath $receiptFile -Raw } else { "missing" }
    throw "Update helper exited with code $($helper.ExitCode); receipt=$receipt"
  }

  Wait-Until -Condition { Test-Path -LiteralPath $installedApp } -TimeoutSeconds 30 -FailureMessage "Upgrade did not restore the installed application"
  $receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
  if ($receipt.state -ne "installed" -or $receipt.version -ne $TargetVersion) {
    throw "Unexpected update receipt: $($receipt | ConvertTo-Json -Compress)"
  }
  $upgradedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedApp).Hash
  if ($upgradedHash -eq $oldHash) {
    throw "Upgrade left the prior-version binary in place"
  }
  $installedVersion = (Get-Item -LiteralPath $installedApp).VersionInfo.ProductVersion
  if (-not $installedVersion -or -not $installedVersion.StartsWith($TargetVersion, [StringComparison]::Ordinal)) {
    throw "Upgraded application version '$installedVersion' does not match target '$TargetVersion'"
  }
  Write-Host "Upgrade identity: old=$oldHash helper=$helperHash installed=$upgradedHash version=$installedVersion"

  Get-Process -Name "hq-sync-menubar" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Path -eq $installedApp) {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Output $installedApp
  return
}

if ($Action -eq "rollback") {
  if (-not $HelperPath -or -not $TargetVersion) {
    throw "HelperPath and TargetVersion are required for rollback"
  }
  $installedApp = Join-Path $resolvedInstallDir "hq-sync-menubar.exe"
  if (-not (Test-Path -LiteralPath $installedApp)) {
    throw "Installed application is required for rollback: $installedApp"
  }
  $beforeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedApp).Hash
  $stageDir = Join-Path $env:RUNNER_TEMP "hq-update-rollback-e2e-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  $stagedHelper = Join-Path $stageDir "hq-update-helper.exe"
  $failingInstaller = Join-Path $stageDir "hq-update-installer.exe"
  Copy-Item -LiteralPath (Resolve-Path -LiteralPath $HelperPath).Path -Destination $stagedHelper
  Copy-Item -LiteralPath (Join-Path $env:WINDIR "System32\where.exe") -Destination $failingInstaller
  $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $failingInstaller).Hash.ToLowerInvariant()
  $readyFile = Join-Path $stageDir "helper.ready"
  $receiptFile = Join-Path $stageDir "receipt.json"
  $helperArgs = @(
    "--hq-update-helper",
    "--parent-pid", ([uint32]::MaxValue),
    "--installer", $failingInstaller,
    "--expected-sha256", $expectedHash,
    "--ready-file", $readyFile,
    "--receipt-file", $receiptFile,
    "--original-exe", $installedApp,
    "--target-version", $TargetVersion
  )
  $helper = Start-Process -FilePath $stagedHelper -ArgumentList $helperArgs -PassThru
  if (-not $helper.WaitForExit(30000)) {
    Stop-Process -Id $helper.Id -Force -ErrorAction SilentlyContinue
    throw "Rollback helper did not finish within 30 seconds"
  }
  if ($helper.ExitCode -eq 0) {
    throw "Failing installer fixture unexpectedly succeeded"
  }
  $receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
  if ($receipt.state -ne "rolled-back" -or $receipt.version -ne $TargetVersion) {
    throw "Unexpected rollback receipt: $($receipt | ConvertTo-Json -Compress)"
  }
  $afterHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedApp).Hash
  if ($afterHash -ne $beforeHash) {
    throw "Rollback did not restore the prior application binary"
  }
  Wait-Until -Condition {
    @(Get-Process -Name "hq-sync-menubar" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedApp }).Count -gt 0
  } -TimeoutSeconds 15 -FailureMessage "Rollback did not relaunch the prior application"
  Get-Process -Name "hq-sync-menubar" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Path -eq $installedApp) {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host "Rollback restored and relaunched: $installedApp"
  return
}

if (-not (Test-Path -LiteralPath $resolvedInstallDir)) {
  Write-Host "Install directory already removed: $resolvedInstallDir"
  return
}

$uninstallers = @(Get-ChildItem -LiteralPath $resolvedInstallDir -Filter "*uninstall*.exe" -File)
if ($uninstallers.Count -ne 1) {
  $names = ($uninstallers | ForEach-Object Name) -join ", "
  throw "Expected one uninstaller, found $($uninstallers.Count): $names"
}

$process = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList @("/S") -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "NSIS uninstaller exited with code $($process.ExitCode)"
}

Wait-Until -Condition { -not (Test-Path -LiteralPath $resolvedInstallDir) } -TimeoutSeconds 30 -FailureMessage "Uninstaller did not remove $resolvedInstallDir"
