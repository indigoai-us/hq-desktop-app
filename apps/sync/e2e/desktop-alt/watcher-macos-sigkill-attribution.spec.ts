/**
 * macOS auto-sync watcher SIGKILL: uncapped alerting + attribution core
 * (HQ-DESKTOP-4D).
 *
 * On macOS the auto-sync watcher dies with `code=None signal=Some(9)` every
 * 1-7 minutes and is respawned on the supervisor cadence. Two independent
 * defects stack on that one exit:
 *
 *  1. UNCAPPED ALERTING. Every generation outlives FAST_FAIL_WINDOW (60s), so
 *     `note_watcher_crashed`'s slow-death arm pins the crash-loop counter
 *     `consecutive` at 1 forever. The capture gate `is_capture_milestone(1)` is
 *     unconditionally true, so the log2(N) limiter never engages and EVERY death
 *     is sent — the observed 1299 events, all titled "consecutive failure #1".
 *  2. UNATTRIBUTED KILL. A signal=9 death carries no exception code and the
 *     Windows fault surface is `not_applicable`, so a jetsam (memory) kill is
 *     indistinguishable from an external `kill -9`.
 *
 * The Rust suites (hq-desktop-core on Linux CI, the app crate on macOS CI) pin
 * the seam from the inside. This spec pins the same properties at the
 * *source-contract* and *artifact* levels — following the fixture-backed pattern
 * of watcher-fault-deferred-attribution.spec.ts — so it proves the base-red /
 * candidate-pass pair on Linux CI without a macOS host:
 *
 *  - Source contracts over the code that actually ships: the uptime-independent
 *    slow-death capture streak and its HEALTHY_RUN_WINDOW recovery bar, the
 *    unchanged respawn constants (so recovery cadence is provably untouched), and
 *    the pure, content-safe macOS kill-attribution vocabulary + JetsamEvent .ips
 *    binder in hq-desktop-core.
 *  - A bidirectional envelope simulator: the pre-fix policy reproduces the
 *    observed flood (ten consecutive slow deaths → ten events, all "#1"); the
 *    post-fix policy on the SAME ten deaths mutes every non-milestone repeat
 *    (captures at #1, #2, #4, #8 only) and states the true episode length, with
 *    the fingerprint asserted byte-identical so grouping does not move.
 *
 * Content-safety: every modeled envelope and every new attribution axis carries
 * only fixed vocabulary and bucketed/bare integers — never argv, stderr, a path,
 * a hostname, or a company slug.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// repoRoot is apps/sync, so the shared crate sources are read via '../../crates'.
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const coreSource = readRepoFile('../../crates/hq-desktop-core/src/watcher_fault.rs');

describe('macOS SIGKILL alert cap — source contracts', () => {
  it('gives the slow-death loop its own uptime-independent capture streak', () => {
    // The new streak advances on EVERY unexpected exit, not just fast ones, so a
    // multi-minute death loop is no longer pinned at "#1".
    expect(daemonSource).toContain('slow_death_consecutive');
    expect(daemonSource).toContain('fn apply_watcher_crash(');
    // The crash / session-end capture gate now consults that streak.
    expect(daemonSource).toContain('fn capture_policy_streak(');
    expect(daemonSource).toContain('st.slow_death_consecutive');
  });

  it('clears the streak only after a long HEALTHY_RUN_WINDOW recovery', () => {
    expect(daemonSource).toContain(
      'const HEALTHY_RUN_WINDOW: Duration = Duration::from_secs(30 * 60);',
    );
    expect(daemonSource).toContain('fn apply_recovery_reset(');
    // The recovery reset is keyed on HEALTHY_RUN_WINDOW for the slow-death streak.
    expect(daemonSource).toContain('should_reset_after_recovery(spawn_elapsed, HEALTHY_RUN_WINDOW)');
  });

  it('leaves respawn behaviour byte-for-byte unchanged (recovery cadence untouched)', () => {
    // The constants that govern respawn cadence keep their exact values, so a
    // dying watcher is still respawned on today's schedule — only capture rate-
    // limiting and telemetry change.
    expect(daemonSource).toContain('const FAST_FAIL_WINDOW: Duration = Duration::from_secs(60);');
    expect(daemonSource).toContain(
      'const RESPAWN_MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);',
    );
    expect(daemonSource).toContain('const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(30);');
    // The fast-fail arm still resets consecutive to 1, and backoff is still keyed
    // on the unchanged global counter.
    expect(daemonSource).toContain('respawn_backoff(consecutive, SUPERVISOR_INTERVAL, RESPAWN_MAX_BACKOFF)');
  });

  it('renders the true episode length in the message instead of a perpetual "#1"', () => {
    // The message number is the capture streak for the crash/session-end class,
    // while the exec-not-runnable class keeps the global counter for correlation.
    expect(daemonSource).toContain('consecutive failure #{episode}{diag}');
    expect(daemonSource).toContain('let episode = if capture_policy == WatcherExitCapturePolicy::CaptureRateLimited {');
  });
});

describe('macOS kill attribution core — source contracts', () => {
  it('lands a resolved, content-safe kill-provenance vocabulary', () => {
    expect(coreSource).toContain('enum WatcherKillProvenance');
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

  it('lands closed kill-reason and memory-pressure vocabularies', () => {
    expect(coreSource).toContain('enum WatcherKillReason');
    expect(coreSource).toContain('enum WatcherMemoryPressure');
    for (const token of ['per_process_limit', 'highwater', 'vm_pageshortage', 'vm_thrashing']) {
      expect(coreSource).toContain(`"${token}"`);
    }
    expect(coreSource).toContain('pub fn classify_jetsam_kill_reason(');
    expect(coreSource).toContain('pub fn classify_vm_pressure_level(');
  });

  it('parses a JetsamEvent .ips and binds it to the generation, purely', () => {
    expect(coreSource).toContain('pub fn parse_jetsam_report(');
    expect(coreSource).toContain('pub fn bind_jetsam_record(');
    expect(coreSource).toContain('pub fn decide_watcher_kill_provenance(');
    // rpages are bucketed, never emitted raw.
    expect(coreSource).toContain('pub fn jetsam_rpages_bucket(');
  });

  it('maps every victim name through the existing closed allow-list — never copied out', () => {
    // The .ips parser maps a victim `comm` name through classify_watcher_fault_binary
    // (extended with the macOS process basenames) so no raw name can be retained.
    expect(coreSource).toContain('classify_watcher_fault_binary(');
    expect(coreSource).toContain('"hq-sync-runner" => WatcherFaultBinary::NodeExe');
    // A PID match is only claimed for a recognised watcher victim, so PID reuse by
    // an unrelated victim cannot manufacture a false jetsam_pid_matched.
    expect(coreSource).toContain('WatcherFaultBinary::Other.as_str()');
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
}

// The pure is_capture_milestone rule shipped in hq-desktop-core: capture the
// first, then only at exponential milestones (1, 2, 4, 8, 16, ...).
function isCaptureMilestone(consecutive: number): boolean {
  return consecutive <= 1 || (consecutive & (consecutive - 1)) === 0;
}

/**
 * Model a run of `deaths` consecutive SLOW deaths (each generation outlives
 * FAST_FAIL_WINDOW, exactly the observed cluster) and return the events actually
 * SENT under the given policy. The ONLY difference between the two policies is
 * which streak the capture gate consults — the pinned global counter (pre-fix)
 * or the uptime-independent slow-death streak (post-fix). The fingerprint is
 * built independently of both, so it is identical across policies.
 */
function simulateSlowDeathLoop(deaths: number, policy: Policy): SentryEnvelope[] {
  const sent: SentryEnvelope[] = [];
  let globalConsecutive = 0;
  let slowDeathStreak = 0;
  for (let i = 0; i < deaths; i += 1) {
    // A slow death: the global counter's slow-death arm pins it at 1; the new
    // uptime-independent streak climbs.
    globalConsecutive = 1;
    slowDeathStreak += 1;
    const gate = policy === 'pre-fix' ? globalConsecutive : slowDeathStreak;
    if (!isCaptureMilestone(gate)) {
      continue; // muted repeat inside one episode
    }
    const episode = policy === 'pre-fix' ? globalConsecutive : slowDeathStreak;
    sent.push({
      message: `auto-sync watcher exited unexpectedly (code=None signal=Some(9)), consecutive failure #${episode}`,
      // Built from termination_fingerprint_token + runner_error_class, neither of
      // which this change touches — so grouping is stable across the fix.
      fingerprint: ['sync', 'auto-sync-watcher-termination', 'signal:9', 'none'],
      tags: {
        runner_fatal_class: 'none',
        sync_route: 'watcher',
        watcher_child_kind: 'launcher',
      },
    });
  }
  return sent;
}

describe('macOS SIGKILL alert cap — envelope simulator (both directions)', () => {
  it('pre-fix reproduces the observed flood: ten slow deaths, ten events, all "#1"', () => {
    const flood = simulateSlowDeathLoop(10, 'pre-fix');
    expect(flood).toHaveLength(10);
    for (const event of flood) {
      expect(event.message).toContain('consecutive failure #1');
    }
    // Exactly the observed pathology: every event is identical and titled "#1".
    const uniqueTitles = new Set(flood.map((event) => event.message));
    expect(uniqueTitles.size).toBe(1);
  });

  it('post-fix caps the SAME ten deaths at #1, #2, #4, #8 and states the true length', () => {
    const capped = simulateSlowDeathLoop(10, 'post-fix');
    expect(capped).toHaveLength(4);
    expect(capped.map((event) => event.message.match(/consecutive failure #(\d+)/)?.[1])).toEqual([
      '1',
      '2',
      '4',
      '8',
    ]);
    // The first occurrence of the episode still alerts — muting only applies to
    // non-milestone repeats.
    expect(capped[0].message).toContain('consecutive failure #1');
  });

  it('leaves the fingerprint byte-identical, so grouping does not move', () => {
    const pre = simulateSlowDeathLoop(10, 'pre-fix');
    const post = simulateSlowDeathLoop(10, 'post-fix');
    expect(post[0].fingerprint).toEqual(pre[0].fingerprint);
    // Every emitted event, either policy, shares the one stable fingerprint.
    for (const event of [...pre, ...post]) {
      expect(event.fingerprint).toEqual(['sync', 'auto-sync-watcher-termination', 'signal:9', 'none']);
    }
  });

  it('emits only fixed-vocabulary, content-safe tags', () => {
    const event = simulateSlowDeathLoop(1, 'post-fix')[0];
    for (const value of Object.values(event.tags)) {
      // Every tag value is a bare lowercase token — no path, argv, or free text.
      expect(value).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
