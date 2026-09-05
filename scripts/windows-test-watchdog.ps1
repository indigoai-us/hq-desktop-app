[CmdletBinding()]
param(
  [ValidateRange(1, 1800)]
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"

function Get-ProcessRow([uint32]$ProcessId) {
  return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

# The ancestor chain of this shell, with each creator's liveness. A test
# process that terminates itself through a stale parent-pid link (run
# 33940409752) is only explicable against this chain, so record it up front
# where it costs nothing and cannot be lost with the test process.
function Write-AncestorChain {
  $seen = @{}
  $row = Get-ProcessRow $PID
  Write-Host "Watchdog shell ancestor chain (pid <- creator pid, creator liveness):"
  while ($null -ne $row -and -not $seen.ContainsKey($row.ProcessId)) {
    $seen[$row.ProcessId] = $true
    $parent = Get-ProcessRow $row.ParentProcessId
    $liveness = if ($null -eq $parent) { "creator exited" } else { "creator alive: $($parent.Name)" }
    Write-Host "  $($row.Name) pid $($row.ProcessId) <- $($row.ParentProcessId) ($liveness)"
    $row = $parent
  }
}

# Do not redirect cargo's output: -NoNewWindow leaves its diagnostics attached
# to the Actions console, where they remain live and are preserved in the log.
#
# `--nocapture` streams every test's own stdout/stderr live. When the test
# process dies mid-run the harness reports only "test exited abnormally", with
# no test name, and every captured line dies with the process; the tests' own
# stderr (fixture diagnostics, `[process]` refusals, panics on spawned threads)
# is then the only record of what was in flight.
$cargoArguments = @(
  "test",
  "--target",
  "x86_64-pc-windows-msvc",
  "--bins",
  "--",
  "--nocapture"
)

Write-AncestorChain
Write-Host "Starting the Windows test suite with a $TimeoutSeconds-second process-tree deadline."
$cargo = Start-Process -FilePath "cargo" -ArgumentList $cargoArguments -NoNewWindow -PassThru

if ($cargo.WaitForExit($TimeoutSeconds * 1000)) {
  Write-Host "cargo test exited with code $($cargo.ExitCode) after $([int]($cargo.ExitTime - $cargo.StartTime).TotalSeconds) seconds."
  if ($cargo.ExitCode -ne 0) {
    # Surviving descendants of this shell are fixture processes the test
    # binary owned when it died; name them so an abnormal exit is attributable.
    $descendants = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $PID -or $_.ParentProcessId -eq $cargo.Id }
    foreach ($survivor in $descendants) {
      Write-Host "Surviving process after cargo exit: $($survivor.Name) pid $($survivor.ProcessId) <- $($survivor.ParentProcessId): $($survivor.CommandLine)"
    }
  }
  exit $cargo.ExitCode
}

Write-Host "Windows tests exceeded their $TimeoutSeconds-second deadline; terminating cargo process tree rooted at PID $($cargo.Id)."
& taskkill.exe /PID $cargo.Id /T /F
$taskkillExitCode = $LASTEXITCODE

if (-not $cargo.WaitForExit(30000)) {
  Write-Error "cargo PID $($cargo.Id) remained alive for 30 seconds after taskkill.exe attempted to terminate its process tree."
}

if ($taskkillExitCode -ne 0) {
  Write-Error "taskkill.exe could not terminate cargo PID $($cargo.Id) and its descendants (exit code $taskkillExitCode)."
}

Write-Error "Windows tests exceeded their $TimeoutSeconds-second process-tree deadline; cargo and its descendants were terminated."
exit 1
