[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet("install", "upgrade", "rollback", "uninstall")]
  [string]$Action,

  [string]$InstallerPath,

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

function Get-InstallManifest([string]$Root) {
  return @(
    Get-ChildItem -LiteralPath $Root -File -Recurse -Force |
      ForEach-Object {
        [ordered]@{
          relative = [System.IO.Path]::GetRelativePath($Root, $_.FullName)
          sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        }
      } |
      Sort-Object -Property relative
  )
}

function Write-InstallManifest([string]$Root, [string]$Path) {
  $manifest = Get-InstallManifest -Root $Root
  if ($manifest.Count -eq 0) {
    throw "Installation backup is empty: $Root"
  }
  $json = ConvertTo-Json -InputObject $manifest -Compress -Depth 4 -AsArray
  Set-Content -LiteralPath $Path -Value $json -Encoding utf8NoBOM -NoNewline
}

function Copy-InstallTree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Export-UninstallRegistry([string]$Path) {
  & reg.exe export "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\HQ" $Path /y | Out-Host
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Path)) {
    throw "Could not export prior uninstall registry metadata"
  }
}

function Get-ShortcutManifest([string]$InstalledApp) {
  $roots = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("Programs")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  return @(
    $roots | ForEach-Object {
      Get-ChildItem -LiteralPath $_ -Filter "HQ.lnk" -File -Recurse -ErrorAction SilentlyContinue
    } | ForEach-Object {
      [ordered]@{
        path = $_.FullName
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
      }
    } | Sort-Object -Property path
  )
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
  if (-not $InstallerPath -or -not $TargetVersion) {
    throw "InstallerPath and TargetVersion are required for upgrade"
  }
  if (-not (Test-Path -LiteralPath $resolvedInstallDir)) {
    throw "InstallDir must contain the prior version before upgrade: $resolvedInstallDir"
  }

  $resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
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
  $installBackup = Join-Path $stageDir "prior-install"
  $installManifest = Join-Path $stageDir "prior-install-manifest.json"
  $registryBackup = Join-Path $stageDir "prior-uninstall.reg"
  # Production always copies the installed parent itself as the helper. The
  # bridge package installed by this job contains the PR implementation, so
  # this proves the same-version parent/helper path used by future updates.
  Copy-Item -LiteralPath $installedApp -Destination $stagedHelper
  Copy-Item -LiteralPath $resolvedInstaller -Destination $stagedInstaller
  Copy-InstallTree -Source $resolvedInstallDir -Destination $installBackup
  Write-InstallManifest -Root $installBackup -Path $installManifest
  Export-UninstallRegistry -Path $registryBackup
  $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedInstaller).Hash.ToLowerInvariant()
  $helperHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedHelper).Hash
  if ($helperHash -ne $oldHash) {
    throw "Staged helper is not the installed parent binary"
  }
  $expectedManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installManifest).Hash.ToLowerInvariant()
  $expectedRegistryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $registryBackup).Hash.ToLowerInvariant()
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
    "--install-dir", $resolvedInstallDir,
    "--install-backup", $installBackup,
    "--install-manifest", $installManifest,
    "--expected-manifest-sha256", $expectedManifestHash,
    "--uninstall-registry-backup", $registryBackup,
    "--expected-registry-sha256", $expectedRegistryHash,
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
  if (-not $TargetVersion) {
    throw "TargetVersion is required for rollback"
  }
  $installedApp = Join-Path $resolvedInstallDir "hq-sync-menubar.exe"
  if (-not (Test-Path -LiteralPath $installedApp)) {
    throw "Installed application is required for rollback: $installedApp"
  }
  $beforeManifest = ConvertTo-Json -InputObject (Get-InstallManifest -Root $resolvedInstallDir) -Compress -Depth 4 -AsArray
  $beforeShortcuts = ConvertTo-Json -InputObject (Get-ShortcutManifest -InstalledApp $installedApp) -Compress -Depth 4 -AsArray
  $stageDir = Join-Path $env:RUNNER_TEMP "hq-update-rollback-e2e-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  $stagedHelper = Join-Path $stageDir "hq-update-helper.exe"
  $failingInstaller = Join-Path $stageDir "hq-update-installer.exe"
  $installBackup = Join-Path $stageDir "prior-install"
  $installManifest = Join-Path $stageDir "prior-install-manifest.json"
  $registryBackup = Join-Path $stageDir "prior-uninstall.reg"
  Copy-Item -LiteralPath $installedApp -Destination $stagedHelper
  Copy-Item -LiteralPath (Join-Path $env:WINDIR "System32\where.exe") -Destination $failingInstaller
  Copy-InstallTree -Source $resolvedInstallDir -Destination $installBackup
  Write-InstallManifest -Root $installBackup -Path $installManifest
  Export-UninstallRegistry -Path $registryBackup
  $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $failingInstaller).Hash.ToLowerInvariant()
  $expectedManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installManifest).Hash.ToLowerInvariant()
  $expectedRegistryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $registryBackup).Hash.ToLowerInvariant()
  $readyFile = Join-Path $stageDir "helper.ready"
  $receiptFile = Join-Path $stageDir "receipt.json"

  # Simulate an installer that destroyed every installed file and rewrote its
  # Add/Remove Programs metadata before exiting non-zero. Rollback must restore
  # the complete tree, not merely the main executable, and must remove values
  # introduced by the failed candidate.
  Remove-Item -LiteralPath $resolvedInstallDir -Recurse -Force
  New-Item -ItemType Directory -Path $resolvedInstallDir | Out-Null
  Set-Content -LiteralPath (Join-Path $resolvedInstallDir "failed-install.txt") -Value "corrupt"
  & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\HQ" /v DisplayVersion /t REG_SZ /d "broken" /f | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Rollback fixture could not corrupt DisplayVersion"
  }
  & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\HQ" /v HqRollbackFixture /t REG_SZ /d "broken" /f | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Rollback fixture could not add candidate-only registry metadata"
  }
  $helperArgs = @(
    "--hq-update-helper",
    "--parent-pid", ([uint32]::MaxValue),
    "--installer", $failingInstaller,
    "--expected-sha256", $expectedHash,
    "--ready-file", $readyFile,
    "--receipt-file", $receiptFile,
    "--original-exe", $installedApp,
    "--install-dir", $resolvedInstallDir,
    "--install-backup", $installBackup,
    "--install-manifest", $installManifest,
    "--expected-manifest-sha256", $expectedManifestHash,
    "--uninstall-registry-backup", $registryBackup,
    "--expected-registry-sha256", $expectedRegistryHash,
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
  $afterManifest = ConvertTo-Json -InputObject (Get-InstallManifest -Root $resolvedInstallDir) -Compress -Depth 4 -AsArray
  if ($afterManifest -ne $beforeManifest) {
    throw "Rollback did not restore the complete prior installation"
  }
  $restoredRegistry = Join-Path $stageDir "verified-restored-uninstall.reg"
  Export-UninstallRegistry -Path $restoredRegistry
  $restoredRegistryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $restoredRegistry).Hash.ToLowerInvariant()
  if ($restoredRegistryHash -ne $expectedRegistryHash) {
    throw "Rollback did not restore the exact prior uninstall registry metadata"
  }
  & reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\HQ" /v HqRollbackFixture *> $null
  if ($LASTEXITCODE -eq 0) {
    throw "Rollback left candidate-only registry metadata behind"
  }
  $afterShortcuts = ConvertTo-Json -InputObject (Get-ShortcutManifest -InstalledApp $installedApp) -Compress -Depth 4 -AsArray
  if ($afterShortcuts -ne $beforeShortcuts) {
    throw "Update rollback changed existing HQ shortcuts"
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
