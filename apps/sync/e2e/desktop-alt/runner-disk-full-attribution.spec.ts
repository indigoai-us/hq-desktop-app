/**
 * Runner disk-full terminal-exit attribution (HQ-DESKTOP-5D).
 *
 * A manual HQ Sync whose only runner error was disk exhaustion (ENOSPC) was
 * misreported at the terminal-exit boundary: the runner exited code 1, the exit
 * classifier had no disk-full arm, and the run fell through to
 * `RunnerExitDisposition::Alert`. The user saw the opaque
 *   `[sync] hq-sync-runner exited with code 1`
 * and Sentry received an Error-level defect whose retained
 * `runner_fatal_class=npm_install_relay` named the npm companion line rather than
 * the causal ENOSPC (which survived only on `runner_error_rollup=ENOSPC:1`).
 *
 * The fix recognises a disk-full exit ONLY from the parsed, last-wins-immune
 * rollup (exclusively ENOSPC) and a sticky "no genuine crash was seen this pass"
 * flag, and it excludes both POSIX crash signals and Windows native-fault codes.
 * A recognised disk-full exit emits one actionable free-up-space event with NO
 * Sentry capture, at BOTH the manual and auto-sync watcher boundaries.
 *
 * The Rust suites (hq-desktop-core, hq-telemetry, and the app-crate effects
 * recorders) pin the seam from the inside. This spec pins the same properties at
 * the *source-contract* and *artifact* levels, following the fixture-backed
 * pattern of watcher-heap-oom-attribution.spec.ts.
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

/** Extract the shipped SYNC_DISK_FULL_DETAIL constant so the simulator's terminal
 *  message is anchored to the real copy, never a drifting hand-copy. */
function shippedDiskFullDetail(): string {
  const match = coreSource.match(
    /pub const SYNC_DISK_FULL_DETAIL: &str =\s*"([^"]+)";/,
  );
  if (!match) {
    throw new Error('SYNC_DISK_FULL_DETAIL constant not found in sync_outcome.rs');
  }
  return match[1];
}
const SYNC_DISK_FULL_DETAIL = shippedDiskFullDetail();

describe('runner disk-full attribution — source contracts', () => {
  it('classifies ENOSPC as disk_full BEFORE the npm-relay arm and AFTER every crash arm', () => {
    const fn = sliceBetween(
      coreSource,
      'pub fn classify_runner_fatal_class(',
      'fn is_npm_error_line(',
      'classify_runner_fatal_class',
    );
    const diskFullArm = fn.indexOf('is_disk_exhaustion_failure(line)');
    const npmArm = fn.indexOf('is_npm_error_line(&msg)');
    const rustPanicArm = fn.indexOf('"panicked at"');
    const heapArm = fn.indexOf('javascript heap out of memory');
    expect(diskFullArm).toBeGreaterThan(0);
    expect(npmArm).toBeGreaterThan(0);
    // The disk-full arm precedes the npm-relay arm (so npm's own ENOSPC → disk_full).
    expect(diskFullArm).toBeLessThan(npmArm);
    // … and follows every genuine-crash arm (so a crash mentioning ENOSPC keeps its class).
    expect(rustPanicArm).toBeGreaterThan(0);
    expect(heapArm).toBeGreaterThan(0);
    expect(diskFullArm).toBeGreaterThan(rustPanicArm);
    expect(diskFullArm).toBeGreaterThan(heapArm);
    // The vocabulary has exactly one definition — the arm delegates to hq_cli_update.
    expect(fn).toContain('crate::hq_cli_update::is_disk_exhaustion_failure(line)');
    expect(fn).toContain('RunnerFatalClass::DiskFull');
  });

  it('renders the disk_full token and keeps it out of the genuine-crash set', () => {
    expect(coreSource).toContain('Self::DiskFull => "disk_full"');
    expect(coreSource).toContain('Self::DiskFull,'); // in RunnerFatalClass::ALL
    const isCrash = sliceBetween(
      coreSource,
      'pub fn is_genuine_crash(self) -> bool {',
      '\n    }\n',
      'is_genuine_crash',
    );
    expect(isCrash).not.toContain('DiskFull');
  });

  it('records a sticky genuine-crash flag from each stderr line before last-wins overwrites', () => {
    // Finding 1: the crash flag is set from the classified line and never cleared,
    // so a trailing npm companion line cannot bury an earlier crash class.
    expect(coreSource).toContain('pub saw_genuine_crash_fatal: bool');
    const record = sliceBetween(
      coreSource,
      'pub fn record_stderr_line(&mut self, line: &str) {',
      'self.record_heap_oom_stderr_line(line, signature.class);',
      'record_stderr_line',
    );
    expect(record).toContain('signature.class.is_genuine_crash()');
    expect(record).toContain('self.saw_genuine_crash_fatal = true');
  });

  it('exposes the last-wins-immune rollup exclusivity accessor', () => {
    expect(coreSource).toContain('pub fn is_exclusively_disk_full(&self) -> bool');
  });

  it('recognizer requires the rollup + sticky no-crash, and excludes crash signals/Windows faults', () => {
    expect(coreSource).toContain('pub fn is_windows_fault_exit(');
    expect(coreSource).toContain('pub fn runner_fault_is_disk_exhaustion_content(');
    expect(coreSource).toContain('pub fn runner_exit_is_disk_exhaustion(');
    expect(coreSource).toContain('pub fn classify_runner_exit_disposition_with_fault(');
    expect(coreSource).toContain('pub fn should_alert_on_nonzero_exit_with_fault(');

    // Content half: no crash seen AND the rollup is exclusively ENOSPC. Crucially
    // it does NOT fall back to the retained fatal class or accept an empty rollup.
    const content = sliceBetween(
      coreSource,
      'pub fn runner_fault_is_disk_exhaustion_content(',
      '\n}\n',
      'runner_fault_is_disk_exhaustion_content',
    );
    expect(content).toContain('!saw_genuine_crash');
    expect(content).toContain('is_exclusively_disk_full()');
    expect(content).not.toContain('RunnerFatalClass::DiskFull'); // no fatal-class alt
    expect(content).not.toContain('has_non_disk_full_error'); // subsumed by exclusivity

    // Full recognizer adds both crash-exit gates.
    const full = sliceBetween(
      coreSource,
      'pub fn runner_exit_is_disk_exhaustion(',
      '\n}\n',
      'runner_exit_is_disk_exhaustion',
    );
    expect(full).toContain('!is_crash_signal(signal)');
    expect(full).toContain('!is_windows_fault_exit(code)');
    expect(full).toContain('runner_fault_is_disk_exhaustion_content(saw_genuine_crash');

    // is_windows_fault_exit keys on the WindowsTermination::Fault classification.
    const fault = sliceBetween(
      coreSource,
      'pub fn is_windows_fault_exit(',
      '\n}\n',
      'is_windows_fault_exit',
    );
    expect(fault).toContain('WindowsTermination::Fault');
  });

  it('wires the DiskFull disposition into the MANUAL route with no capture', () => {
    // The manual exit handler passes the sticky crash flag + rollup into the
    // fault-aware classifier …
    expect(syncSource).toContain('classify_runner_exit_disposition_with_fault(');
    expect(syncSource).toContain('totals_snapshot.saw_genuine_crash_fatal,');
    expect(syncSource).toContain('&totals_snapshot.runner_error_rollup,');
    // … and the DiskFull arm emits one terminal event WITHOUT a capture.
    const arm = sliceBetween(
      syncSource,
      'RunnerExitDisposition::DiskFull => {',
      '        }',
      'apply_runner_exit_disposition DiskFull arm',
    );
    expect(arm).toContain('effects.emit_sync_error(terminal_sync_error_for_disk_full())');
    expect(arm).not.toContain('capture_and_emit_exit');
    // The terminal event uses the (disk) sentinel and the shared constant.
    const helper = sliceBetween(
      syncSource,
      'fn terminal_sync_error_for_disk_full() -> SyncErrorEvent {',
      '\n}\n',
      'terminal_sync_error_for_disk_full',
    );
    expect(helper).toContain('path: "(disk)".to_string()');
    expect(helper).toContain('message: SYNC_DISK_FULL_DETAIL.to_string()');
  });

  it('wires the SAME verdict into the WATCHER route so the fleet cannot go half-quiet', () => {
    expect(daemonSource).toContain('runner_fault_is_disk_exhaustion_content(');
    expect(daemonSource).toContain('totals.saw_genuine_crash_fatal,');
    expect(daemonSource).toContain(
      'fn attributed_to_disk_exhaustion(&self, code: Option<i32>, signal: Option<i32>) -> bool',
    );
    // A disk-full watcher exit routes to LocalLogOnly (no Error capture) …
    expect(daemonSource).toContain('|| context.attributed_to_disk_exhaustion(code, signal)');
    // … while still reporting the content-safe disk_full attribution locally.
    expect(daemonSource).toContain('runner_fatal_class=disk_full');
    // The crash-exit gates are the shared ones.
    const method = sliceBetween(
      daemonSource,
      'fn attributed_to_disk_exhaustion(&self, code: Option<i32>, signal: Option<i32>) -> bool {',
      '\n    }\n',
      'attributed_to_disk_exhaustion',
    );
    expect(method).toContain('!is_crash_signal(signal)');
    expect(method).toContain('!is_windows_fault_exit(code)');
  });

  it('registers disk_full at the telemetry egress boundary', () => {
    const isFatal = sliceBetween(
      telemetrySource,
      'let is_fatal_class = |value: &str| {',
      '};',
      'is_fatal_class',
    );
    expect(isFatal).toContain('"disk_full"');
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
  /** Error-level Sentry events produced. Empty for a suppressed disk-full exit. */
  captures: SentryEnvelopeEvent[];
  /** User-facing sync:error text (manual route only), or null. */
  terminalMessage: string | null;
  /** The runner_fatal_class the route reports for this exit. */
  reportedFatalClass: string;
}

/**
 * Content-safe axes of one terminal runner exit, as the shipped RunTotals would
 * carry them. Fixed vocabulary and integers only — this is exactly what leaves
 * the machine; the raw stderr never does.
 */
interface RunFixture {
  code: number | null;
  signal: number | null;
  rollup: string; // e.g. "ENOSPC:1"
  ops: string; // e.g. "open:1"
  sawAlertableError: boolean;
  stdoutLineCount: number;
  /** The rollup is exclusively ENOSPC (the last-wins-immune disk-full signal). */
  exclusivelyDiskFull: boolean;
  /** Sticky: any genuine crash class was seen this pass (blocks suppression). */
  sawGenuineCrash: boolean;
  /** The retained (last-wins) fatal class — the npm messenger in HQ-DESKTOP-5D. */
  retainedFatalClass: string;
}

const CRASH_SIGNALS = new Set([4, 6, 7, 9, 10, 11]);

/** TS mirror of `is_windows_fault_exit`: the 0xC000_xxxx NTSTATUS fault range,
 *  excluding the console-control and 0xFFFFFFFF carve-outs. */
function isWindowsFaultCode(code: number | null): boolean {
  if (code === null) return false;
  const raw = code >>> 0;
  // `>>> 0` keeps the mask result unsigned; a bare `&` would yield a signed int32
  // that never equals the unsigned 0xC0000000 literal.
  return ((raw & 0xc000_0000) >>> 0) === 0xc000_0000 && raw !== 0xffff_ffff && raw !== 0xc000_013a;
}

/** TS mirror of the shipped `runner_exit_is_disk_exhaustion` recognizer. */
function isDiskFullVerdict(fx: RunFixture): boolean {
  if (fx.signal !== null && CRASH_SIGNALS.has(fx.signal)) return false; // POSIX crash signal
  if (isWindowsFaultCode(fx.code)) return false; // Windows native fault
  if (fx.sawGenuineCrash) return false; // sticky crash evidence
  return fx.exclusivelyDiskFull; // requires the parsed exclusively-ENOSPC rollup
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
  if (policy === 'post-fix' && isDiskFullVerdict(fx)) {
    return { captures: [], terminalMessage: SYNC_DISK_FULL_DETAIL, reportedFatalClass: 'disk_full' };
  }
  // Pre-fix, or a non-disk-full exit: the Alert disposition captures + shows the
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
    reportedFatalClass: fx.retainedFatalClass,
  };
}

/** Model the auto-sync WATCHER boundary's Sentry outcome for one exit. */
function simulateWatcherExit(fx: RunFixture, policy: Policy): ExitOutcome {
  if (policy === 'post-fix' && isDiskFullVerdict(fx)) {
    // LocalLogOnly: no Error capture, breadcrumb names disk_full.
    return { captures: [], terminalMessage: null, reportedFatalClass: 'disk_full' };
  }
  if (isBenignWatcherExit(fx)) {
    // code 1/2 with no signal is already LocalLogOnly on both policies.
    return { captures: [], terminalMessage: null, reportedFatalClass: fx.retainedFatalClass };
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
    reportedFatalClass: fx.retainedFatalClass,
  };
}

// The exact reported HQ-DESKTOP-5D shape: a manual code-1 exit whose only error
// class was ENOSPC, whose retained fatal class was the npm messenger, with no
// crash seen and no protocol stdout before failing.
const HQ_DESKTOP_5D: RunFixture = {
  code: 1,
  signal: null,
  rollup: 'ENOSPC:1',
  ops: 'open:1',
  sawAlertableError: true,
  stdoutLineCount: 0,
  exclusivelyDiskFull: true,
  sawGenuineCrash: false,
  retainedFatalClass: 'npm_install_relay',
};

// A disk-full exit with an UNKNOWN, non-benign code — the case where the watcher
// route would otherwise capture, so it proves cross-route parity is required.
const DISK_FULL_UNKNOWN_CODE: RunFixture = { ...HQ_DESKTOP_5D, code: 243 };

// Finding 1: a genuine crash preceded the npm companion line, so the sticky flag
// is set even though the ENOSPC rollup is exclusive.
const CRASH_THEN_ENOSPC: RunFixture = { ...HQ_DESKTOP_5D, sawGenuineCrash: true };

// Finding 0: a Windows native fault reported in `code` with signal=None.
const WINDOWS_FAULT_WITH_ENOSPC: RunFixture = { ...HQ_DESKTOP_5D, code: 0xc000_0005 | 0 };

// Findings 2 & 3: an npm-own ENOSPC / lifecycle failure before any protocol error
// — no parsed rollup entry, so not a disk-full verdict.
const NPM_STARTUP_NO_PROTOCOL: RunFixture = {
  ...HQ_DESKTOP_5D,
  rollup: '',
  ops: '',
  exclusivelyDiskFull: false,
};

describe('runner disk-full attribution — shipped Sentry envelope', () => {
  it('pre-fix: reproduces the observed HQ-DESKTOP-5D envelope (non-vacuity guard)', () => {
    const { captures, terminalMessage } = simulateManualExit(HQ_DESKTOP_5D, 'pre-fix');
    expect(captures).toHaveLength(1);
    const event = captures[0];
    expect(event.message).toBe('[sync] hq-sync-runner exited with code 1');
    expect(event.tags.runner_fatal_class).toBe('npm_install_relay');
    expect(event.tags.runner_error_rollup).toBe('ENOSPC:1');
    expect(event.tags.runner_error_ops).toBe('open:1');
    expect(event.extras.saw_alertable_error).toBe(true);
    expect(event.extras.runner_stdout_line_count).toBe(0);
    expect(terminalMessage).toBe('[sync] hq-sync-runner exited with code 1');
    assertContentSafeDiagnostics(event);
  });

  it('post-fix: zero captures, one free-up-space terminal event, disk_full attribution', () => {
    const { captures, terminalMessage, reportedFatalClass } = simulateManualExit(
      HQ_DESKTOP_5D,
      'post-fix',
    );
    expect(captures).toHaveLength(0);
    expect(terminalMessage).toBe(SYNC_DISK_FULL_DETAIL);
    expect(terminalMessage).not.toContain('exited with code');
    expect(terminalMessage).toMatch(/space/i);
    expect(reportedFatalClass).toBe('disk_full');
  });

  it('post-fix: BOTH routes suppress the identical verdict from one fixture', () => {
    // Pre-fix, an unknown non-benign code alerts on BOTH routes …
    expect(simulateManualExit(DISK_FULL_UNKNOWN_CODE, 'pre-fix').captures).toHaveLength(1);
    expect(simulateWatcherExit(DISK_FULL_UNKNOWN_CODE, 'pre-fix').captures).toHaveLength(1);
    // … post-fix, BOTH reach the disk-full verdict and suppress. A fix landing on
    // only one route would leave the other's capture count at 1 and fail here.
    const manual = simulateManualExit(DISK_FULL_UNKNOWN_CODE, 'post-fix');
    const watcher = simulateWatcherExit(DISK_FULL_UNKNOWN_CODE, 'post-fix');
    expect(manual.captures).toHaveLength(0);
    expect(watcher.captures).toHaveLength(0);
    expect(manual.reportedFatalClass).toBe('disk_full');
    expect(watcher.reportedFatalClass).toBe('disk_full');
  });

  it('never over-suppresses: crash class, crash signal, or Windows fault still alerts', () => {
    // Finding 1: a genuine crash seen earlier in the pass (sticky) keeps alerting.
    expect(simulateManualExit(CRASH_THEN_ENOSPC, 'post-fix').captures).toHaveLength(1);
    expect(
      simulateWatcherExit({ ...DISK_FULL_UNKNOWN_CODE, sawGenuineCrash: true }, 'post-fix').captures,
    ).toHaveLength(1);
    // A POSIX crash signal still alerts.
    expect(
      simulateWatcherExit({ ...DISK_FULL_UNKNOWN_CODE, signal: 11, code: null }, 'post-fix').captures,
    ).toHaveLength(1);
    // Finding 0: a Windows native fault code still alerts on both routes.
    expect(simulateManualExit(WINDOWS_FAULT_WITH_ENOSPC, 'post-fix').captures).toHaveLength(1);
    expect(simulateWatcherExit(WINDOWS_FAULT_WITH_ENOSPC, 'post-fix').captures).toHaveLength(1);
  });

  it('findings 2 & 3: an ENOSPC startup with no parsed protocol error is not suppressed', () => {
    // No exclusively-ENOSPC rollup → not a disk-full verdict → keeps alerting,
    // so the HQ-folder free-space copy never fires for an npx-cache/lifecycle fill.
    expect(isDiskFullVerdict(NPM_STARTUP_NO_PROTOCOL)).toBe(false);
    const manual = simulateManualExit(NPM_STARTUP_NO_PROTOCOL, 'post-fix');
    expect(manual.captures).toHaveLength(1);
    expect(manual.terminalMessage).not.toBe(SYNC_DISK_FULL_DETAIL);
  });

  it('every modeled envelope in both directions is content-safe', () => {
    for (const fx of [
      HQ_DESKTOP_5D,
      DISK_FULL_UNKNOWN_CODE,
      CRASH_THEN_ENOSPC,
      WINDOWS_FAULT_WITH_ENOSPC,
      NPM_STARTUP_NO_PROTOCOL,
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
