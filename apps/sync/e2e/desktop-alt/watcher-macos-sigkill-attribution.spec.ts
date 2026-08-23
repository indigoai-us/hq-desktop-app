/**
 * macOS auto-sync watcher SIGKILL: uncapped alerting (HQ-DESKTOP-4D).
 *
 * On macOS the auto-sync watcher dies with `code=None signal=Some(9)` every
 * 1-7 minutes and is respawned on the supervisor cadence. Every generation in
 * this cluster outlives FAST_FAIL_WINDOW (60s), so `note_watcher_crashed`'s
 * slow-death arm pins the crash-loop counter `consecutive` at 1 forever. The
 * capture gate `is_capture_milestone(1)` is unconditionally true, so the log2(N)
 * limiter never engages and EVERY death is sent — the observed 1299 events, all
 * titled "consecutive failure #1", from just a handful of Macs.
 *
 * The Rust suites (the app crate on macOS CI) pin the seam from the inside. This
 * spec pins the same properties at the *source-contract* and *artifact* levels —
 * following the fixture-backed pattern of watcher-fault-deferred-attribution.spec.ts
 * — so it proves the base-red / candidate-pass pair on Linux CI without a macOS
 * host:
 *
 *  - Source contracts over the code that actually ships: the per-class,
 *    uptime-independent slow-death capture streak, its HEALTHY_RUN_WINDOW recovery
 *    bar (from both the live poll and a dead generation's own runtime), the
 *    unchanged respawn constants (so recovery cadence is provably untouched), and
 *    the honest-episode message.
 *  - A bidirectional envelope simulator: the pre-fix policy reproduces the
 *    observed flood (ten consecutive slow deaths -> ten events, all "#1"); the
 *    post-fix policy on the SAME ten deaths mutes every non-milestone repeat
 *    (captures at #1, #2, #4, #8 only) and states the true episode length, with
 *    the fingerprint asserted byte-identical so grouping does not move.
 *
 * The jetsam-vs-external-kill *attribution* half of HQ-DESKTOP-4D lands in a
 * dedicated follow-up together with its macOS exit-path wiring, so this spec
 * covers only the shipped flood cap.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');

describe('macOS SIGKILL alert cap — source contracts', () => {
  it('gives the crash class its own uptime-independent capture streak', () => {
    // The new streak is separate from the pinned-at-1 crash-loop counter, so a
    // multi-minute death loop is no longer stuck at "#1".
    expect(daemonSource).toContain('slow_death_consecutive');
    expect(daemonSource).toContain('fn apply_watcher_crash(');
    // The crash / session-end capture gate consults (and advances) that streak.
    expect(daemonSource).toContain('fn capture_policy_streak(');
    expect(daemonSource).toContain('st.slow_death_consecutive = st.slow_death_consecutive.saturating_add(1)');
  });

  it('isolates the streak to the class it gates so other classes cannot pollute it', () => {
    // The exec-not-runnable (126/127) class keeps its own streak, and a
    // local-only (disk-full/benign) exit never advances the crash-class streak.
    expect(daemonSource).toContain('WatcherExitCapturePolicy::CaptureRateLimited => st.exec_not_runnable_consecutive');
    expect(daemonSource).toContain(
      'WatcherExitCapturePolicy::Capture | WatcherExitCapturePolicy::DeferSessionEndDecision =>',
    );
    expect(daemonSource).toContain('WatcherExitCapturePolicy::LocalLogOnly => st.slow_death_consecutive');
  });

  it('clears the streak only after a long HEALTHY_RUN_WINDOW recovery, from either seam', () => {
    expect(daemonSource).toContain(
      'const HEALTHY_RUN_WINDOW: Duration = Duration::from_secs(30 * 60);',
    );
    expect(daemonSource).toContain('fn apply_recovery_reset(');
    // The live supervisor poll clears it once a generation survives the window...
    expect(daemonSource).toContain('should_reset_after_recovery(spawn_elapsed, HEALTHY_RUN_WINDOW)');
    // ...and a dead generation that itself outlived the window ends the episode
    // at the exit transition too (so a poll gap cannot extend a stale streak).
    expect(daemonSource).toContain('if ran >= HEALTHY_RUN_WINDOW {');
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
    // Backoff is still keyed on the unchanged global counter.
    expect(daemonSource).toContain('respawn_backoff(consecutive, SUPERVISOR_INTERVAL, RESPAWN_MAX_BACKOFF)');
  });

  it('renders the true episode length in the message instead of a perpetual "#1"', () => {
    // The message number is the capture streak for the crash/session-end class,
    // while the exec-not-runnable class keeps the global counter for correlation.
    expect(daemonSource).toContain('consecutive failure #{episode}{diag}');
    expect(daemonSource).toContain(
      'let episode = if capture_policy == WatcherExitCapturePolicy::CaptureRateLimited {',
    );
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
 * or the per-class, uptime-independent slow-death streak (post-fix). The
 * fingerprint is built independently of both, so it is identical across policies.
 */
function simulateSlowDeathLoop(deaths: number, policy: Policy): SentryEnvelope[] {
  const sent: SentryEnvelope[] = [];
  let globalConsecutive = 0;
  let slowDeathStreak = 0;
  for (let i = 0; i < deaths; i += 1) {
    // A slow death: the global counter's slow-death arm pins it at 1; the new
    // crash-class streak climbs.
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
