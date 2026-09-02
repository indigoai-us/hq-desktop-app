param(
  [Parameter(Mandatory, Position = 0)]
  [string]$ScriptPath
)

$started = Get-Date
$stamp = $started.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Write-Host "::group::$stamp"
try {
  . $ScriptPath
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  $elapsed = (Get-Date) - $started
  Write-Host ("elapsed_seconds={0:N3} end={1}" -f $elapsed.TotalSeconds, (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
  Write-Host "::endgroup::"
}
