# Wave 8F — HQ-DESKTOP-3J watcher SIGKILL

Date: 2026-07-22

Sentry issue: `7625630778`

## Finding

This was an HQ-initiated watchdog recovery, not evidence of an OOM kill,
force-quit, or runner crash. The recorded `signal=Some(9)` at `uptime 5m5s`
matches the auto-sync daemon's `DAEMON_HEARTBEAT_TIMEOUT` (5 minutes) followed
by its intentional SIGTERM-to-SIGKILL grace interval (5 seconds).

The watchdog cancels a watcher that has emitted no sync-protocol heartbeat so
the supervisor can replace it. Its normal recovery path checks every 30
seconds and starts a replacement whenever realtime sync remains enabled.

## Root cause

`cancel_process_impl` marked the process as cancelled before delivering
SIGTERM. If the process ignored SIGTERM, its escalation thread sent SIGKILL and
removed the process-registry entry before `run_process_impl` delivered the
terminal `ProcessEvent::Exit`. The watcher Exit handler then observed
`is_cancelled(...) == false` and captured the intentional signal 9 as an
unexpected termination.

This is a classification/lifecycle bug, not a missing restart policy. The
shared termination fingerprint is correct and must remain:

```text
["sync", "auto-sync-watcher-termination", "signal:9"]
```

It keeps real OS SIGKILL events separate from plain runner exits. The fix only
suppresses this app-owned cancellation path; an external SIGKILL still has no
cancellation marker and remains captured with the same signal fingerprint.

## Fix

The process helper now retains the registry entry until after terminal Exit
observers run. All deliberate shutdown paths mark the entry cancelled and no
longer remove it before that callback. This makes watchdog SIGKILL a clean
recoverable restart while preserving capture for OOM/force-quit/external kill.

Regression coverage starts a TERM-ignoring process, forces the SIGKILL
escalation, and asserts that its Exit callback receives `signal=9` with
`cancelled=true`.

## Resolution

Do **not** resolve issue `7625630778` with `-n` yet: the classification fix
requires release before the issue can be closed. No Sentry state was changed
during this audit.

## Verification

- `rustfmt --check apps/sync/src-tauri/src/commands/process.rs`
- `git diff --check`
- Focused desktop test command:
  `cargo test --bin hq-sync-menubar sigkill_escalation_remains_cancelled_during_exit_callback`
  is blocked in this Linux environment because GTK development packages
  (`glib-2.0`, `gobject-2.0`, and `gio-2.0`) are unavailable to `pkg-config`.
- `cargo test -p hq-desktop-core termination_fingerprint --lib` — passed
  (2 tests).
