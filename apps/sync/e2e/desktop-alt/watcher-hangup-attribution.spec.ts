/**
 * Watcher hangup attribution (HQ-DESKTOP-5Y).
 *
 * A macOS SIGHUP (code=None, signal=Some(1)) that ends the auto-sync watcher was
 * captured to Sentry with the raw Rust Debug fallback
 * `[sync] auto-sync watcher exited unexpectedly (code=None signal=Some(1))`,
 * even though `describe_exit` already renders that exact shape as
 * `killed by SIGHUP`. The renderer existed; the signal-only fallback simply never
 * reached it. This fix routes the fallback through `describe_exit` (keeping the
 * raw rendering only for the malformed both-present shape, which `describe_exit`
 * cannot render honestly) and adds a queryable `watcher_exit_signal_class` tag +
 * `watcher_exit_signal` integer extra so the next occurrence is filterable
 * without parsing the message.
 *
 * The Rust unit tests pin the seam from the inside. This spec pins the same
 * property at the *artifact* level — the shipped Sentry envelope — following the
 * fixture-backed contract pattern of `watcher-stall-teardown-attribution.spec.ts`:
 *
 * 1. Source contracts over the code that actually ships, so a revert to the
 *    pre-fix shape fails here and not only in the Rust suite.
 * 2. An envelope simulator asserted in BOTH directions: a modeled SIGHUP
 *    termination produces the named message + class tag under the fixed renderer,
 *    while the SAME simulator run against the pre-fix renderer reproduces the
 *    exact observed title byte-for-byte — which is what keeps the passing
 *    direction from being a vacuous assertion. SIGABRT and a Windows fault status
 *    keep their messages and fingerprint tokens across the change.
 *
 * Content-safety: the modeled envelope carries only fixed vocabulary and bare
 * integers — never argv, stderr, tokens, paths, host names, or company slugs.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { assertContentSafeDiagnostics } from './windows-reliability-harness';

const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const syncOutcomeSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
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

// The captured-message expression in record_unexpected_watcher_exit — the seam
// that decides whether a signal-only exit is named or dumped as a raw tuple.
const messageBlock = sliceBetween(
  daemonSource,
  'let message = if let Some(exit_description) = normalized_abort {',
  '    };',
  'watcher exit message expression',
);

describe('watcher hangup attribution — source contracts', () => {
  it('routes the signal-only fallback through the describe_exit renderer', () => {
    // The final arm names the exit via the shared renderer instead of a raw tuple.
    expect(messageBlock).toContain('describe_exit(code, signal)');
    // describe_exit is called exactly once — the redundant Windows-status arm was
    // collapsed into the same fallback rather than duplicated.
    expect(messageBlock.match(/describe_exit\(code, signal\)/g)).toHaveLength(1);
  });

  it('keeps the raw rendering ONLY for the malformed both-present shape', () => {
    // The raw Debug tuple survives in exactly one place: guarded behind the
    // both-present test, where describe_exit would otherwise drop the signal.
    expect(messageBlock).toContain('code.is_some() && signal.is_some()');
    const rawTuple = /code=\{code:\?\} signal=\{signal:\?\}/g;
    expect(messageBlock.match(rawTuple)).toHaveLength(1);
    // The both-present guard precedes the surviving raw rendering.
    expect(messageBlock).toMatch(
      /code\.is_some\(\) && signal\.is_some\(\)[\s\S]*?code=\{code:\?\} signal=\{signal:\?\}/,
    );
  });

  it('emits the queryable signal class tag and signal integer extra', () => {
    expect(daemonSource).toContain('"watcher_exit_signal_class",');
    expect(daemonSource).toContain('watcher_exit_signal_class(signal)');
    expect(daemonSource).toContain('"watcher_exit_signal",');
  });

  it('defines the classifier and registers both fields at the telemetry egress', () => {
    expect(syncOutcomeSource).toContain('pub fn watcher_exit_signal_class(');
    // Closed vocabulary at the egress, mirroring watcher_child_kind.
    expect(telemetrySource).toContain('"watcher_exit_signal_class" => Some(matches!(');
    expect(telemetrySource).toContain('"watcher_exit_signal" => Some(');
  });
});

// ---------------------------------------------------------------------------
// Envelope simulator — models the shipped decision at the artifact level.
// ---------------------------------------------------------------------------

type Host = 'posix' | 'windows';
type Build = 'fixed' | 'pre-fix';

interface Scenario {
  code: number | null;
  signal: number | null;
  host: Host;
}

interface SimEnvelope {
  message: string;
  fingerprintToken: string;
  tags: Record<string, string>;
  extras: Record<string, number>;
}

// The exact diagnostic suffix the observed HQ-DESKTOP-5Y event carried, so the
// pre-fix arm reproduces its title byte-for-byte.
const DIAG = ' [uptime=22m10s; last_rss=755MB (tree, sampled 10s before exit)]';

/** Rust `Debug` for an `Option<i32>`. */
function debugOption(value: number | null): string {
  return value === null ? 'None' : `Some(${value})`;
}

/** Mirrors classify_windows_exit_status: only the NTSTATUS fault range here. */
function windowsFaultHex(code: number): string | null {
  const unsigned = code >>> 0;
  if (unsigned >= 0xc000_0000) {
    return `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`;
  }
  return null;
}

/** Mirrors hq_desktop_core::sync_outcome::describe_exit. */
function describeExit(code: number | null, signal: number | null): string {
  if (code !== null) {
    const hex = windowsFaultHex(code);
    if (hex) return `with Windows status ${hex} (fault)`;
    return `with code ${code}`;
  }
  switch (signal) {
    case 9:
      return 'killed by SIGKILL (likely OOM or force-quit)';
    case 15:
      return 'killed by SIGTERM (cancelled)';
    case 11:
      return 'crashed with SIGSEGV (segfault)';
    case 10:
      return 'crashed with SIGBUS';
    case 6:
      return 'aborted with SIGABRT';
    case 2:
      return 'killed by SIGINT';
    case 1:
      return 'killed by SIGHUP';
    case null:
      return 'with code unknown';
    default:
      return `killed by signal ${signal}`;
  }
}

/** Mirrors normalized_abort_description. */
function normalizedAbort(code: number | null, signal: number | null, host: Host): string | null {
  if (signal === 6) return 'aborted with SIGABRT';
  if (code === 134 && signal === null && host === 'windows') {
    return 'aborted (Node abort exit code 134)';
  }
  return null;
}

/** Mirrors watcher_exit_signal_class. */
function signalClass(signal: number | null): string {
  if (signal === null) return 'none';
  if ([4, 6, 7, 9, 10, 11].includes(signal)) return 'fault';
  if (signal === 15) return 'cancel';
  if (signal === 1) return 'hangup';
  if (signal === 2) return 'interrupt';
  return 'other';
}

/** Mirrors watcher_termination_fingerprint_token with NO memory evidence. */
function fingerprintToken(code: number | null, signal: number | null, host: Host): string {
  if (normalizedAbort(code, signal, host) !== null) return 'abort:sigabrt';
  if (code !== null && signal !== null) return `invalid:exit:${code}+signal:${signal}`;
  if (signal !== null) return `signal:${signal}`;
  if (code !== null) {
    const hex = windowsFaultHex(code);
    if (hex) return `windows:fault:${hex}`;
    return `exit:${code}`;
  }
  return 'unknown';
}

/** The parenthesised rendering the message carries, per build. */
function exitRendering(scenario: Scenario, build: Build): string {
  const abort = normalizedAbort(scenario.code, scenario.signal, scenario.host);
  if (abort !== null) return abort;
  const raw = `code=${debugOption(scenario.code)} signal=${debugOption(scenario.signal)}`;
  if (build === 'fixed') {
    if (scenario.code !== null && scenario.signal !== null) return raw;
    return describeExit(scenario.code, scenario.signal);
  }
  // pre-fix: only a Windows-status code reached describe_exit; everything else
  // fell to the raw Debug tuple — including a signal-only SIGHUP.
  if (scenario.code !== null && windowsFaultHex(scenario.code)) {
    return describeExit(scenario.code, scenario.signal);
  }
  return raw;
}

function simulate(scenario: Scenario, build: Build): SimEnvelope {
  const rendering = exitRendering(scenario, build);
  const message = `[sync] auto-sync watcher exited unexpectedly (${rendering}), consecutive failure #1${DIAG}`;
  const tags: Record<string, string> = {};
  const extras: Record<string, number> = {};
  if (build === 'fixed') {
    // The fix adds a queryable class tag; the pre-fix build has neither field, so
    // the signal-only exit was unfilterable except by parsing the title.
    tags.watcher_exit_signal_class = signalClass(scenario.signal);
    if (scenario.signal !== null) extras.watcher_exit_signal = scenario.signal;
  }
  return {
    message,
    fingerprintToken: fingerprintToken(scenario.code, scenario.signal, scenario.host),
    tags,
    extras,
  };
}

const SIGHUP: Scenario = { code: null, signal: 1, host: 'posix' };
const SIGABRT: Scenario = { code: null, signal: 6, host: 'posix' };
const WINDOWS_FAULT: Scenario = { code: 0xc000_0409, signal: null, host: 'windows' };

describe('watcher hangup attribution — shipped Sentry envelope', () => {
  it('names the SIGHUP and attaches a queryable class + signal', () => {
    const envelope = simulate(SIGHUP, 'fixed');
    expect(envelope.message).toBe(
      '[sync] auto-sync watcher exited unexpectedly (killed by SIGHUP), ' +
        'consecutive failure #1' +
        DIAG,
    );
    expect(envelope.message).not.toContain('signal=Some(1)');
    expect(envelope.tags.watcher_exit_signal_class).toBe('hangup');
    expect(envelope.extras.watcher_exit_signal).toBe(1);
    expect(envelope.fingerprintToken).toBe('signal:1');
  });

  it('reproduces the exact HQ-DESKTOP-5Y title under the pre-fix renderer', () => {
    const envelope = simulate(SIGHUP, 'pre-fix');
    // Byte-for-byte the observed Sentry title — the anti-vacuity arm.
    expect(envelope.message).toBe(
      '[sync] auto-sync watcher exited unexpectedly (code=None signal=Some(1)), ' +
        'consecutive failure #1 [uptime=22m10s; last_rss=755MB (tree, sampled 10s before exit)]',
    );
    // And the pre-fix build had no queryable class tag at all.
    expect(envelope.tags.watcher_exit_signal_class).toBeUndefined();
  });

  it('changes the SIGHUP message but not its grouping', () => {
    const fixed = simulate(SIGHUP, 'fixed');
    const preFix = simulate(SIGHUP, 'pre-fix');
    expect(fixed.message).not.toBe(preFix.message);
    // Grouping is by fingerprint, which is message-independent: SIGHUP stays
    // signal:1 across the change, so no issue regroups or splits.
    expect(fixed.fingerprintToken).toBe(preFix.fingerprintToken);
    expect(fixed.fingerprintToken).toBe('signal:1');
  });

  it('leaves already-named SIGABRT and Windows-fault renderings byte-identical', () => {
    for (const scenario of [SIGABRT, WINDOWS_FAULT]) {
      const fixed = simulate(scenario, 'fixed');
      const preFix = simulate(scenario, 'pre-fix');
      expect(fixed.message).toBe(preFix.message);
      expect(fixed.fingerprintToken).toBe(preFix.fingerprintToken);
    }
    expect(simulate(SIGABRT, 'fixed').message).toContain('aborted with SIGABRT');
    expect(simulate(SIGABRT, 'fixed').fingerprintToken).toBe('abort:sigabrt');
    expect(simulate(WINDOWS_FAULT, 'fixed').message).toContain('with Windows status 0xC0000409');
    expect(simulate(WINDOWS_FAULT, 'fixed').fingerprintToken).toBe('windows:fault:0xC0000409');
  });

  it('carries only content-safe diagnostics', () => {
    assertContentSafeDiagnostics(simulate(SIGHUP, 'fixed'));
  });
});
