/**
 * Runner transient-file-lock terminal-exit attribution (HQ-DESKTOP-5R).
 *
 * A manual HQ Sync on Windows whose only runner error was a single transient
 * EBUSY (a file held open by another process) on a read was misreported at the
 * terminal-exit boundary: the runner exited code 2, the exit classifier had a
 * benign arm for transient network contention and a fault-aware arm for ENOSPC
 * disk exhaustion but NO equivalent arm for a transient local file lock, so the
 * run fell through to `RunnerExitDisposition::Alert`. The user saw the opaque
 *   `[sync] hq-sync-runner exited with code 2`
 * and Sentry received an Error-level defect (runner_error_rollup=EBUSY:1,
 * runner_error_ops=read:1, runner_fatal_class=none, sync_route=manual).
 *
 * A transient Windows file lock is self-healing exactly like a transient network
 * blip — the next sync cycle re-reads the file — so it is a local-machine
 * condition, not a product defect. The fix recognises a file-lock exit ONLY from
 * the parsed, last-wins-immune rollup (exclusively EBUSY) and a sticky "no
 * genuine crash was seen this pass" flag, and it excludes both POSIX crash
 * signals and Windows native-fault codes. A recognised file-lock exit emits one
 * actionable close-the-file event with NO Sentry capture, at BOTH the manual and
 * auto-sync watcher boundaries. Unlike the ENOSPC work it adds NO new fatal
 * class and touches NO telemetry vocabulary — the observed run's fatal class was
 * already `none`.
 *
 * The Rust suites (hq-desktop-core and the app-crate effects recorders) pin the
 * seam from the inside. This spec pins the same properties at the
 * *source-contract* and *artifact* levels, following the fixture-backed pattern
 * of runner-disk-full-attribution.spec.ts.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary and
 * bounded integers — never argv, stderr, symbols, paths, or company slugs.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { assertContentSafeDiagnostics } from './windows-reliability-harness';

// repoRoot is apps/sync, so the shared crate sources are read via '../../crates'.
const coreSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const syncSource = readRepoFile('src-tauri/src/commands/sync.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

/**
 * Slice the region between two unique anchors. Throws rather than degrading — a
 * moved anchor must fail loudly instead of silently asserting over ''.
 */
function sliceBetween(
  source: string,
  startAnchor: string,
  endAnchor: string,
  label: string,
): string {
  const start = source.indexOf(startAnchor);
  if (start === -1) {
    throw new Error(`${label}: start anchor not found: ${startAnchor}`);
  }
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (end === -1) {
    throw new Error(`${label}: end anchor not found after start: ${endAnchor}`);
  }
  return source.slice(start, end + endAnchor.length);
}

/** Extract the shipped SYNC_FILE_LOCKED_DETAIL constant so the simulator's
 *  terminal message is anchored to the real copy, never a drifting hand-copy. */
function shippedFileLockedDetail(): string {
  const match = coreSource.match(
    /pub const SYNC_FILE_LOCKED_DETAIL: &str =\s*"([^"]+)";/,
  );
  if (!match) {
    throw new Error('SYNC_FILE_LOCKED_DETAIL constant not found in sync_outcome.rs');
  }
  return match[1];
}
const SYNC_FILE_LOCKED_DETAIL = shippedFileLockedDetail();

describe('runner file-lock attribution — source contracts', () => {
  it('exposes the last-wins-immune EBUSY rollup exclusivity accessor', () => {
    expect(coreSource).toContain('pub fn is_exclusively_file_locked(&self) -> bool');
    expect(coreSource).toContain('pub fn has_non_file_lock_error(&self) -> bool');
    // Exclusivity is EBUSY present AND no other class present.
    const excl = sliceBetween(
      coreSource,
      'pub fn is_exclusively_file_locked(&self) -> bool {',
      '\n    }\n',
      'is_exclusively_file_locked',
    );
    expect(excl).toContain('self.ebusy > 0');
    expect(excl).toContain('!self.has_non_file_lock_error()');
    // The non-file-lock predicate must count ENOSPC as a non-file-lock error, so
    // the disk-full and file-lock recognizers stay disjoint.
    const nonLock = sliceBetween(
      coreSource,
      'pub fn has_non_file_lock_error(&self) -> bool {',
      '\n    }\n',
      'has_non_file_lock_error',
    );
    expect(nonLock).toContain('self.enospc > 0');
    expect(nonLock).not.toContain('self.ebusy > 0');
  });

  it('recognizer requires the rollup + sticky no-crash, and excludes crash signals/Windows faults', () => {
    expect(coreSource).toContain('pub fn runner_fault_is_file_lock_content(');
    expect(coreSource).toContain('pub fn runner_exit_is_file_lock(');
    expect(coreSource).toContain('pub fn classify_runner_exit_disposition_with_fault(');
    expect(coreSource).toContain('pub fn should_alert_on_nonzero_exit_with_fault(');

    // Content half: no crash seen AND the rollup is exclusively EBUSY. It does NOT
    // fall back to any retained class and does NOT accept an empty rollup.
    const content = sliceBetween(
      coreSource,
      'pub fn runner_fault_is_file_lock_content(',
      '\n}\n',
      'runner_fault_is_file_lock_content',
    );
    expect(content).toContain('!saw_genuine_crash');
    expect(content).toContain('is_exclusively_file_locked()');
    expect(content).not.toContain('has_non_file_lock_error'); // subsumed by exclusivity

    // Full recognizer adds both crash-exit gates on top of the content half.
    const full = sliceBetween(
      coreSource,
      'pub fn runner_exit_is_file_lock(',
      '\n}\n',
      'runner_exit_is_file_lock',
    );
    // Stricter than disk-full: a signal-free exit is required, so any signal
    // (listed crash or a fatal signal outside is_crash_signal) stays alertable.
    expect(full).toContain('signal.is_none()');
    expect(full).not.toContain('!is_crash_signal(signal)');
    expect(full).toContain('!is_windows_fault_exit(code)');
    expect(full).toContain('runner_fault_is_file_lock_content(saw_genuine_crash');
  });

  it('wires the FileLocked disposition into the fault-aware classifier and boolean seam', () => {
    // The fault-aware classifier converts an otherwise-Alert exit to FileLocked.
    const classifier = sliceBetween(
      coreSource,
      'pub fn classify_runner_exit_disposition_with_fault(',
      'RunnerExitDisposition::FileLocked\n    } else {',
      'classify_runner_exit_disposition_with_fault',
    );
    expect(classifier).toContain('runner_exit_is_file_lock(code, signal, saw_genuine_crash, error_rollup)');
    expect(classifier).toContain('RunnerExitDisposition::FileLocked');
    // The boolean projection suppresses the same verdict.
    const boolSeam = sliceBetween(
      coreSource,
      'pub fn should_alert_on_nonzero_exit_with_fault(',
      '\n}\n',
      'should_alert_on_nonzero_exit_with_fault',
    );
    expect(boolSeam).toContain('!runner_exit_is_file_lock(code, signal, saw_genuine_crash, error_rollup)');
  });

  it('makes the fix at the disposition layer, NOT by widening the per-error benign list', () => {
    // is_alertable_error is still the three-clause benign list — no EBUSY / file
    // arm — so an EBUSY error stays alertable and any co-occurring fault surfaces.
    const alertable = sliceBetween(
      coreSource,
      'pub fn is_alertable_error(err: &SyncErrorEvent) -> bool {',
      '\n}\n',
      'is_alertable_error',
    );
    expect(alertable).toContain('is_transient_network_error');
    expect(alertable.toLowerCase()).not.toContain('ebusy');
    expect(alertable.toLowerCase()).not.toContain('file_lock');
    expect(alertable).not.toContain('is_exclusively_file_locked');
  });

  it('introduces NO new fatal class or telemetry token (the observed run was runner_fatal_class=none)', () => {
    // The blast radius stays off the grouping / scrubbing paths: no RunnerFatalClass
    // variant and no telemetry fatal token were added for file-lock.
    expect(coreSource).not.toContain('RunnerFatalClass::FileLocked');
    expect(coreSource).not.toContain('"file_lock"');
    const isFatal = sliceBetween(
      telemetrySource,
      'let is_fatal_class = |value: &str| {',
      '};',
      'is_fatal_class',
    );
    expect(isFatal).not.toContain('file_lock');
  });

  it('wires the FileLocked disposition into the MANUAL route with no capture', () => {
    expect(syncSource).toContain('classify_runner_exit_disposition_with_fault(');
    // The FileLocked arm emits one terminal event WITHOUT a capture.
    const arm = sliceBetween(
      syncSource,
      'RunnerExitDisposition::FileLocked => {',
      '        }',
      'apply_runner_exit_disposition FileLocked arm',
    );
    expect(arm).toContain('effects.emit_sync_error(terminal_sync_error_for_file_locked())');
    expect(arm).not.toContain('capture_and_emit_exit');
    // The terminal event uses the (file-lock) sentinel and the shared constant.
    const helper = sliceBetween(
      syncSource,
      'fn terminal_sync_error_for_file_locked() -> SyncErrorEvent {',
      '\n}\n',
      'terminal_sync_error_for_file_locked',
    );
    expect(helper).toContain('path: "(file-lock)".to_string()');
    expect(helper).toContain('message: SYNC_FILE_LOCKED_DETAIL.to_string()');
  });

  it('wires the SAME verdict into the WATCHER route so the fleet cannot go half-quiet', () => {
    expect(daemonSource).toContain('runner_fault_is_file_lock_content(');
    expect(daemonSource).toContain(
      'fn attributed_to_file_lock(&self, code: Option<i32>, signal: Option<i32>) -> bool',
    );
    // A file-lock watcher exit routes to LocalLogOnly (no Error capture) …
    expect(daemonSource).toContain('|| context.attributed_to_file_lock(code, signal)');
    // … while still reporting the content-safe attribution locally.
    expect(daemonSource).toContain('runner_error_class=ebusy');
    // The crash-exit gates are the shared ones.
    const method = sliceBetween(
      daemonSource,
      'fn attributed_to_file_lock(&self, code: Option<i32>, signal: Option<i32>) -> bool {',
      '\n    }\n',
      'attributed_to_file_lock',
    );
    expect(method).toContain('signal.is_none()');
    expect(method).toContain('!is_windows_fault_exit(code)');
  });
});

// ---------------------------------------------------------------------------
// Artifact-level envelope model
// ---------------------------------------------------------------------------

type Policy = 'pre-fix' | 'post-fix';
type Route = 'manual' | 'watcher';

interface SentryEnvelopeEvent {
  message: string;
  fingerprint: string[];
  tags: Record<string, string>;
  extras: Record<string, string | boolean | number>;
}

interface ExitOutcome {
  /** Error-level Sentry events produced. Empty for a suppressed file-lock exit. */
  captures: SentryEnvelopeEvent[];
  /** User-facing sync:error text (manual route only), or null. */
  terminalMessage: string | null;
  /** The runner_error_class the route reports for this exit. */
  reportedErrorClass: string;
}

/**
 * Content-safe axes of one terminal runner exit, as the shipped RunTotals would
 * carry them. Fixed vocabulary and integers only — this is exactly what leaves
 * the machine; the raw stderr never does.
 */
interface RunFixture {
  code: number | null;
  signal: number | null;
  rollup: string; // e.g. "EBUSY:1"
  ops: string; // e.g. "read:1"
  sawAlertableError: boolean;
  stdoutLineCount: number;
  /** The rollup is exclusively EBUSY (the last-wins-immune file-lock signal). */
  exclusivelyFileLocked: boolean;
  /** Sticky: any genuine crash class was seen this pass (blocks suppression). */
  sawGenuineCrash: boolean;
  /** The retained fatal class — `none` for the observed HQ-DESKTOP-5R event. */
  retainedFatalClass: string;
}

/** TS mirror of `is_windows_fault_exit`: the 0xC000_xxxx NTSTATUS fault range,
 *  excluding the console-control and 0xFFFFFFFF carve-outs. */
function isWindowsFaultCode(code: number | null): boolean {
  if (code === null) return false;
  const raw = code >>> 0;
  // `>>> 0` keeps the mask result unsigned; a bare `&` would yield a signed int32
  // that never equals the unsigned 0xC0000000 literal.
  return ((raw & 0xc000_0000) >>> 0) === 0xc000_0000 && raw !== 0xffff_ffff && raw !== 0xc000_013a;
}

/** TS mirror of the shipped `runner_exit_is_file_lock` recognizer. Stricter than
 *  the disk-full recognizer: it requires a signal-free exit, so ANY signal —
 *  a listed crash signal OR a fatal signal outside is_crash_signal such as
 *  SIGFPE/SIGQUIT/SIGSYS — keeps the run alertable (HQ-DESKTOP-5R review). */
function isFileLockVerdict(fx: RunFixture): boolean {
  if (fx.signal !== null) return false; // any signal-terminated exit stays alertable
  if (isWindowsFaultCode(fx.code)) return false; // Windows native fault (code, signal=null)
  if (fx.sawGenuineCrash) return false; // sticky crash evidence
  return fx.exclusivelyFileLocked; // requires the parsed exclusively-EBUSY rollup
}

/** TS mirror of `is_benign_watcher_exit` for the no-signal code-1/2 case. */
function isBenignWatcherExit(fx: RunFixture): boolean {
  return fx.signal === null && (fx.code === 1 || fx.code === 2);
}

function exitDescription(fx: RunFixture): string {
  if (fx.signal !== null) return `killed by signal ${fx.signal}`;
  return `with code ${fx.code}`;
}

/** Model the MANUAL boundary's Sentry + UI outcome for one exit. */
function simulateManualExit(fx: RunFixture, policy: Policy): ExitOutcome {
  if (policy === 'post-fix' && isFileLockVerdict(fx)) {
    return {
      captures: [],
      terminalMessage: SYNC_FILE_LOCKED_DETAIL,
      reportedErrorClass: 'ebusy',
    };
  }
  // Pre-fix, or a non-file-lock exit: the Alert disposition captures + shows the
  // opaque runner-exit text.
  const title = `[sync] hq-sync-runner exited ${exitDescription(fx)}`;
  return {
    captures: [
      {
        message: title,
        fingerprint: ['sync', 'runner-exit', fx.retainedFatalClass],
        tags: {
          sync_route: 'manual',
          runner_fatal_class: fx.retainedFatalClass,
          runner_error_rollup: fx.rollup,
          runner_error_ops: fx.ops,
        },
        extras: {
          saw_alertable_error: fx.sawAlertableError,
          runner_stdout_line_count: fx.stdoutLineCount,
        },
      },
    ],
    terminalMessage: title,
    reportedErrorClass: fx.rollup === '' ? 'none' : 'ebusy',
  };
}

/** Model the auto-sync WATCHER boundary's Sentry outcome for one exit. */
function simulateWatcherExit(fx: RunFixture, policy: Policy): ExitOutcome {
  if (policy === 'post-fix' && isFileLockVerdict(fx)) {
    // LocalLogOnly: no Error capture, breadcrumb names runner_error_class=ebusy.
    return { captures: [], terminalMessage: null, reportedErrorClass: 'ebusy' };
  }
  if (isBenignWatcherExit(fx)) {
    // code 1/2 with no signal is already LocalLogOnly on both policies.
    return { captures: [], terminalMessage: null, reportedErrorClass: fx.retainedFatalClass };
  }
  return {
    captures: [
      {
        message: `auto-sync watcher exited unexpectedly (${exitDescription(fx)}), consecutive failure #1`,
        fingerprint: ['sync', 'auto-sync-watcher-termination', fx.retainedFatalClass],
        tags: {
          sync_route: 'watcher',
          runner_fatal_class: fx.retainedFatalClass,
          runner_error_rollup: fx.rollup,
        },
        extras: { saw_alertable_error: fx.sawAlertableError },
      },
    ],
    terminalMessage: null,
    reportedErrorClass: fx.retainedFatalClass,
  };
}

// The exact reported HQ-DESKTOP-5R shape: a manual code-2 exit whose only error
// class was a single EBUSY read, with no crash class and fatal class `none`, seven
// stdout protocol lines emitted before the failing read.
const HQ_DESKTOP_5R: RunFixture = {
  code: 2,
  signal: null,
  rollup: 'EBUSY:1',
  ops: 'read:1',
  sawAlertableError: true,
  stdoutLineCount: 7,
  exclusivelyFileLocked: true,
  sawGenuineCrash: false,
  retainedFatalClass: 'none',
};

// A file-lock exit with an UNKNOWN, non-benign code — the case where the watcher
// route would otherwise capture, so it proves cross-route parity is required.
// (code 1/2 is already benign at the watcher, so it cannot prove the new arm.)
const FILE_LOCK_UNKNOWN_CODE: RunFixture = { ...HQ_DESKTOP_5R, code: 243 };

// A genuine crash preceded the file-lock error, so the sticky flag is set even
// though the EBUSY rollup is exclusive.
const CRASH_THEN_EBUSY: RunFixture = { ...HQ_DESKTOP_5R, sawGenuineCrash: true };

// A Windows native fault reported in `code` with signal=None.
const WINDOWS_FAULT_WITH_EBUSY: RunFixture = { ...HQ_DESKTOP_5R, code: 0xc000_0005 | 0 };

// A mixed rollup: a lock AND a permission error in the same pass. Not exclusive,
// so it must keep alerting.
const MIXED_ROLLUP: RunFixture = {
  ...HQ_DESKTOP_5R,
  rollup: 'EBUSY:1,EPERM:1',
  exclusivelyFileLocked: false,
};

// An EBUSY startup with no parsed protocol error — no rollup entry, so not a
// file-lock verdict.
const NO_PROTOCOL: RunFixture = {
  ...HQ_DESKTOP_5R,
  rollup: '',
  ops: '',
  exclusivelyFileLocked: false,
};

describe('runner file-lock attribution — shipped Sentry envelope', () => {
  it('pre-fix: reproduces the observed HQ-DESKTOP-5R envelope (non-vacuity guard)', () => {
    const { captures, terminalMessage } = simulateManualExit(HQ_DESKTOP_5R, 'pre-fix');
    expect(captures).toHaveLength(1);
    const event = captures[0];
    expect(event.message).toBe('[sync] hq-sync-runner exited with code 2');
    expect(event.tags.sync_route).toBe('manual');
    expect(event.tags.runner_fatal_class).toBe('none');
    expect(event.tags.runner_error_rollup).toBe('EBUSY:1');
    expect(event.tags.runner_error_ops).toBe('read:1');
    expect(event.extras.saw_alertable_error).toBe(true);
    expect(event.extras.runner_stdout_line_count).toBe(7);
    expect(terminalMessage).toBe('[sync] hq-sync-runner exited with code 2');
    assertContentSafeDiagnostics(event);
  });

  it('post-fix: zero captures, one close-the-file terminal event, ebusy attribution', () => {
    const { captures, terminalMessage, reportedErrorClass } = simulateManualExit(
      HQ_DESKTOP_5R,
      'post-fix',
    );
    expect(captures).toHaveLength(0);
    expect(terminalMessage).toBe(SYNC_FILE_LOCKED_DETAIL);
    expect(terminalMessage).not.toContain('exited with code');
    expect(terminalMessage).not.toContain('EBUSY');
    expect(reportedErrorClass).toBe('ebusy');
  });

  it('post-fix: BOTH routes suppress the identical verdict from one fixture', () => {
    // Pre-fix, an unknown non-benign code alerts on BOTH routes …
    expect(simulateManualExit(FILE_LOCK_UNKNOWN_CODE, 'pre-fix').captures).toHaveLength(1);
    expect(simulateWatcherExit(FILE_LOCK_UNKNOWN_CODE, 'pre-fix').captures).toHaveLength(1);
    // … post-fix, BOTH reach the file-lock verdict and suppress. A fix landing on
    // only one route would leave the other's capture count at 1 and fail here.
    const manual = simulateManualExit(FILE_LOCK_UNKNOWN_CODE, 'post-fix');
    const watcher = simulateWatcherExit(FILE_LOCK_UNKNOWN_CODE, 'post-fix');
    expect(manual.captures).toHaveLength(0);
    expect(watcher.captures).toHaveLength(0);
    expect(manual.reportedErrorClass).toBe('ebusy');
    expect(watcher.reportedErrorClass).toBe('ebusy');
  });

  it('never over-suppresses: crash class, crash signal, Windows fault, or a mixed rollup still alerts', () => {
    // A genuine crash seen earlier in the pass (sticky) keeps alerting.
    expect(simulateManualExit(CRASH_THEN_EBUSY, 'post-fix').captures).toHaveLength(1);
    expect(
      simulateWatcherExit({ ...FILE_LOCK_UNKNOWN_CODE, sawGenuineCrash: true }, 'post-fix').captures,
    ).toHaveLength(1);
    // A POSIX crash signal still alerts.
    expect(
      simulateWatcherExit({ ...FILE_LOCK_UNKNOWN_CODE, signal: 11, code: null }, 'post-fix').captures,
    ).toHaveLength(1);
    // A fatal signal OUTSIDE is_crash_signal (e.g. SIGFPE=8) also still alerts,
    // because the recognizer requires signal.is_none() (HQ-DESKTOP-5R review).
    expect(isFileLockVerdict({ ...FILE_LOCK_UNKNOWN_CODE, signal: 8, code: null })).toBe(false);
    expect(
      simulateWatcherExit({ ...FILE_LOCK_UNKNOWN_CODE, signal: 8, code: null }, 'post-fix').captures,
    ).toHaveLength(1);
    expect(
      simulateManualExit({ ...HQ_DESKTOP_5R, signal: 8, code: null }, 'post-fix').captures,
    ).toHaveLength(1);
    // A Windows native fault code still alerts on both routes.
    expect(simulateManualExit(WINDOWS_FAULT_WITH_EBUSY, 'post-fix').captures).toHaveLength(1);
    expect(simulateWatcherExit(WINDOWS_FAULT_WITH_EBUSY, 'post-fix').captures).toHaveLength(1);
    // A co-occurring non-file-lock class (EPERM) is not exclusive → keeps alerting.
    expect(isFileLockVerdict(MIXED_ROLLUP)).toBe(false);
    expect(simulateManualExit(MIXED_ROLLUP, 'post-fix').captures).toHaveLength(1);
  });

  it('an EBUSY startup with no parsed protocol error is not suppressed', () => {
    // No exclusively-EBUSY rollup → not a file-lock verdict → keeps alerting, so
    // the close-the-file copy never fires for a rollup-less startup shape.
    expect(isFileLockVerdict(NO_PROTOCOL)).toBe(false);
    const manual = simulateManualExit(NO_PROTOCOL, 'post-fix');
    expect(manual.captures).toHaveLength(1);
    expect(manual.terminalMessage).not.toBe(SYNC_FILE_LOCKED_DETAIL);
  });

  it('every modeled envelope in both directions is content-safe', () => {
    for (const fx of [
      HQ_DESKTOP_5R,
      FILE_LOCK_UNKNOWN_CODE,
      CRASH_THEN_EBUSY,
      WINDOWS_FAULT_WITH_EBUSY,
      MIXED_ROLLUP,
      NO_PROTOCOL,
    ]) {
      for (const policy of ['pre-fix', 'post-fix'] as Policy[]) {
        for (const route of ['manual', 'watcher'] as Route[]) {
          const outcome =
            route === 'manual' ? simulateManualExit(fx, policy) : simulateWatcherExit(fx, policy);
          for (const event of outcome.captures) {
            assertContentSafeDiagnostics(event);
          }
        }
      }
    }
  });
});
