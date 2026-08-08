<#
.SYNOPSIS
  Drive a Windows session end at a single running process, without ending the
  real desktop session.

.DESCRIPTION
  Reproduces exactly what Windows does to an application at shutdown/logoff:
  broadcast WM_QUERYENDSESSION, then WM_ENDSESSION(wParam=TRUE), to the
  process's top-level windows — and then deliver one more ordinary posted
  message.

  That last step is the whole point. tao handles WM_ENDSESSION by moving its
  event-loop runner to RunnerState::Destroyed and returning 0, leaving its own
  GetMessageW/DispatchMessageW pump running. The NEXT dispatched message is what
  panics with "cannot move state from Destroyed" and aborts the process
  (HQ-DESKTOP-44).

  Triggering a real logoff is not an option on a CI runner — it would take the
  runner down with it — and would prove less: this drives the exact message
  sequence at the exact window procedures, and nothing else.

  tao's thread-event-target window IS reachable this way. It is created
  parentless with WS_EX_TOOLWINDOW and restyled to WS_VISIBLE|WS_POPUP, i.e. a
  real (if invisible) top-level window, not a message-only window — so it is
  enumerated here and is broadcast to by the real OS for the same reason.

.OUTPUTS
  A single JSON object on stdout. Counts and booleans only — never window text,
  command lines, paths, or user identifiers.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int] $TargetProcessId,

    # Count the target's top-level windows and send nothing. Lets the harness
    # wait for the app to actually own windows instead of sleeping a guessed
    # interval and hoping.
    [switch] $ProbeOnly,

    # Milliseconds each SendMessageTimeout may block. Session-end messages are
    # delivered synchronously, so an unbounded send would hang the harness if
    # the app wedged.
    [int] $SendTimeoutMs = 5000
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace HQSessionEnd -Name Native -MemberDefinition @'
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam,
        uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);
'@

$WM_QUERYENDSESSION = 0x0011
$WM_ENDSESSION      = 0x0016
# Follow-up messages. Either is enough on its own to make tao dispatch into its
# runner; both are sent so the probe does not depend on which window procedure
# happens to still be alive.
$WM_PAINT           = 0x000F
$WM_MOUSEMOVE       = 0x0200

# SMTO_ABORTIFHUNG (0x0002): do not wait on a process that has already stopped
# pumping — on the fixed build the target exits from inside the WM_ENDSESSION
# handler, and that is a pass, not a hang.
$SMTO_ABORTIFHUNG = 0x0002

function Get-TopLevelWindowHandles {
    param([int] $OwnerProcessId)

    $handles = New-Object System.Collections.Generic.List[IntPtr]
    $callback = [HQSessionEnd.Native+EnumWindowsProc] {
        param([IntPtr] $hWnd, [IntPtr] $lParam)
        # Must be uint32: the P/Invoke signature declares `out uint`, and a
        # [ref] to an Int32 fails to marshal.
        $windowPid = [uint32] 0
        [void][HQSessionEnd.Native]::GetWindowThreadProcessId($hWnd, [ref] $windowPid)
        if ($windowPid -eq $OwnerProcessId) {
            $handles.Add($hWnd)
        }
        return $true
    }
    [void][HQSessionEnd.Native]::EnumWindows($callback, [IntPtr]::Zero)
    return $handles
}

$windows = Get-TopLevelWindowHandles -OwnerProcessId $TargetProcessId

if ($ProbeOnly) {
    [pscustomobject]@{
        windowCount    = $windows.Count
        queryDelivered = 0
        endDelivered   = 0
        followUpPosted = 0
    } | ConvertTo-Json -Compress
    exit 0
}

if ($windows.Count -eq 0) {
    # Never degrade to a no-op success: a run that could not deliver a single
    # session-end message has proven nothing about the fix.
    throw "No top-level windows owned by process $TargetProcessId; cannot drive a session end."
}

$result = [IntPtr]::Zero
$queryDelivered = 0
$endDelivered = 0
$followUpPosted = 0

foreach ($hWnd in $windows) {
    if ([HQSessionEnd.Native]::SendMessageTimeout(
            $hWnd, $WM_QUERYENDSESSION, [IntPtr]::Zero, [IntPtr]::Zero,
            $SMTO_ABORTIFHUNG, $SendTimeoutMs, [ref] $result) -ne [IntPtr]::Zero) {
        $queryDelivered++
    }
}

foreach ($hWnd in $windows) {
    if (-not [HQSessionEnd.Native]::IsWindow($hWnd)) { continue }
    # wParam = TRUE: the session IS ending. This is the message that latches
    # tao's runner into Destroyed.
    if ([HQSessionEnd.Native]::SendMessageTimeout(
            $hWnd, $WM_ENDSESSION, [IntPtr]::new(1), [IntPtr]::Zero,
            $SMTO_ABORTIFHUNG, $SendTimeoutMs, [ref] $result) -ne [IntPtr]::Zero) {
        $endDelivered++
    }
}

foreach ($hWnd in $windows) {
    if (-not [HQSessionEnd.Native]::IsWindow($hWnd)) { continue }
    foreach ($msg in @($WM_PAINT, $WM_MOUSEMOVE)) {
        if ([HQSessionEnd.Native]::PostMessage($hWnd, $msg, [IntPtr]::Zero, [IntPtr]::Zero)) {
            $followUpPosted++
        }
    }
}

[pscustomobject]@{
    windowCount     = $windows.Count
    queryDelivered  = $queryDelivered
    endDelivered    = $endDelivered
    followUpPosted  = $followUpPosted
} | ConvertTo-Json -Compress
