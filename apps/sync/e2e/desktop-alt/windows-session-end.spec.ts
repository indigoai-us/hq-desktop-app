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
import { readRepoFile } from './harness';
import {
  DESTROYED_STATE_PANIC,
  decideSessionEndExit,
  driveWindowsSessionEnd,
  findAbortMarker,
  isAppSpawnedChild,
  parseSessionEndOwnershipReport,
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

  it('labels WebView2 helpers apart from the rest of the process tree', () => {
    // Diagnostics only — this classifier no longer gates anything. It labels
    // the "before"/"after" child lists so a red run reads clearly.
    expect(isAppSpawnedChild('hq.exe')).toBe(true);
    expect(isAppSpawnedChild('node.exe')).toBe(true);
    // WebView2 manages its own process tree and tears it down asynchronously.
    expect(isAppSpawnedChild('msedgewebview2.exe')).toBe(false);
    expect(isAppSpawnedChild('MSEdgeWebView2.exe')).toBe(false);
  });

  it('reads the app’s ownership report, and refuses to guess when it cannot', () => {
    // The happy path: exactly what `registered_pids()` held.
    expect(
      parseSessionEndOwnershipReport(
        '{"pids":[{"handle":"hq-sync","pid":4321},{"handle":"hq-sync-daemon","pid":8765}]}',
      ),
    ).toEqual([
      { handle: 'hq-sync', pid: 4321 },
      { handle: 'hq-sync-daemon', pid: 8765 },
    ]);

    // An empty registry is a legitimate outcome and stays legible as `owned=0`.
    // It is NOT an error — the file's existence is the teardown proof, and the
    // count is reported so nobody mistakes zero for evidence.
    expect(parseSessionEndOwnershipReport('{"pids":[]}')).toEqual([]);

    // No file at all means the Windows `RunEvent::Exit` teardown never ran.
    // That is the regression this proof exists to catch, so it must throw
    // rather than degrade into an empty list.
    expect(() => parseSessionEndOwnershipReport(null)).toThrow(/teardown did not run/);

    // Anything unparseable or off-shape fails closed too.
    expect(() => parseSessionEndOwnershipReport('not json')).toThrow(/not valid JSON/);
    expect(() => parseSessionEndOwnershipReport('{"pids":"none"}')).toThrow(
      /no "pids" array/,
    );
    expect(() => parseSessionEndOwnershipReport('{"pids":[{"pid":1}]}')).toThrow(
      /malformed/,
    );
    expect(() =>
      parseSessionEndOwnershipReport('{"pids":[{"handle":"hq-sync","pid":"4321"}]}'),
    ).toThrow(/malformed/);
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

    // Report BEFORE asserting. A failed assertion aborts the test, so
    // diagnostics printed after it never reach the log — which turns a red run
    // into a guessing game about what was actually observed.
    const diagnostics = [
      `windows=${observed.windowCount}`,
      `query_delivered=${observed.queryEndSessionDelivered}`,
      `end_delivered=${observed.endSessionDelivered}`,
      `follow_up=${observed.followUpPosted}`,
      `exit=${observed.exitCode}`,
      `exited_in_deadline=${observed.exitedWithinDeadline}`,
      `destroyed_panic=${observed.observedDestroyedStatePanic}`,
      `abort_marker=${observed.observedAbortMarker}`,
      `children_before=${observed.observedChildCountBefore}[${observed.observedChildNamesBefore.join(' ')}]`,
      `children_after=${observed.survivingChildCount}[${observed.survivingChildNames.join(' ')}]`,
      `app_spawned_after=${observed.survivingAppSpawnedChildCount}`,
      `owned_report=${observed.ownedPidsReportPresent}`,
      `owned=${observed.ownedPidCount}`,
      `owned_alive=${observed.survivingOwnedPidCount}`,
      `owned_report_error=${observed.ownedPidsReportError ?? 'none'}`,
    ].join(' ');
    // eslint-disable-next-line no-console
    console.log(`[session-end] ${diagnostics}`);

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
    // fires at session end, the children the app spawned itself (the `--watch`
    // sync daemon, the recall sidecar — each in its own process group, so the
    // OS does not reap them) were never terminated.
    //
    // Gated on OWNERSHIP, which the app declares itself, not on process names.
    // Two reasons a name-based scope cannot work here:
    //
    //  - It over-claims. `resolve_bin("npx")` picks up `npx.cmd`, and Rust
    //    batch-dispatches a `.cmd` through `cmd.exe`, so an npx child of the app
    //    shows up in `Win32_Process` as a plain `cmd.exe`. Those particular
    //    children come from `materialize_hq_cloud_cache`, which runs a bare
    //    `std::process::Command` and is never entered in the process registry —
    //    so `terminate_all_for_exit` has never owned them, and an ordinary tray
    //    Quit orphans them identically. Pre-existing, and out of scope for a
    //    fatal-panic fix (recorded in the PR body, not hidden).
    //  - It is unsound after the fact. Re-querying `ParentProcessId=<app pid>`
    //    once the app has exited asks about whatever now holds that number.
    //
    // The report's EXISTENCE is the primary gate and does not depend on the
    // count: it is written from inside the Windows `RunEvent::Exit` teardown,
    // so deleting that arm, its cfg gate, or the teardown call fails this spec
    // even on a runner where the app owned nothing. `owned=` is logged
    // explicitly so an empty registry reads as `owned=0` rather than as proof.
    expect(observed.ownedPidsReportError, diagnostics).toBeNull();
    expect(
      observed.ownedPidsReportPresent,
      `the app wrote no session-end ownership report — its Windows RunEvent::Exit teardown did not run; ${diagnostics}`,
    ).toBe(true);
    expect(
      observed.survivingOwnedPidCount,
      `children the app declared it owns survived the session end; ${diagnostics}`,
    ).toBe(0);
  });

  /**
   * HQ-DESKTOP-4N — the query phase, driven on its own against the real binary.
   *
   * Windows announces a session end in two steps: `WM_QUERYENDSESSION` asks
   * whether one may proceed, and only `WM_ENDSESSION(TRUE)` commits it. The
   * query is revocable — `WM_ENDSESSION(FALSE)` withdraws it — so nothing in
   * the app may treat a bare query as a session end. That invariant is what
   * lets the watcher-exit attribution record a live query phase as a diagnostic
   * (`unattributed_query_only`) without ever letting it suppress an alert.
   *
   * The scripted Rust layer pins that decision on every OS and, through the
   * windows-check job's msvc test runs, on real Windows. What it cannot prove is
   * that the query is actually DELIVERED to the built binary's window
   * procedures and survived by the running app — which is what this case adds.
   *
   * It drives the committed end afterwards in the same run, so exactly one app
   * instance is ever up (`tauri_plugin_single_instance` folds a second launch
   * into the first) and the app is always cleaned up.
   */
  it('survives a bare WM_QUERYENDSESSION and only ends on the committed one', async () => {
    if (live.blockedReason) {
      throw new Error(
        `live session-end proof was requested but cannot run: ${live.blockedReason}`,
      );
    }
    if (!live.enabled || !live.appPath) {
      return;
    }

    const observed = await driveWindowsSessionEnd({
      appPath: live.appPath,
      queryOnlyFirst: true,
    });

    const diagnostics = [
      `query_only_delivered=${observed.queryOnly?.queryDelivered}`,
      `query_only_survived=${observed.queryOnly?.survived}`,
      `query_only_windows_after=${observed.queryOnly?.windowCountAfter}`,
      `windows=${observed.windowCount}`,
      `query_delivered=${observed.queryEndSessionDelivered}`,
      `exit=${observed.exitCode}`,
      `exited_in_deadline=${observed.exitedWithinDeadline}`,
      `destroyed_panic=${observed.observedDestroyedStatePanic}`,
      `abort_marker=${observed.observedAbortMarker}`,
    ].join(' ');
    // eslint-disable-next-line no-console
    console.log(`[session-end query-only] ${diagnostics}`);

    expect(observed.queryOnly, diagnostics).not.toBeNull();
    // The query has to have actually landed, or "the app survived" proves
    // nothing — an undelivered message is survived trivially.
    expect(observed.queryOnly?.queryDelivered, diagnostics).toBeGreaterThan(0);
    // The claim: a revocable query is not a session end. The app is still
    // running and still owns its windows.
    expect(observed.queryOnly?.survived, diagnostics).toBe(true);
    expect(observed.queryOnly?.windowCountAfter, diagnostics).toBeGreaterThan(0);
    // And it did not half-tear-down either: no panic, no abort.
    expect(observed.observedDestroyedStatePanic, diagnostics).toBe(false);
    expect(observed.observedAbortMarker, diagnostics).toBe(false);

    // The committed end that follows still does what HQ-DESKTOP-44 requires,
    // proving the query left the app in a working state rather than a wedged
    // one that would have exited anyway.
    expect(observed.exitedWithinDeadline, diagnostics).toBe(true);
    expect(observed.exitCode, diagnostics).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session-terminate reporting boundary (HQ-DESKTOP-5J)
// ---------------------------------------------------------------------------
//
// A DIFFERENT defect on the same Windows exit seam: an ordinary user sign-out
// kills the windowless auto-sync child with DBG_TERMINATE_PROCESS (0x40010004)
// and delivers no window message, so none of the three positive suppressors (an
// observed WM_ENDSESSION, a contemporaneous durable latch, a probe-confirmed
// teardown) can fire — and the teardown probe's `Absent` verdict then labelled it
// with the confident-sounding `unattributed_no_teardown` on the strength of a
// query whose providers cannot see a logoff at all. The residual was one
// error-level "auto-sync watcher exited unexpectedly … consecutive failure #1"
// alert per sign-out (issue HQ-DESKTOP-5J, all events on DESKTOP-QOH7J4N).
//
// The fix moves the REPORTING BOUNDARY rather than adding a fourth evidence
// source (the move that had already been tried twice): the first unconfirmed
// session-terminate exit of an app run is the benign sign-out (local log only),
// and only a SECOND within the same run — where the app is provably still alive,
// so its session did not end — escalates, on a distinct anomaly fingerprint.
//
// Same two layers as HQ-DESKTOP-44 above: source contracts over the shipping
// Rust, and a both-directions envelope model. Both run on Linux/macOS CI with no
// Windows host.

const coreSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

describe('session-terminate reporting boundary — source contracts', () => {
  it('routes the disposition through a pure per-run counter, not a fourth evidence source', () => {
    // The three-way disposition and its pure transition ship in the core, keeping
    // the impure daemon layer down to storing a single number.
    expect(coreSource).toContain('pub enum DeferredSessionEndDisposition');
    expect(coreSource).toContain('DropSuppressed');
    expect(coreSource).toContain('DropFirstUnconfirmed');
    expect(coreSource).toContain('EscalateRepeatedUnconfirmed');
    expect(coreSource).toContain('pub fn resolve_deferred_session_end_disposition(');
    // The evidence gate is UNCHANGED — the fix layers on top of it, it does not
    // invent a new positive-confirmation source (a standing non-goal).
    expect(coreSource).toContain('pub fn deferred_session_end_outcome(');
    expect(coreSource).not.toContain('WTSQuerySessionInformation');
  });

  it('gates the teardown verdict `Absent` on SM_SHUTTINGDOWN alone, and says so honestly', () => {
    // Absent still requires BOTH samples to be an explicit `No` (never Unavailable).
    expect(coreSource).toContain('reading.shuttingdown_at_exit == TeardownShuttingDown::No');
    expect(coreSource).toContain('reading.shuttingdown_at_resolve == TeardownShuttingDown::No');
    // And the doc no longer over-claims "positive negative evidence from every
    // source" — the System channel cannot observe a logoff, so it is supporting.
    expect(coreSource).not.toContain('positive negative evidence from *every* source');
    expect(coreSource).toContain('load-bearing on `SM_SHUTTINGDOWN` ALONE');
  });

  it('keeps an OS session teardown out of the crash-loop counter and respawn backoff', () => {
    // The deferral shape passes the flag; a crash/fault exit passes false.
    expect(daemonSource).toContain('deferring_external_session_teardown');
    expect(daemonSource).toContain(
      'effects.note_watcher_crashed(deferring_external_session_teardown)',
    );
    expect(coreSource).toContain('pub fn is_windows_session_terminate_watcher_exit(');
    // The counter itself is read/stored, not mutated inline with the decision.
    expect(daemonSource).toContain('static SESSION_TERMINATE_UNCONFIRMED_RUN_COUNT: AtomicU32');
    expect(daemonSource).toContain('fn classify_resolved_session_terminate(');
  });

  it('escalates a repeat on a DISTINCT fingerprint that names the anomaly', () => {
    expect(daemonSource).toContain('fn escalate_repeated_session_terminate_capture(');
    // A NEW group, never a reuse of the benign per-sign-out shape.
    expect(daemonSource).toContain('"auto-sync-watcher-repeated-session-terminate"');
    // Carrying the bounded run count as an egress-allow-listed integer extra.
    expect(daemonSource).toContain('"session_terminate_unconfirmed_run_count"');
    expect(telemetrySource).toContain('"session_terminate_unconfirmed_run_count" =>');
  });

  it('resets the per-run counter at the confirmed Windows session-end teardown', () => {
    expect(daemonSource).toContain('fn reset_session_terminate_unconfirmed_run_count(');
    // The reset is wired into the teardown drop path (a confirmed session end).
    const dropFn = daemonSource.slice(
      daemonSource.indexOf('pub fn drop_pending_session_end_captures('),
    );
    expect(dropFn.slice(0, 600)).toContain('reset_session_terminate_unconfirmed_run_count()');
  });
});

// ---------------------------------------------------------------------------
// Artifact-level envelope model (both directions)
// ---------------------------------------------------------------------------

type Policy = 'pre-fix' | 'post-fix';

interface SessionTerminateEnvelope {
  message: string;
  fingerprint: string[];
  tags: Record<string, string>;
  extras: Record<string, string | number>;
  level: 'error' | 'info';
  /** Whether an error-level Sentry event actually reaches the wire. */
  sent: boolean;
}

/** One resolved deferral's evidence, as the resolver reads it after the grace. */
interface Resolution {
  /** A positive suppressor fired: observed message, contemporaneous latch, or a
   *  probe-confirmed teardown. */
  suppressed: boolean;
  /** The resolved windows_terminator reading (fixed vocabulary). */
  terminator: string;
  teardownVerdict: 'teardown_confirmed' | 'teardown_absent' | 'teardown_unknown';
  shuttingdown: 'yes' | 'no' | 'unavailable';
  teardownLog: 'kernel_general_13' | 'kernel_power_109' | 'user32_1074' | 'none' | 'unavailable';
  latch: 'latched' | 'absent' | 'unavailable';
}

const BENIGN_FINGERPRINT = [
  'sync',
  'auto-sync-watcher-termination',
  'windows:session-terminate',
  'none',
  'none',
  'none',
];
const ESCALATION_FINGERPRINT = ['sync', 'auto-sync-watcher-repeated-session-terminate'];

/** The benign per-sign-out capture the exit path builds — the exact reported
 *  HQ-DESKTOP-5J 0.10.108 envelope shape. */
function benignEnvelope(res: Resolution): SessionTerminateEnvelope {
  return {
    message:
      'auto-sync watcher exited unexpectedly (with Windows status 0x40010004 ' +
      '(session terminate)), consecutive failure #1',
    fingerprint: [...BENIGN_FINGERPRINT],
    tags: {
      windows_exit_status: '0x40010004',
      windows_exit_class: 'session_terminate',
      windows_terminator: res.terminator,
      sync_route: 'watcher',
      path: '(auto-sync)',
      watcher_child_kind: 'cmd_shim',
      runner_fatal_class: 'none',
    },
    extras: {
      windows_teardown_probe_verdict: res.teardownVerdict,
      windows_teardown_probe_shuttingdown: res.shuttingdown,
      windows_teardown_probe_log: res.teardownLog,
      session_end_latch: res.latch,
    },
    level: 'error',
    sent: true,
  };
}

/**
 * Resolve one deferral to its emitted envelope (or a silent local-log) under a
 * policy, threading the per-run unconfirmed counter. The ONLY difference between
 * the policies is the disposition of an UNCONFIRMED exit — the payload the exit
 * path builds is identical.
 */
function resolveEnvelope(
  res: Resolution,
  priorRunCount: number,
  policy: Policy,
): { envelope: SessionTerminateEnvelope; runCount: number } {
  if (res.suppressed) {
    // A confirmed session end: dropped (info) in BOTH policies, and it resets the
    // per-run counter.
    return {
      envelope: { ...benignEnvelope(res), level: 'info', sent: false },
      runCount: 0,
    };
  }
  if (policy === 'pre-fix') {
    // The residual: every unconfirmed exit sends an error on the benign group.
    return { envelope: benignEnvelope(res), runCount: priorRunCount + 1 };
  }
  // post-fix: the first unconfirmed exit of a run is the benign sign-out (local
  // log only); the second and later escalate on the distinct anomaly fingerprint.
  const runCount = priorRunCount + 1;
  if (runCount <= 1) {
    return {
      envelope: { ...benignEnvelope(res), level: 'info', sent: false },
      runCount,
    };
  }
  return {
    envelope: {
      message:
        'auto-sync watcher terminated by an external session-terminate status ' +
        `(0x40010004) ${runCount} times within one app run — the app outlived its ` +
        'own session, so this is not a user sign-out',
      fingerprint: [...ESCALATION_FINGERPRINT],
      tags: {
        windows_exit_status: '0x40010004',
        windows_exit_class: 'session_terminate',
        windows_terminator: res.terminator,
        sync_route: 'watcher',
        path: '(auto-sync)',
        watcher_child_kind: 'cmd_shim',
        runner_fatal_class: 'none',
      },
      extras: {
        windows_teardown_probe_verdict: res.teardownVerdict,
        windows_teardown_probe_shuttingdown: res.shuttingdown,
        windows_teardown_probe_log: res.teardownLog,
        session_end_latch: res.latch,
        session_terminate_unconfirmed_run_count: runCount,
      },
      level: 'error',
      sent: true,
    },
    runCount,
  };
}

/** The exact reported recurrence: an ordinary sign-out — no message, no latch,
 *  and the OS not doing a system shutdown (so the probe reads Absent). */
const ORDINARY_SIGNOUT: Resolution = {
  suppressed: false,
  terminator: 'unattributed_no_teardown',
  teardownVerdict: 'teardown_absent',
  shuttingdown: 'no',
  teardownLog: 'none',
  latch: 'absent',
};

const HEX_STATUS = /^0x[0-9A-F]{8}$/;
const FIXED_TOKEN = /^[a-z0-9_()-]+$/;

describe('session-terminate reporting boundary — envelope model (both directions)', () => {
  it('pre-fix reproduces the observed HQ-DESKTOP-5J envelope verbatim', () => {
    const { envelope } = resolveEnvelope(ORDINARY_SIGNOUT, 0, 'pre-fix');
    expect(envelope.sent).toBe(true);
    expect(envelope.level).toBe('error');
    expect(envelope.fingerprint).toEqual(BENIGN_FINGERPRINT);
    expect(envelope.tags).toMatchObject({
      windows_exit_status: '0x40010004',
      windows_exit_class: 'session_terminate',
      windows_terminator: 'unattributed_no_teardown',
      sync_route: 'watcher',
      path: '(auto-sync)',
      watcher_child_kind: 'cmd_shim',
      runner_fatal_class: 'none',
    });
    expect(envelope.message).toContain('consecutive failure #1');
  });

  it('post-fix renders the SAME first sign-out as a silent local log, no error event', () => {
    const { envelope, runCount } = resolveEnvelope(ORDINARY_SIGNOUT, 0, 'post-fix');
    expect(envelope.sent).toBe(false);
    expect(envelope.level).toBe('info');
    expect(runCount).toBe(1);
  });

  it('post-fix escalates a SECOND unconfirmed exit within the run on a distinct fingerprint', () => {
    // First is silent…
    const first = resolveEnvelope(ORDINARY_SIGNOUT, 0, 'post-fix');
    expect(first.envelope.sent).toBe(false);
    // …the second sends, on a NEW group, carrying the run count and diagnostics.
    const second = resolveEnvelope(ORDINARY_SIGNOUT, first.runCount, 'post-fix');
    expect(second.envelope.sent).toBe(true);
    expect(second.envelope.level).toBe('error');
    expect(second.envelope.fingerprint).toEqual(ESCALATION_FINGERPRINT);
    expect(second.envelope.fingerprint).not.toEqual(BENIGN_FINGERPRINT);
    expect(second.envelope.extras.session_terminate_unconfirmed_run_count).toBe(2);
    // The teardown/latch diagnostics ride along so a real killer is nameable.
    expect(second.envelope.extras.windows_teardown_probe_verdict).toBe('teardown_absent');
    expect(second.envelope.extras.session_end_latch).toBe('absent');
    expect(second.envelope.message).toContain('2 times within one app run');
  });

  it('a confirmed session end is dropped in BOTH policies and resets the run counter', () => {
    const confirmed: Resolution = {
      suppressed: true,
      terminator: 'session_end_probed',
      teardownVerdict: 'teardown_confirmed',
      shuttingdown: 'yes',
      teardownLog: 'kernel_general_13',
      latch: 'absent',
    };
    for (const policy of ['pre-fix', 'post-fix'] as Policy[]) {
      const { envelope, runCount } = resolveEnvelope(confirmed, 5, policy);
      expect(envelope.sent).toBe(false);
      expect(runCount).toBe(0);
    }
    // And after the reset the next unconfirmed exit is a fresh silent first.
    const afterReset = resolveEnvelope(ORDINARY_SIGNOUT, 0, 'post-fix');
    expect(afterReset.envelope.sent).toBe(false);
    expect(afterReset.runCount).toBe(1);
  });

  it('grouping continuity: the benign group never moves, the escalation group is new', () => {
    // The still-capturing benign shape keeps its fingerprint across policies…
    expect(benignEnvelope(ORDINARY_SIGNOUT).fingerprint).toEqual(BENIGN_FINGERPRINT);
    // …and the escalation is a genuinely new group, not a reuse of it.
    expect(ESCALATION_FINGERPRINT).not.toEqual(BENIGN_FINGERPRINT);
    expect(ESCALATION_FINGERPRINT[1]).not.toBe(BENIGN_FINGERPRINT[1]);
  });

  it('content safety: every modelled envelope is fixed vocabulary, bounded ints and hex only', () => {
    const envelopes = [
      resolveEnvelope(ORDINARY_SIGNOUT, 0, 'pre-fix').envelope,
      resolveEnvelope(ORDINARY_SIGNOUT, 1, 'post-fix').envelope,
    ];
    for (const envelope of envelopes) {
      for (const part of envelope.fingerprint) {
        expect(part).toMatch(/^[a-z0-9:-]+$/);
      }
      expect(envelope.tags.windows_exit_status).toMatch(HEX_STATUS);
      for (const [key, value] of Object.entries(envelope.tags)) {
        expect(value, `${key} must be a fixed token`).toMatch(FIXED_TOKEN);
      }
      for (const [key, value] of Object.entries(envelope.extras)) {
        if (typeof value === 'number') {
          expect(Number.isInteger(value) && value >= 0, `${key} must be a bounded integer`).toBe(
            true,
          );
        } else {
          expect(value, `${key} must be a fixed token`).toMatch(FIXED_TOKEN);
        }
      }
      // No path, argv, host name, user name or company slug ever appears.
      const serialized = JSON.stringify(envelope);
      expect(serialized).not.toContain('DESKTOP-QOH7J4N');
      expect(serialized).not.toMatch(/[A-Za-z]:\\/);
      expect(serialized).not.toContain('/Users/');
    }
  });
});
