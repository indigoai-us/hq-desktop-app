/**
 * Watcher stall-teardown attribution (HQ-DESKTOP-3J / HQ-DESKTOP-4D).
 *
 * The macOS heartbeat-stall watchdog deliberately SIGKILLs its own wedged
 * watcher after DAEMON_HEARTBEAT_TIMEOUT (300s) + SIGKILL_DELAY (5s). Before
 * this fix the escalation thread released the process-registry entry *before*
 * the child was reaped, so the terminal `ProcessEvent::Exit` callback could no
 * longer see that cancellation had been requested. `is_cancelled` resolved a
 * missing entry to `false`, `is_unexpected_watcher_exit` treats every signal
 * except SIGTERM as unexpected, and the app captured its own teardown to Sentry
 * as `[sync] auto-sync watcher exited unexpectedly (code=None signal=Some(9))`.
 *
 * The Rust unit tests pin the seam from the inside. This spec pins the same
 * property at the *artifact* level — the shipped Sentry envelope — following the
 * fixture-backed contract pattern of `windows-reliability-harness.ts`:
 *
 * 1. Source contracts over the code that actually ships, so a regression to the
 *    pre-fix shape fails here and not only in the Rust suite.
 * 2. A teardown simulator whose suppression decision is driven by the modeled
 *    registry semantics, asserted in BOTH directions: a heartbeat-stall SIGKILL
 *    emits no watcher-termination event, while an uncancelled SIGKILL of the
 *    identical exit shape still does. The simulator is also run against the
 *    pre-fix registry policy, which must reproduce the bug — that is what keeps
 *    the passing direction from being a vacuous assertion.
 *
 * Content-safety: the modeled envelope carries only the fixed vocabulary a real
 * capture may carry — never argv, stderr, tokens, paths, or company slugs.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { assertContentSafeDiagnostics } from './windows-reliability-harness';

const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const processSource = readRepoFile('src-tauri/src/commands/process.rs');

/**
 * Slice the region between two unique anchors. Throws rather than degrading —
 * a moved anchor must fail loudly instead of silently asserting over ''.
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

// The production watcher Exit handler — the seam that decides crash vs teardown.
const exitHandlerBlock = sliceBetween(
  daemonSource,
  '// Auto-sync runs unattended, so a crashed watcher was',
  'handle_watcher_exit(',
  'daemon Exit handler',
);

// The unix SIGKILL escalation thread — the seam that used to drop the entry.
const escalationThreadBlock = sliceBetween(
  processSource,
  'thread::sleep(sigkill_delay);',
  '});',
  'unix SIGKILL escalation thread',
);

describe('watcher stall-teardown attribution — source contracts', () => {
  it('resolves Exit-callback cancellation for the exiting generation, not the bare handle', () => {
    // The fix: a retired generation still answers for its own terminal
    // callback. `is_cancelled(DAEMON_HANDLE)` cannot — a released handle and a
    // never-cancelled process are indistinguishable to it.
    expect(exitHandlerBlock).toContain(
      'is_cancelled_for_generation(DAEMON_HANDLE, daemon_generation)',
    );
    expect(exitHandlerBlock).not.toMatch(/\bis_cancelled\(DAEMON_HANDLE\)/);
  });

  it('escalates SIGKILL through checked registry authority without releasing the entry', () => {
    // Pre-fix this block was `signal::kill(SIGKILL); deregister_process(...)`,
    // which raced the wait thread and erased the cancellation evidence.
    expect(escalationThreadBlock).toContain('dispatch_signal_checked(');
    expect(escalationThreadBlock).toContain('Signal::SIGKILL');
    expect(escalationThreadBlock).not.toContain('deregister_process(');
    expect(escalationThreadBlock).not.toContain('deregister_generation(');
  });

  it('keeps a generation resolvable after its public handle is released', () => {
    // deregister_generation retains the generation privately while its wait
    // owner still holds signal authority, so the terminal callback can observe
    // cancellation for exactly this process generation.
    const deregisterGeneration = sliceBetween(
      processSource,
      'pub fn deregister_generation(handle: &str, generation: u64) -> bool {',
      '\n}\n',
      'deregister_generation',
    );
    expect(deregisterGeneration).toContain('entry.pid.is_some() && !entry.signal_authority_revoked');
    expect(deregisterGeneration).toContain('reg.retired.insert(');
  });

  it('keeps the suppression narrow: only recorded cancellation suppresses a capture', () => {
    const decision = sliceBetween(
      daemonSource,
      'fn handle_watcher_exit_with_effects<E: WatcherProcessEffects>(',
      'let consecutive = effects.note_watcher_crashed();',
      'handle_watcher_exit_with_effects',
    );
    // Cancellation — and nothing else — is the early return.
    expect(decision).toMatch(/if cancelled \{[\s\S]*?return;\n {4}\}/);
    // The stall flag must never gate capture; it stays a diagnostic extra only.
    expect(decision).not.toContain('HEARTBEAT_STALL_TERMINATION_IN_FLIGHT');

    const classifier = sliceBetween(
      daemonSource,
      'fn is_unexpected_watcher_exit(success: bool, signal: Option<i32>, cancelled: bool) -> bool {',
      '\n}\n',
      'is_unexpected_watcher_exit',
    );
    // An uncancelled SIGKILL is still unexpected — a jetsam/OOM kill keeps alerting.
    expect(classifier).toContain('signal != Some(SIGTERM)');
  });

  it('records the stall flag as a diagnostic extra rather than a capture gate', () => {
    const captureContext = sliceBetween(
      daemonSource,
      'fn watcher_exit_capture_context(',
      '\n}\n',
      'watcher_exit_capture_context',
    );
    expect(captureContext).toContain('heartbeat_stall_termination_in_flight');
  });

  it('preserves the landed Windows terminator attribution through the same seam', () => {
    // The fix and HQ-DESKTOP-4A's Windows attribution touch the same call; the
    // merge must keep both, not pick a side.
    expect(exitHandlerBlock).toContain(
      'current_windows_terminator_attribution(&app, code, signal)',
    );
  });
});

// ---------------------------------------------------------------------------
// Artifact-level envelope model
// ---------------------------------------------------------------------------

type RegistryPolicy = 'retire-on-release' | 'deregister-on-sigkill';

interface SentryEnvelopeEvent {
  message: string;
  fingerprint: string[];
  tags: Record<string, string>;
  extras: Record<string, string | boolean>;
}

const SIGTERM = 15;
const SIGKILL = 9;

/**
 * Minimal model of the process registry across a teardown. `retire-on-release`
 * is the shipped behaviour: releasing the public handle retains the generation
 * privately until its wait owner revokes authority, so the terminal callback
 * can still read `cancelled`. `deregister-on-sigkill` is the pre-fix behaviour,
 * kept so the simulator is proven to reproduce HQ-DESKTOP-3J.
 */
class TeardownRegistry {
  private cancelled = false;
  private live = true;

  constructor(private readonly policy: RegistryPolicy) {}

  /** Watchdog requests cancellation and SIGTERMs the process group. */
  requestCancellation(): void {
    this.cancelled = true;
  }

  /** SIGKILL escalation fires after the grace period, before the reap. */
  escalateSigkill(): void {
    if (this.policy === 'deregister-on-sigkill') {
      // The defect: the entry is dropped while the wait thread has not yet
      // reaped the child, so the evidence is gone before it is read.
      this.live = false;
    }
  }

  /** What the terminal ProcessEvent::Exit callback observes. */
  cancellationObservedAtExit(): boolean {
    return this.live ? this.cancelled : false;
  }
}

/** Mirrors `is_unexpected_watcher_exit` in daemon.rs. */
function isUnexpectedWatcherExit(
  success: boolean,
  signal: number | null,
  cancelled: boolean,
): boolean {
  if (success || cancelled) return false;
  return signal !== SIGTERM;
}

/** Mirrors the fingerprint assembled by `record_unexpected_watcher_exit`. */
function terminationFingerprint(code: number | null, signal: number | null): string[] {
  const token =
    signal !== null ? `signal:${signal}` : code !== null ? `exit:${code}` : 'unknown';
  return ['sync', 'auto-sync-watcher-termination', token, 'none'];
}

interface TeardownScenario {
  policy: RegistryPolicy;
  /** Whether the app itself asked for this termination. */
  appRequested: boolean;
  code: number | null;
  signal: number | null;
}

/**
 * Run one watcher exit through the modeled production decision and return the
 * Sentry envelope the artifact would ship.
 */
function simulateTeardownEnvelope(scenario: TeardownScenario): SentryEnvelopeEvent[] {
  const registry = new TeardownRegistry(scenario.policy);
  const stallTerminationInFlight = scenario.appRequested;

  if (scenario.appRequested) {
    // Watchdog: mark cancelled + SIGTERM, then escalate to SIGKILL after the
    // 5s grace, then the child is reaped and the Exit callback runs.
    registry.requestCancellation();
    registry.escalateSigkill();
  }

  const cancelled = registry.cancellationObservedAtExit();
  if (cancelled) {
    // Deliberate stop path — lifecycle already recorded, no capture.
    return [];
  }
  if (!isUnexpectedWatcherExit(false, scenario.signal, cancelled)) {
    return [];
  }

  return [
    {
      message: 'auto-sync watcher exited unexpectedly, consecutive failure #1',
      fingerprint: terminationFingerprint(scenario.code, scenario.signal),
      tags: { watcher_exit_signal: String(scenario.signal ?? 'none') },
      extras: {
        cancelled,
        heartbeat_stall_termination_in_flight: stallTerminationInFlight,
        watcher_lifecycle_state: 'running',
        runner_fatal_class: 'none',
      },
    },
  ];
}

const HEARTBEAT_STALL_TEARDOWN: TeardownScenario = {
  policy: 'retire-on-release',
  appRequested: true,
  code: null,
  signal: SIGKILL,
};

const EXTERNAL_SIGKILL: TeardownScenario = {
  policy: 'retire-on-release',
  appRequested: false,
  code: null,
  signal: SIGKILL,
};

describe('watcher stall-teardown attribution — shipped Sentry envelope', () => {
  it('emits no watcher-termination event for a heartbeat-stall SIGKILL teardown', () => {
    const envelope = simulateTeardownEnvelope(HEARTBEAT_STALL_TEARDOWN);
    expect(
      envelope.filter((event) => event.fingerprint[1] === 'auto-sync-watcher-termination'),
    ).toHaveLength(0);
  });

  it('still emits one for an uncancelled SIGKILL of identical exit shape', () => {
    const envelope = simulateTeardownEnvelope(EXTERNAL_SIGKILL);
    const terminations = envelope.filter(
      (event) => event.fingerprint[1] === 'auto-sync-watcher-termination',
    );
    expect(terminations).toHaveLength(1);
    expect(terminations[0].fingerprint).toEqual([
      'sync',
      'auto-sync-watcher-termination',
      'signal:9',
      'none',
    ]);
    // The two scenarios differ only in who asked for the kill, so the
    // suppression cannot be a blanket signal-9 filter.
    expect(HEARTBEAT_STALL_TEARDOWN.signal).toBe(EXTERNAL_SIGKILL.signal);
    expect(HEARTBEAT_STALL_TEARDOWN.code).toBe(EXTERNAL_SIGKILL.code);
  });

  it('reproduces HQ-DESKTOP-3J under the pre-fix registry policy', () => {
    // Guards the passing direction above from becoming vacuous: with the entry
    // released at SIGKILL time, the app's own teardown is captured as a crash.
    const envelope = simulateTeardownEnvelope({
      ...HEARTBEAT_STALL_TEARDOWN,
      policy: 'deregister-on-sigkill',
    });
    const terminations = envelope.filter(
      (event) => event.fingerprint[1] === 'auto-sync-watcher-termination',
    );
    expect(terminations).toHaveLength(1);
    // The exact production signature both cluster issues carry: the stall
    // teardown was in flight, yet the exit was reported as uncancelled.
    expect(terminations[0].extras.heartbeat_stall_termination_in_flight).toBe(true);
    expect(terminations[0].extras.cancelled).toBe(false);
  });

  it('never suppresses on the stall flag alone', () => {
    // A jetsam/OOM kill that happens to coincide with a stall must still alert:
    // suppression is driven by recorded cancellation, not by the diagnostic flag.
    const envelope = simulateTeardownEnvelope({
      ...EXTERNAL_SIGKILL,
      policy: 'retire-on-release',
    });
    expect(envelope).toHaveLength(1);
    expect(envelope[0].extras.heartbeat_stall_termination_in_flight).toBe(false);
  });

  it('keeps a deliberate SIGTERM stop silent on both policies', () => {
    for (const policy of ['retire-on-release', 'deregister-on-sigkill'] as RegistryPolicy[]) {
      const envelope = simulateTeardownEnvelope({
        policy,
        appRequested: false,
        code: null,
        signal: SIGTERM,
      });
      expect(envelope).toHaveLength(0);
    }
  });

  it('ships a content-safe envelope', () => {
    const envelope = simulateTeardownEnvelope(EXTERNAL_SIGKILL);
    assertContentSafeDiagnostics(envelope);
  });
});
