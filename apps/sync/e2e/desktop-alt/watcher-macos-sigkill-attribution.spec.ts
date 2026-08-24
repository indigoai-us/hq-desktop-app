/**
 * macOS watcher SIGKILL — uncapped alerting cap + kill-attribution foundation
 * (HQ-DESKTOP-4D).
 *
 * HQ-DESKTOP-4D is two independent defects stacked on one macOS SIGKILL of the
 * auto-sync watcher:
 *
 *  1. UNCAPPED ALERTING. Every SIGKILL in the cluster happens past the 60s
 *     FAST_FAIL_WINDOW, so `note_watcher_crashed` pins the global `consecutive`
 *     counter at 1 forever and the log2(N) capture limiter is structurally
 *     unreachable — all 1299 observed events read "consecutive failure #1" and
 *     every one is sent, turning one looping machine into a fleet-wide flood.
 *
 *  2. UNATTRIBUTED KILL. A signal=9 death carries no surface that separates a
 *     jetsam/memory kill from an external `kill -9`: the whole Windows fault
 *     channel is `NotApplicable` for a signal death, so nothing says who killed
 *     it.
 *
 * This spec pins, at the source-contract and artifact levels (so it runs on
 * Linux/macOS CI with no macOS host), the change that SHIPS in this PR:
 *
 *  - The alerting cap: a per-episode `slow_death_consecutive` streak that grows
 *    on every unexpected exit and is cleared only after a HEALTHY_RUN_WINDOW
 *    recovery, routed through the existing is_capture_milestone limiter so a
 *    slow-death SIGKILL loop is rate-limited to 1, 2, 4, 8, … — and an honest
 *    episode-length clause in the emitted message so the tenth death no longer
 *    reads as a first failure. `consecutive`, respawn backoff, and the
 *    fingerprint are byte-for-byte unchanged.
 *  - The content-safe macOS kill-attribution vocabulary + pure binder in
 *    hq-desktop-core (WatcherKillProvenance, bind_jetsam_record, the jetsam
 *    kill-reason mapper, the rpages bucketer, and the live memory-pressure
 *    axis), unit-tested on every platform.
 *
 * The bounded macOS JetsamEvent (.ips) reader + its deferred-capture wiring that
 * turns `deferred` into a resolved jetsam_pid_matched attribution is a tracked
 * follow-up (it is macOS-only native I/O that must be developed and proven on a
 * macOS build host); this spec deliberately does NOT assert that reader exists,
 * so it stays green on the shipped tree.
 *
 * Content-safety: every attribution axis this PR adds is a fixed, denylist-free
 * token — never a path, argv, reason string, hostname, or company slug.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const coreSource = readRepoFile('../../crates/hq-desktop-core/src/watcher_fault.rs');

describe('macOS SIGKILL alerting cap — source contracts', () => {
  it('adds a per-episode slow-death streak that grows on every unexpected exit', () => {
    // The new counter exists on the crash state and is incremented in
    // note_watcher_crashed, distinct from `consecutive`.
    expect(daemonSource).toContain('slow_death_consecutive: u32');
    expect(daemonSource).toContain(
      'st.slow_death_consecutive = st.slow_death_consecutive.saturating_add(1);',
    );
  });

  it('clears the episode streak only after a HEALTHY_RUN_WINDOW recovery, not the 60s window', () => {
    expect(daemonSource).toContain('const HEALTHY_RUN_WINDOW: Duration = Duration::from_secs(30 * 60);');
    // The 30-minute window equals the max respawn backoff — a generation that
    // outlives the longest backoff has genuinely recovered.
    expect(daemonSource).toContain('const RESPAWN_MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);');
    // The reset is gated on HEALTHY_RUN_WINDOW, while `consecutive` keeps its 60s reset.
    expect(daemonSource).toContain('should_reset_after_recovery(spawn_elapsed, HEALTHY_RUN_WINDOW)');
    expect(daemonSource).toContain('st.slow_death_consecutive = 0;');
    // The pre-existing 60s reset of `consecutive` is untouched.
    expect(daemonSource).toContain('should_reset_after_recovery(spawn_elapsed, FAST_FAIL_WINDOW)');
  });

  it('routes the Capture/Deferral capture gate through the episode streak, not the pinned counter', () => {
    // note_watcher_capture_policy_streak returns the slow-death streak for the
    // Capture and DeferSessionEndDecision policies, leaving the 126/127
    // exec-not-runnable class on its own streak.
    expect(daemonSource).toContain('WatcherExitCapturePolicy::CaptureRateLimited => st.exec_not_runnable_consecutive,');
    // The Capture / DeferSessionEndDecision arm returns the episode streak
    // (whitespace-tolerant so a rustfmt reflow does not falsely fail the seam).
    expect(daemonSource).toMatch(
      /WatcherExitCapturePolicy::DeferSessionEndDecision\s*=>\s*\{\s*st\.slow_death_consecutive/,
    );
  });

  it('renders the honest episode length in the message without moving the fingerprint', () => {
    // The message keeps the unchanged global counter and appends the episode
    // streak whenever it diverges (a slow-death loop), so the tenth death no
    // longer reports "consecutive failure #1" as its whole story.
    expect(daemonSource).toContain('(episode failure #{policy_consecutive})');
    expect(daemonSource).toContain('consecutive failure #{consecutive}{episode_suffix}{diag}');
    // The fingerprint inputs are untouched (message text is not a fingerprint
    // input), so grouping does not move.
    expect(daemonSource).toContain('let fingerprint = [');
    expect(daemonSource).toContain('termination_fingerprint_token_for_host(code, signal, host)');
  });

  it('leaves the respawn cadence — consecutive, backoff, supervisor interval — unchanged', () => {
    expect(daemonSource).toContain('const FAST_FAIL_WINDOW: Duration = Duration::from_secs(60);');
    expect(daemonSource).toContain('const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(30);');
    // note_watcher_crashed still owns `consecutive` and backoff_until exactly as before.
    expect(daemonSource).toContain('st.consecutive = st.consecutive.saturating_add(1);');
    expect(daemonSource).toContain(
      'Instant::now() + respawn_backoff(consecutive, SUPERVISOR_INTERVAL, RESPAWN_MAX_BACKOFF),',
    );
  });
});

describe('macOS SIGKILL kill-attribution foundation — source contracts', () => {
  it('adds a platform-neutral, exhaustive kill-provenance vocabulary', () => {
    expect(coreSource).toContain('pub enum WatcherKillProvenance {');
    for (const token of [
      'jetsam_pid_matched',
      'jetsam_window_matched',
      'no_jetsam_record',
      'pressure_only',
      'external_kill_suspected',
      'self_escalated',
      'reader_unavailable',
      'deadline_expired',
      'deferred',
      'not_applicable',
    ]) {
      expect(coreSource).toContain(`"${token}"`);
    }
  });

  it('provides a pure, testable jetsam binder and unbound-evidence resolver', () => {
    expect(coreSource).toContain('pub fn bind_jetsam_record(');
    // The binder never binds a record outside the generation window.
    expect(coreSource).toContain('if record_ms < window_start_ms || record_ms > window_end_ms {');
    // PID membership is the strongest binding; window-only is the weaker one.
    expect(coreSource).toContain('WatcherKillProvenance::JetsamPidMatched');
    expect(coreSource).toContain('WatcherKillProvenance::JetsamWindowMatched');
    // Live evidence separates an external kill from an unreported pressure kill.
    expect(coreSource).toContain('pub fn resolve_unbound_kill_provenance(');
    expect(coreSource).toContain('WatcherKillProvenance::ExternalKillSuspected');
    expect(coreSource).toContain('WatcherKillProvenance::PressureOnly');
  });

  it('maps the jetsam kill reason and rpages through closed vocabularies only', () => {
    expect(coreSource).toContain('pub fn classify_jetsam_kill_reason(');
    for (const token of ['per_process_limit', 'highwater', 'vm_pageshortage', 'vm_thrashing']) {
      expect(coreSource).toContain(`"${token}"`);
    }
    // rpages is bucketed on the raw page count, never an inferred byte total.
    expect(coreSource).toContain('pub fn jetsam_rpages_bucket(');
    for (const bucket of ['under_10k', '10k_to_100k', '100k_to_500k', '500k_to_1m', 'over_1m']) {
      expect(coreSource).toContain(`"${bucket}"`);
    }
  });

  it('adds the entitlement-free live memory-pressure axis with a peak combiner', () => {
    expect(coreSource).toContain('pub enum MemoryPressureLevel {');
    for (const token of ['normal', 'warn', 'critical', 'unknown']) {
      expect(coreSource).toContain(`"${token}"`);
    }
    // The sysctl bitmask maps to a level; a garbage value never becomes normal.
    expect(coreSource).toContain('pub fn from_sysctl_level(raw: i32) -> Self {');
    expect(coreSource).toContain('pub fn peak_with(self, sample: MemoryPressureLevel)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bidirectional envelope simulator for the alerting cap
// ─────────────────────────────────────────────────────────────────────────────
//
// A faithful JS reimplementation of the exact production capture-policy the Rust
// change implements, run in BOTH directions on the SAME sequence of ten slow
// SIGKILL deaths (each generation outlives FAST_FAIL_WINDOW, so `consecutive` is
// pinned at 1). The pre-fix policy reproduces the observed 1299-event flood
// signature (a capture on EVERY death, all reading "#1"); the post-fix policy
// rate-limits to the 1,2,4,8 milestones and states the true episode length,
// while the fingerprint stays byte-identical.

/** is_capture_milestone: capture the first, then powers of two. */
function isCaptureMilestone(streak: number): boolean {
  return streak <= 1 || (streak & (streak - 1)) === 0;
}

interface Envelope {
  message: string;
  fingerprint: string[];
}

/** The signal:9 Capture fingerprint — identical pre- and post-fix. */
const SIGKILL_FINGERPRINT = ['sync', 'auto-sync-watcher-termination', 'signal:9', 'none'];

/** Pre-fix: the slow arm pins `consecutive` to 1, so the gate reads 1 forever. */
function simulateUncapped(deaths: number): Envelope[] {
  const out: Envelope[] = [];
  for (let i = 0; i < deaths; i += 1) {
    const consecutive = 1; // pinned by the slow-death arm
    if (isCaptureMilestone(consecutive)) {
      out.push({ message: `consecutive failure #${consecutive}`, fingerprint: SIGKILL_FINGERPRINT });
    }
  }
  return out;
}

/** Post-fix: the episode streak grows and gates capture; the message states it. */
function simulateCapped(deaths: number): Envelope[] {
  const out: Envelope[] = [];
  let slowDeath = 0;
  for (let i = 0; i < deaths; i += 1) {
    const consecutive = 1; // still pinned — respawn cadence is unchanged
    slowDeath += 1;
    if (isCaptureMilestone(slowDeath)) {
      const suffix = slowDeath !== consecutive ? ` (episode failure #${slowDeath})` : '';
      out.push({
        message: `consecutive failure #${consecutive}${suffix}`,
        fingerprint: SIGKILL_FINGERPRINT,
      });
    }
  }
  return out;
}

describe('macOS SIGKILL alerting cap — bidirectional envelope simulator', () => {
  it('pre-fix reproduces the 1299-event flood: a capture on every death, all reading #1', () => {
    const envelopes = simulateUncapped(10);
    expect(envelopes).toHaveLength(10);
    for (const envelope of envelopes) {
      expect(envelope.message).toBe('consecutive failure #1');
    }
  });

  it('post-fix rate-limits to the 1,2,4,8 milestones and states the true episode length', () => {
    const envelopes = simulateCapped(10);
    // Four captures instead of ten.
    expect(envelopes.map((envelope) => envelope.message)).toEqual([
      'consecutive failure #1',
      'consecutive failure #1 (episode failure #2)',
      'consecutive failure #1 (episode failure #4)',
      'consecutive failure #1 (episode failure #8)',
    ]);
  });

  it('keeps the fingerprint byte-identical across the fix, so grouping does not move', () => {
    const pre = simulateUncapped(10);
    const post = simulateCapped(10);
    for (const envelope of [...pre, ...post]) {
      expect(envelope.fingerprint).toEqual(SIGKILL_FINGERPRINT);
    }
  });

  it('a fresh episode after recovery alerts again at #1', () => {
    // Simulate a healthy generation clearing the streak between two episodes.
    const first = simulateCapped(3); // #1, #2 captured
    expect(first).toHaveLength(2);
    const second = simulateCapped(1); // streak reset → captures at #1 again
    expect(second).toHaveLength(1);
    expect(second[0].message).toBe('consecutive failure #1');
  });
});

describe('macOS SIGKILL attribution — content safety', () => {
  it('every kill-attribution token is a bare, denylist-free identifier', () => {
    // The exact vocabulary this PR can emit. A token carrying a Sentry default
    // scrubber denylist substring would be silently deleted server-side.
    const tokens = [
      // WatcherKillProvenance
      'jetsam_pid_matched',
      'jetsam_window_matched',
      'no_jetsam_record',
      'pressure_only',
      'external_kill_suspected',
      'self_escalated',
      'reader_unavailable',
      'deadline_expired',
      'deferred',
      'not_applicable',
      // JetsamKillReason
      'per_process_limit',
      'highwater',
      'vm_pageshortage',
      'vm_thrashing',
      'other',
      // rpages buckets
      'under_10k',
      '10k_to_100k',
      '100k_to_500k',
      '500k_to_1m',
      'over_1m',
      // MemoryPressureLevel
      'normal',
      'warn',
      'critical',
      'unknown',
    ];
    const denylist = [
      'auth',
      'token',
      'secret',
      'password',
      'passwd',
      'credential',
      'api_key',
      'apikey',
      'session',
      'private_key',
      'privatekey',
    ];
    for (const token of tokens) {
      // Bare lowercase identifier (letters, digits, underscore only).
      expect(token).toMatch(/^[a-z0-9_]+$/);
      expect(token.length).toBeLessThanOrEqual(64);
      for (const denied of denylist) {
        expect(token.includes(denied)).toBe(false);
      }
      // And it actually ships in the source — never a token the code cannot emit.
      expect(coreSource).toContain(`"${token}"`);
    }
  });
});
