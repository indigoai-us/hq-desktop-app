[CmdletBinding()]
param(
  [ValidateRange(1, 1800)]
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"

# Do not redirect cargo's output: -NoNewWindow leaves its diagnostics attached
# to the Actions console, where they remain live and are preserved in the log.
$cargoArguments = @(
  "test",
  "--target",
  "x86_64-pc-windows-msvc",
  "--bins"
)

Write-Host "Starting the Windows test suite with a $TimeoutSeconds-second process-tree deadline."
$cargo = Start-Process -FilePath "cargo" -ArgumentList $cargoArguments -NoNewWindow -PassThru

if ($cargo.WaitForExit($TimeoutSeconds * 1000)) {
  exit $cargo.ExitCode
}

Write-Host "Windows tests exceeded their $TimeoutSeconds-second deadline; terminating cargo process tree rooted at PID $($cargo.Id)."
& taskkill.exe /PID $cargo.Id /T /F
$taskkillExitCode = $LASTEXITCODE

if (-not $cargo.WaitForExit(30_000)) {
  Write-Error "cargo PID $($cargo.Id) remained alive for 30 seconds after taskkill.exe attempted to terminate its process tree."
}

if ($taskkillExitCode -ne 0) {
  Write-Error "taskkill.exe could not terminate cargo PID $($cargo.Id) and its descendants (exit code $taskkillExitCode)."
}

Write-Error "Windows tests exceeded their $TimeoutSeconds-second process-tree deadline; cargo and its descendants were terminated."
exit 1
