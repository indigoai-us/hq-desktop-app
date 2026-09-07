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
  isAppSpawnedChild,
  parseSessionEndOwnershipReport,
  resolveSessionEndLiveMode,
} from './windows-reliability-harness';
import { readRepoFile } from './harness';

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
// HQ-DESKTOP-5J — a Windows sign-out reported as a watcher failure
// ---------------------------------------------------------------------------
//
// The bug: an ordinary Windows sign-out kills the auto-sync watcher child with
// DBG_TERMINATE_PROCESS (0x40010004). The three positive-evidence sources — the
// message observer, the durable latch, and the pull-based teardown probe — are
// each structurally incapable of confirming a user LOGOFF (the observer gets no
// window message on a forced end-session; the latch is fed by that same message;
// the probe's providers are shutdown/restart-only), so the deferral resolved to
// Capture and the supervisor sent an ERROR-level alert ("auto-sync watcher exited
// unexpectedly (with Windows status 0x40010004 (session terminate)), consecutive
// failure #1") for a benign sign-out.
//
// The fix moves the reporting boundary: an UNCONFIRMED session-terminate exit is
// DROPPED on its first per-run occurrence (the sign-out signature), and only a
// SECOND within the same app run ESCALATES to a capture on a DISTINCT fingerprint
// — so a real external killer still surfaces while an ordinary logoff never does.
//
// Two layers run on Linux/macOS CI (no Windows host required): source contracts
// over the shipping Rust, and a bidirectional envelope simulator.

const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const coreSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

describe('Windows session-end reporting boundary — source contracts (HQ-DESKTOP-5J)', () => {
  it('gives deferred_session_end_outcome a per-run count and a default-drop arm', () => {
    // The pure decision now takes the per-run unconfirmed count and drops by
    // default; deleting the count param or the escalation gate fails here.
    expect(coreSource).toContain('pub fn deferred_session_end_outcome(');
    expect(coreSource).toContain('unconfirmed_run_count: u32,');
    // The confirmed-session-end predicate is factored out and reused.
    expect(coreSource).toContain('pub fn deferred_session_end_confirmed(');
  });

  it('has a pure, bounded per-run escalation predicate (silent first, then milestones)', () => {
    expect(coreSource).toContain(
      'pub fn unconfirmed_session_terminate_escalates(run_count: u32) -> bool {',
    );
    // First per run is silent; a repeat escalates, bounded by the milestone limiter.
    expect(coreSource).toContain('run_count >= 2 && is_capture_milestone(run_count)');
  });

  it('advances the per-run counter only at resolution and resets it on a crash', () => {
    expect(daemonSource).toContain('session_terminate_unconfirmed_run: u32,');
    expect(daemonSource).toContain('fn bump_session_terminate_unconfirmed_run() -> u32 {');
    expect(daemonSource).toContain('fn reset_session_terminate_unconfirmed_run() {');
    // An ordinary crash breaks the run (reset lives inside note_watcher_crashed).
    const crashFnIdx = daemonSource.indexOf('fn note_watcher_crashed() -> u32 {');
    expect(crashFnIdx).toBeGreaterThan(0);
    expect(daemonSource.indexOf('st.session_terminate_unconfirmed_run = 0;')).toBeGreaterThan(
      crashFnIdx,
    );
  });

  it('does not advance the consecutive-failure streak for a deferred session-terminate', () => {
    // The defer branch returns BEFORE note_watcher_crashed, so an OS-supplied
    // termination never advances the streak or arms respawn backoff.
    const deferIdx = daemonSource.indexOf(
      'if capture_policy == WatcherExitCapturePolicy::DeferSessionEndDecision {',
    );
    const crashIdx = daemonSource.indexOf('let consecutive = effects.note_watcher_crashed();');
    expect(deferIdx).toBeGreaterThan(0);
    expect(crashIdx).toBeGreaterThan(deferIdx);
    // The benign deferral reports a clean stop, not a crash the user never had.
    expect(daemonSource).toContain(
      'effects.set_lifecycle_state(WatchDaemonState::Stopped, DaemonFailureCategory::None);',
    );
  });

  it('escalates onto a NEW fingerprint, never the benign session-terminate one', () => {
    expect(daemonSource).toContain('fn escalated_session_terminate_payload(');
    expect(daemonSource).toContain('"windows:session-terminate-external-killer"');
    // The escalation reuses ONLY already-allow-listed teardown/latch tokens, so no
    // new telemetry vocabulary is introduced and nothing degrades to [Filtered].
    for (const token of [
      'windows_teardown_probe_verdict',
      'windows_teardown_probe_shuttingdown',
      'windows_teardown_probe_log',
      'session_end_latch',
    ]) {
      expect(telemetrySource).toContain(`"${token}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact-level envelope model (both directions)
// ---------------------------------------------------------------------------

type Policy = 'pre-fix' | 'post-fix';

interface SentryEnvelope {
  message: string;
  fingerprint: string[];
  tags: Record<string, string>;
  level: 'error' | 'info';
  /** Whether an error-level Sentry event is actually sent (vs. local-log only). */
  sent: boolean;
}

interface Scenario {
  /** Positive OS session-end evidence at resolution (observer/latch/probe). */
  positiveEvidence: boolean;
  /** Count of unconfirmed session-terminate exits this app run, INCLUDING this. */
  unconfirmedRunCount: number;
}

/** Mirror of `is_capture_milestone`: the first, then powers of two. */
function isCaptureMilestone(n: number): boolean {
  return n <= 1 || (n > 0 && (n & (n - 1)) === 0);
}

/** Mirror of `unconfirmed_session_terminate_escalates`. */
function escalates(runCount: number): boolean {
  return runCount >= 2 && isCaptureMilestone(runCount);
}

/**
 * The fixed part of the envelope the supervisor builds for the reported
 * HQ-DESKTOP-5J 0.10.108 shape, before the reporting-boundary decision. Matches
 * the shipped fingerprint/message/tags so the both-directions comparison proves
 * ONLY the send decision (and, on escalation, the fingerprint/title) differs.
 */
function baseSessionTerminateEnvelope(): SentryEnvelope {
  return {
    message:
      'auto-sync watcher exited unexpectedly (with Windows status 0x40010004 ' +
      '(session terminate)), consecutive failure #1',
    fingerprint: [
      'sync',
      'auto-sync-watcher-termination',
      'windows:session-terminate',
      'none',
      'none',
      'none',
    ],
    tags: {
      windows_exit_status: '0x40010004',
      windows_exit_class: 'session_terminate',
      windows_terminator: 'unattributed_no_signal',
      sync_route: 'watcher',
      path: '(auto-sync)',
      watcher_child_kind: 'cmd_shim',
      runner_fatal_class: 'none',
    },
    level: 'error',
    sent: true,
  };
}

/**
 * Render the emitted envelope under a policy. The ONLY differences between the
 * two policies are (a) whether an unconfirmed exit is sent at all and (b), on the
 * post-fix escalation, the distinct fingerprint + re-titled message.
 */
function renderEnvelope(scenario: Scenario, policy: Policy): SentryEnvelope {
  const env = baseSessionTerminateEnvelope();

  // Positive evidence suppresses under BOTH policies (unchanged behaviour).
  if (scenario.positiveEvidence) {
    env.sent = false;
    env.level = 'info';
    env.tags.windows_terminator = 'session_end_probed';
    return env;
  }

  if (policy === 'pre-fix') {
    // The reported defect: every unconfirmed session-terminate is captured and
    // sent at error level, tagged with the confident-sounding no-teardown verdict.
    env.sent = true;
    env.level = 'error';
    env.tags.windows_terminator = 'unattributed_no_teardown';
    return env;
  }

  // post-fix: the first unconfirmed exit per run is a sign-out — dropped.
  if (!escalates(scenario.unconfirmedRunCount)) {
    env.sent = false;
    env.level = 'info';
    env.tags.windows_terminator = 'unattributed_no_teardown';
    return env;
  }

  // A repeat within the run: escalate onto a DISTINCT fingerprint with a re-titled
  // message; the teardown diagnostics ride along as already-allow-listed tokens.
  env.sent = true;
  env.level = 'error';
  env.fingerprint = [...env.fingerprint];
  env.fingerprint[2] = 'windows:session-terminate-external-killer';
  env.message =
    'auto-sync watcher externally terminated (Windows status 0x40010004 ' +
    `(session terminate)) ${scenario.unconfirmedRunCount} times in one app run ` +
    'with no confirmed Windows session end — not a sign-out';
  env.tags.windows_teardown_probe_verdict = 'teardown_absent';
  env.tags.windows_teardown_probe_shuttingdown = 'no';
  env.tags.windows_teardown_probe_log = 'none';
  env.tags.session_end_latch = 'absent';
  return env;
}

describe('Windows session-end reporting boundary — envelope simulator (HQ-DESKTOP-5J)', () => {
  const signOut: Scenario = { positiveEvidence: false, unconfirmedRunCount: 1 };
  const repeatKiller: Scenario = { positiveEvidence: false, unconfirmedRunCount: 2 };
  const realSessionEnd: Scenario = { positiveEvidence: true, unconfirmedRunCount: 1 };

  it('pre-fix reproduces the observed HQ-DESKTOP-5J error alert for a sign-out', () => {
    const env = renderEnvelope(signOut, 'pre-fix');
    expect(env.sent).toBe(true);
    expect(env.level).toBe('error');
    expect(env.tags.windows_exit_status).toBe('0x40010004');
    expect(env.tags.windows_exit_class).toBe('session_terminate');
    expect(env.tags.sync_route).toBe('watcher');
    expect(env.tags.watcher_child_kind).toBe('cmd_shim');
    expect(env.tags.runner_fatal_class).toBe('none');
    expect(env.message).toContain('consecutive failure #1');
    expect(env.fingerprint[2]).toBe('windows:session-terminate');
  });

  it('post-fix renders the same sign-out as local-log-only with no error event', () => {
    const env = renderEnvelope(signOut, 'post-fix');
    expect(env.sent).toBe(false);
    expect(env.level).not.toBe('error');
    // Grouping continuity: the benign fingerprint is untouched (it just no longer
    // sends), so existing saved searches and alert rules do not move.
    expect(env.fingerprint[2]).toBe('windows:session-terminate');
  });

  it('post-fix escalates a SECOND unconfirmed exit onto a distinct fingerprint', () => {
    const env = renderEnvelope(repeatKiller, 'post-fix');
    expect(env.sent).toBe(true);
    expect(env.level).toBe('error');
    // A NEW fingerprint, never a reuse of the benign sign-out one.
    expect(env.fingerprint[2]).toBe('windows:session-terminate-external-killer');
    expect(env.fingerprint[2]).not.toBe('windows:session-terminate');
    expect(env.message).toContain('not a sign-out');
    expect(env.message).not.toContain('consecutive failure');
    // The escalation carries the teardown diagnostics for the next investigation.
    expect(env.tags.windows_teardown_probe_verdict).toBe('teardown_absent');
    expect(env.tags.session_end_latch).toBe('absent');
  });

  it('keeps a real session end quiet under both policies', () => {
    for (const policy of ['pre-fix', 'post-fix'] as const) {
      const env = renderEnvelope(realSessionEnd, policy);
      expect(env.sent, policy).toBe(false);
    }
  });

  it('every modelled envelope is fixed vocabulary — no path, host, user, or slug', () => {
    const scenarios: Array<[Scenario, Policy]> = [
      [signOut, 'pre-fix'],
      [signOut, 'post-fix'],
      [repeatKiller, 'post-fix'],
      [realSessionEnd, 'post-fix'],
    ];
    const safeToken = /^[a-z0-9_:().# -]*$/i;
    // A hostile machine/user/company marker that must never appear on the wire.
    const forbidden = [/C:\\/i, /DESKTOP-[A-Z0-9]/, /@getindigo\.ai/, /\/Users\//, /\bcmp_/];
    for (const [scenario, policy] of scenarios) {
      const env = renderEnvelope(scenario, policy);
      for (const [key, value] of Object.entries(env.tags)) {
        expect(safeToken.test(value), `${policy} tag ${key}=${value}`).toBe(true);
      }
      const serialized = `${env.message} ${JSON.stringify(env.tags)} ${env.fingerprint.join(',')}`;
      for (const pattern of forbidden) {
        expect(pattern.test(serialized), `${policy}: ${pattern} in ${serialized}`).toBe(false);
      }
    }
  });
});
