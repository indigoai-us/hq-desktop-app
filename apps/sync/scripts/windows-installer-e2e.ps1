[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet("install", "uninstall")]
  [string]$Action,

  [string]$InstallerPath,

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
