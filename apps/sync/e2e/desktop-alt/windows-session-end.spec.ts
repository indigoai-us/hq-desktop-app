/**
 * Windows session end — HQ-DESKTOP-44 artifact proof.
 *
 * The bug: at Windows session end (shutdown / logoff / forced restart) tao
 * handles `WM_ENDSESSION` by moving its event-loop runner to
 * `RunnerState::Destroyed` and returning, while leaving its own
 * `GetMessageW`/`DispatchMessageW` pump running. The next dispatched message
 * re-enters the runner, hits `panic!("cannot move state from Destroyed")`, and
 * unwinds out of an `extern "system"` window procedure — which aborts
 * `hq-sync-menubar.exe`, taking the app's teardown with it.
 *
 * Two layers of coverage, because neither alone is enough:
 *
 * - **scripted** (every OS, every CI run): holds the decision itself to
 *   account. macOS CI cannot end a Windows session, but it can prove that an
 *   OS-forced exit tears down and leaves while a user quit does neither.
 * - **live** (`HQ_SYNC_WINDOWS_SESSION_END_LIVE=1` on Windows, against the real
 *   binary): drives the actual message sequence at the actual window
 *   procedures and watches how the process leaves. This is the layer that
 *   fails on the pre-fix build and passes on the fixed one.
 *
 * Live mode never degrades to a skip. A configured-but-unrunnable live run
 * throws, because a silently skipped artifact proof reads exactly like a
 * passing one.
 */

import { describe, expect, it } from 'vitest';
import {
  DESTROYED_STATE_PANIC,
  decideSessionEndExit,
  driveWindowsSessionEnd,
  findAbortMarker,
  resolveSessionEndLiveMode,
} from './windows-reliability-harness';

const live = resolveSessionEndLiveMode();

describe('Windows session-end exit decision (HQ-DESKTOP-44)', () => {
  it('tears down and leaves when the OS ended the session', () => {
    // No `ExitRequested` preceded this `Exit`, so `WM_ENDSESSION` is the only
    // thing that can have produced it.
    const decision = decideSessionEndExit(false);

    expect(decision.reason).toBe('os-session-end');
    expect(decision.runTeardown).toBe(true);
    // Leaving is the fix: it denies tao's still-live pump the iteration that
    // would dispatch into the destroyed runner.
    expect(decision.terminateProcess).toBe(true);
  });

  it('leaves a user-initiated quit completely alone', () => {
    // tray Quit / `quit_app` / Cmd-Q / last window closed — all reach
    // `AppHandle::exit`, which raises `ExitRequested` first.
    const decision = decideSessionEndExit(true);

    expect(decision.reason).toBe('app-initiated-quit');
    // `ExitRequested` already ran this teardown, and tauri's
    // `cleanup_before_exit()` (tray icon removal, window hiding) plus tao's own
    // `process::exit(exit_code)` follow the callback. Doing either here would
    // duplicate the teardown or skip the cleanup.
    expect(decision.runTeardown).toBe(false);
    expect(decision.terminateProcess).toBe(false);
  });

  it('recognises the fatal tao panic and abort shapes', () => {
    expect(findAbortMarker(`thread panicked at ${DESTROYED_STATE_PANIC}`)).toBe(
      DESTROYED_STATE_PANIC,
    );
    // The Windows fast-fail status a Rust abort produces, as seen on this fleet.
    expect(findAbortMarker('exited with 0xC0000409')).not.toBeNull();
    expect(findAbortMarker('sync complete; 12 files changed')).toBeNull();
  });
});

describe('Windows session-end live artifact proof (HQ-DESKTOP-44)', () => {
  it('exits cleanly instead of aborting when Windows ends the session', async () => {
    if (live.blockedReason) {
      // Requested and cannot run: fail loudly. Skipping here would let a
      // misconfigured job report green while proving nothing.
      throw new Error(
        `live session-end proof was requested but cannot run: ${live.blockedReason}`,
      );
    }
    if (!live.enabled || !live.appPath) {
      // Not requested — the scripted suite above is the coverage for this run.
      return;
    }

    const observed = await driveWindowsSessionEnd({ appPath: live.appPath });

    // The probe has to have actually landed, or nothing below means anything.
    // WM_QUERYENDSESSION is the honest delivery check: it never terminates
    // anything, so it succeeds on both the broken and the fixed build. The
    // WM_ENDSESSION count deliberately is NOT asserted — on the fixed build the
    // app exits from inside that very send, which makes SendMessageTimeout
    // report failure for the window that took the branch. Delivery of
    // WM_ENDSESSION is instead proved by its effect: the process exits.
    expect(observed.windowCount).toBeGreaterThan(0);
    expect(observed.queryEndSessionDelivered).toBeGreaterThan(0);

    // The fix, stated three ways.
    expect(observed.observedDestroyedStatePanic).toBe(false);
    expect(observed.observedAbortMarker).toBe(false);
    expect(observed.exitedWithinDeadline).toBe(true);
    expect(observed.exitCode).toBe(0);

    // The second, quieter half of the defect: because `ExitRequested` never
    // fires at session end, spawned children (the `--watch` sync daemon, the
    // recall sidecar — both spawned with their own process group, so the OS
    // does not reap them) were never terminated. Zero survivors is only
    // meaningful when there was something to survive, so the before-count
    // travels with the assertion rather than being assumed.
    expect(observed.survivingChildCount).toBe(0);
    // eslint-disable-next-line no-console
    console.log(
      `[session-end] windows=${observed.windowCount} query_delivered=${observed.queryEndSessionDelivered} end_delivered=${observed.endSessionDelivered} follow_up=${observed.followUpPosted} children_before=${observed.observedChildCountBefore} children_after=${observed.survivingChildCount} exit=${observed.exitCode}`,
    );
  });
});
