/**
 * Watcher memory-ceiling attribution (auto-sync watcher child unbounded-memory
 * cluster: HQ-PRO issues 7675812922 / 7676269601 / 7676678003).
 *
 * The auto-sync Node runner is spawned with NO declared memory ceiling, so V8's
 * old-space limit is whatever each host derives from its RAM. One mechanism —
 * the runner's unbounded mid-pull growth — therefore arrives as THREE different
 * termination fingerprints:
 *   - 7675812922: an OS SIGKILL at a 5.9GB tree footprint (signal:9), memory
 *     evidence destroyed;
 *   - 7676269601: a V8 heap-OOM SIGABRT at 3662/3802MB (abort:sigabrt);
 *   - 7676678003: a Windows 0xC0000409 fault whose registered child is the
 *     npx.cmd shim (7MB), so the "memory fact" measured the shim, not the runner.
 *
 * The fix, at the seam the desktop app owns:
 *   1. DECLARE a V8 old-space ceiling in build_watch_runner_args on BOTH spawn
 *      paths (merged into NODE_OPTIONS without clobbering a user value; also in
 *      argv on the node path we own).
 *   2. RECORD the declared ceiling (+ its provenance) on every watcher exit, so a
 *      footprint is interpretable against the ceiling that bounded it.
 *   3. Add a supervisor FOOTPRINT ceiling so the app — not the host — decides the
 *      outcome for the RSS-outruns-heap case.
 *   4. CONVERGE the fingerprint on EVIDENCE only: a heap-OOM class, an at-or-above
 *      ceiling comparable footprint, or a supervisor pre-empt collapse the three
 *      encodings onto one token; an evidence-free SIGKILL stays signal:9.
 *   5. Carry a comparable Windows memory fact so an idle-phase fault is honestly
 *      SEPARATED from the memory mode rather than swept into it.
 *
 * The Rust suites (hq-desktop-core, hq-telemetry, and the app crate) pin the
 * seam from the inside. This spec pins the same properties at the *source-
 * contract* and *artifact* levels, following watcher-heap-oom-attribution.spec.ts:
 * a source contract over the shipping sources, plus a two-direction envelope
 * simulator whose pre-fix direction reproduces the three shipped envelopes so the
 * passing direction stays non-vacuous.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary, bounded
 * integers, and buckets — never argv, stderr, symbols, paths, or company slugs.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { assertContentSafeDiagnostics } from './windows-reliability-harness';

// repoRoot is apps/sync, so the shared crate sources are read via '../../crates'.
const coreDaemonSource = readRepoFile('../../crates/hq-desktop-core/src/daemon.rs');
const coreSyncOutcomeSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
const appDaemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

/**
 * Slice the region between two unique anchors. Throws rather than degrading — a
 * moved anchor must fail loudly instead of silently asserting over ''.
 */
function sliceBetween(source: string, startAnchor: string, endAnchor: string, label: string): string {
  const start = source.indexOf(startAnchor);
  if (start === -1) throw new Error(`${label}: start anchor not found: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (end === -1) throw new Error(`${label}: end anchor not found after start: ${endAnchor}`);
  return source.slice(start, end + endAnchor.length);
}

describe('watcher memory-ceiling attribution — source contracts', () => {
  it('declares a runner heap ceiling in build_watch_runner_args on BOTH spawn paths', () => {
    const fn = sliceBetween(
      coreDaemonSource,
      'pub fn build_watch_runner_args(hq_folder_path: &str) -> SpawnArgs {',
      '// Runner memory ceiling (auto-sync watcher child unbounded-memory cluster)',
      'build_watch_runner_args',
    );
    // The ceiling is merged into NODE_OPTIONS (shared by BOTH the pinned npx path
    // and the bare-node local-runner path)…
    expect(fn).toContain('merge_node_options_ceiling(');
    expect(fn).toContain('env.insert("NODE_OPTIONS"');
    // …and ALSO passed in argv on the node path we own.
    expect(fn).toContain('runner_max_old_space_arg(heap_ceiling)');
    // Both spawn paths still exist and share the same env (which now carries the
    // ceiling), so no platform is left with an undeclared host-derived ceiling.
    expect(fn).toContain('paths::resolve_bin("node")');
    expect(fn).toContain('paths::resolve_bin("npx")');
  });

  it('merges the ceiling without clobbering an inherited or user NODE_OPTIONS', () => {
    // The pure merge preserves an inherited value and yields None (leave as-is)
    // when the user declared their own --max-old-space-size, so the user wins.
    expect(coreDaemonSource).toContain('pub fn merge_node_options_ceiling(');
    expect(coreDaemonSource).toContain('RunnerHeapCeilingSource::UserNodeOptions');
    expect(coreDaemonSource).toContain('pub const RUNNER_HEAP_CEILING_DEFAULT_MB: u32');
    expect(coreDaemonSource).toContain('pub const RUNNER_HEAP_CEILING_ENV: &str');
  });

  it('adds a pure supervisor footprint-ceiling decision, wired into the tick', () => {
    // The pure decision lives in hq-desktop-core (compiles on every CI lane)…
    expect(coreDaemonSource).toContain('pub fn footprint_ceiling_step(');
    expect(coreDaemonSource).toContain('pub const WATCHER_FOOTPRINT_CEILING_MB: u32');
    expect(coreDaemonSource).toContain('WATCHER_FOOTPRINT_CEILING_CONSECUTIVE');
    // …and the app supervisor feeds its scoped sample into it and pre-empts via
    // the RunnerMemory category so the APP decides the outcome.
    expect(appDaemonSource).toContain('note_watcher_footprint_and_decide(');
    expect(appDaemonSource).toContain('FootprintCeilingDecision::Preempt');
    expect(appDaemonSource).toContain('DaemonFailureCategory::RunnerMemory');
  });

  it('gates the fingerprint convergence on evidence in sync_outcome.rs', () => {
    expect(coreSyncOutcomeSource).toContain('pub const RUNNER_MEMORY_EXHAUSTION_TOKEN: &str');
    expect(coreSyncOutcomeSource).toContain('pub struct MemoryExhaustionEvidence');
    expect(coreSyncOutcomeSource).toContain('pub fn watcher_termination_fingerprint_token(');
    const gate = sliceBetween(
      coreSyncOutcomeSource,
      'pub fn watcher_termination_fingerprint_token(',
      '\n}\n',
      'watcher_termination_fingerprint_token',
    );
    // Attributed → the memory token; otherwise byte-for-byte the host token.
    expect(gate).toContain('memory_evidence.is_attributed()');
    expect(gate).toContain('RUNNER_MEMORY_EXHAUSTION_TOKEN');
    expect(gate).toContain('termination_fingerprint_token_for_host(code, signal, host)');
  });

  it('wires the evidence-gated token + ceiling extras at the app exit seam', () => {
    expect(appDaemonSource).toContain('watcher_termination_fingerprint_token(code, signal, host, memory_evidence)');
    expect(appDaemonSource).toContain('"runner_heap_ceiling_mb"');
    expect(appDaemonSource).toContain('"runner_heap_ceiling_source"');
    // The raw host token is preserved when convergence overrides it.
    expect(appDaemonSource).toContain('normalized_abort.is_some() || memory_attributed');
    // A comparable footprint only counts when whole-tree scoped — never a shim.
    expect(appDaemonSource).toContain('resolved_rss_scope == "tree"');
  });

  it('registers the ceiling vocabulary at the telemetry egress boundary', () => {
    expect(telemetrySource).toContain('"runner_heap_ceiling_mb" => Some(value.is_empty() || value.parse::<u32>().is_ok())');
    expect(telemetrySource).toContain('"declared_default" | "env_override" | "user_node_options"');
  });
});

// ---------------------------------------------------------------------------
// Artifact-level envelope model
// ---------------------------------------------------------------------------

type Policy = 'pre-fix' | 'post-fix';
type Host = 'posix' | 'windows';

interface SentryEnvelopeEvent {
  message: string;
  fingerprint: string[];
  tags: Record<string, string>;
  extras: Record<string, string | number>;
}

const MEMORY_TOKEN = 'runner:memory-exhausted';
// Declared ceiling constants, mirrored from hq-desktop-core::daemon.
const RUNNER_HEAP_CEILING_DEFAULT_MB = 2048;
const WATCHER_FOOTPRINT_CEILING_MB = 4608;

/** Mirror of `termination_fingerprint_token_for_host`. */
function hostToken(code: number | null, signal: number | null, host: Host): string {
  // POSIX SIGABRT (6) and Windows Node-abort exit 134 both fold to abort:sigabrt.
  if (signal === 6) return 'abort:sigabrt';
  if (code === 134 && signal === null && host === 'windows') return 'abort:sigabrt';
  if (signal !== null) return `signal:${signal}`;
  if (code !== null) {
    if (host === 'windows') {
      const u = code >>> 0;
      if (u === 0xc0000409) return 'windows:fault:0xC0000409';
      if (u >= 0xc0000000) return `windows:fault:0x${u.toString(16).toUpperCase().padStart(8, '0')}`;
    }
    return `exit:${code}`;
  }
  return 'unknown';
}

interface MemoryEvidence {
  heapOomClass: boolean;
  /** The last COMPARABLE (whole-tree/job) footprint sample, in KB, or null. */
  comparableFootprintKb: number | null;
  supervisorPreempt: boolean;
}

/** Mirror of `MemoryExhaustionEvidence::is_attributed` + the emit-seam gate. */
function isMemoryAttributed(ev: MemoryEvidence): boolean {
  const ceilingKb = WATCHER_FOOTPRINT_CEILING_MB * 1024;
  const footprintAtOrAboveCeiling =
    ev.comparableFootprintKb !== null && ev.comparableFootprintKb >= ceilingKb;
  return ev.heapOomClass || footprintAtOrAboveCeiling || ev.supervisorPreempt;
}

interface WatcherExit {
  label: string;
  code: number | null;
  signal: number | null;
  host: Host;
  evidence: MemoryEvidence;
  /** Windows job peak-commit bucket (fixed vocabulary) when known. */
  jobPeakCommitBucket?: string;
  /** rss_scope of the exit's last sample (tree qualifies; shim is withheld). */
  rssScope: 'tree' | 'shim' | 'launcher';
}

/**
 * Model one watcher exit into the Sentry envelope the artifact ships. `pre-fix`
 * reproduces today's shipped envelope: the raw host token, three fingerprints,
 * NO declared ceiling. `post-fix` declares the ceiling on every exit and
 * converges the fingerprint on evidence only.
 */
function simulateWatcherExit(exit: WatcherExit, policy: Policy): SentryEnvelopeEvent {
  const host = hostToken(exit.code, exit.signal, exit.host);
  const tags: Record<string, string> = {
    sync_route: 'watcher',
    rss_scope: exit.rssScope,
  };
  const extras: Record<string, string | number> = {
    watcher_lifecycle_state: 'backoff',
  };
  if (exit.jobPeakCommitBucket) tags.watcher_job_peak_commit_bucket = exit.jobPeakCommitBucket;

  let token: string;
  if (policy === 'pre-fix') {
    // Host-derived ceiling: three encodings → three fingerprints, no ceiling fact.
    token = host;
  } else {
    const attributed = isMemoryAttributed(exit.evidence);
    token = attributed ? MEMORY_TOKEN : host;
    // Declared ceiling recorded on EVERY exit, with its provenance.
    extras.runner_heap_ceiling_mb = RUNNER_HEAP_CEILING_DEFAULT_MB;
    tags.runner_heap_ceiling_source = 'declared_default';
    // The raw host token is preserved whenever convergence overrides it.
    if (attributed) extras.termination_status_raw = host;
  }

  return {
    message: `auto-sync watcher exited unexpectedly, consecutive failure #1`,
    fingerprint: ['sync', 'auto-sync-watcher-termination', token, 'none', 'none'],
    tags,
    extras,
  };
}

// The three real shipped events.
const SIGKILL_5_9GB: WatcherExit = {
  label: '7675812922',
  code: null,
  signal: 9,
  host: 'posix',
  // The OS killed the tree at 5.9GB (≥ the 4.5GB declared footprint ceiling).
  evidence: { heapOomClass: false, comparableFootprintKb: Math.round(5.9 * 1024 * 1024), supervisorPreempt: false },
  rssScope: 'tree',
};
const SIGABRT_HEAP_OOM: WatcherExit = {
  label: '7676269601',
  code: null,
  signal: 6,
  host: 'posix',
  // A V8 heap OOM (runner_fatal_class=heap_oom) at 3662/3802MB.
  evidence: { heapOomClass: true, comparableFootprintKb: Math.round(3.8 * 1024 * 1024), supervisorPreempt: false },
  rssScope: 'tree',
};
const WINDOWS_IDLE_FAULT: WatcherExit = {
  label: '7676678003',
  code: 0xc0000409 | 0,
  signal: null,
  host: 'windows',
  // Idle phase, only the 7MB npx.cmd shim was readable (withheld), peak commit
  // 512mb_to_1gb — NO memory evidence. Must NOT be claimed as an OOM.
  evidence: { heapOomClass: false, comparableFootprintKb: null, supervisorPreempt: false },
  jobPeakCommitBucket: '512mb_to_1gb',
  rssScope: 'shim',
};

describe('watcher memory-ceiling attribution — shipped Sentry envelopes', () => {
  it('pre-fix: reproduces the three shipped envelopes with THREE distinct tokens and no ceiling (non-vacuity guard)', () => {
    const kill = simulateWatcherExit(SIGKILL_5_9GB, 'pre-fix');
    const abort = simulateWatcherExit(SIGABRT_HEAP_OOM, 'pre-fix');
    const win = simulateWatcherExit(WINDOWS_IDLE_FAULT, 'pre-fix');

    expect(kill.fingerprint[2]).toBe('signal:9');
    expect(abort.fingerprint[2]).toBe('abort:sigabrt');
    expect(win.fingerprint[2]).toBe('windows:fault:0xC0000409');
    // Three distinct fingerprints → three issues, which is the defect.
    const tokens = new Set([kill.fingerprint[2], abort.fingerprint[2], win.fingerprint[2]]);
    expect(tokens.size).toBe(3);
    // No declared ceiling field anywhere before the fix.
    for (const ev of [kill, abort, win]) {
      expect(ev.extras.runner_heap_ceiling_mb).toBeUndefined();
      expect(ev.tags.runner_heap_ceiling_source).toBeUndefined();
      assertContentSafeDiagnostics(ev);
    }
  });

  it('post-fix: the two evidenced memory deaths CONVERGE on one token, each carrying the declared ceiling', () => {
    const kill = simulateWatcherExit(SIGKILL_5_9GB, 'post-fix');
    const abort = simulateWatcherExit(SIGABRT_HEAP_OOM, 'post-fix');

    // Footprint-at-ceiling (kill) and heap-OOM class (abort) both converge.
    expect(kill.fingerprint[2]).toBe(MEMORY_TOKEN);
    expect(abort.fingerprint[2]).toBe(MEMORY_TOKEN);
    expect(kill.fingerprint).toEqual(abort.fingerprint);

    for (const ev of [kill, abort]) {
      expect(ev.extras.runner_heap_ceiling_mb).toBe(RUNNER_HEAP_CEILING_DEFAULT_MB);
      expect(ev.tags.runner_heap_ceiling_source).toBe('declared_default');
      assertContentSafeDiagnostics(ev);
    }
    // The raw host token is preserved, so nothing is lost.
    expect(kill.extras.termination_status_raw).toBe('signal:9');
    expect(abort.extras.termination_status_raw).toBe('abort:sigabrt');
  });

  it('post-fix negative direction: an evidence-free SIGKILL and the idle Windows fault are NOT converged', () => {
    // A force-quit / bare OS kill with NO comparable footprint and NO heap class.
    const forceQuit: WatcherExit = {
      label: 'force-quit',
      code: null,
      signal: 9,
      host: 'posix',
      evidence: { heapOomClass: false, comparableFootprintKb: null, supervisorPreempt: false },
      rssScope: 'tree',
    };
    const fq = simulateWatcherExit(forceQuit, 'post-fix');
    // A force-quit must NEVER be relabelled an OOM.
    expect(fq.fingerprint[2]).toBe('signal:9');
    expect(fq.extras.termination_status_raw).toBeUndefined();
    // …but it still carries the declared ceiling for interpretability.
    expect(fq.extras.runner_heap_ceiling_mb).toBe(RUNNER_HEAP_CEILING_DEFAULT_MB);

    // The idle-phase Windows fault (7676678003): a comparable Windows memory fact
    // now ships (declared ceiling + peak-commit bucket) so it is honestly
    // SEPARATED from the memory mode, not swept into it on a 7MB shim number.
    const win = simulateWatcherExit(WINDOWS_IDLE_FAULT, 'post-fix');
    expect(win.fingerprint[2]).toBe('windows:fault:0xC0000409');
    expect(win.fingerprint[2]).not.toBe(MEMORY_TOKEN);
    expect(win.extras.runner_heap_ceiling_mb).toBe(RUNNER_HEAP_CEILING_DEFAULT_MB);
    expect(win.tags.watcher_job_peak_commit_bucket).toBe('512mb_to_1gb');
    // The withheld shim scope is never read as the runner's own footprint.
    expect(win.tags.rss_scope).toBe('shim');

    for (const ev of [fq, win]) assertContentSafeDiagnostics(ev);
  });

  it('never regroups: an exit with no memory evidence keeps its host token byte-for-byte', () => {
    // A plain SIGSEGV crash (unrelated) must be identical pre- and post-fix.
    const segv: WatcherExit = {
      label: 'segv',
      code: null,
      signal: 11,
      host: 'posix',
      evidence: { heapOomClass: false, comparableFootprintKb: null, supervisorPreempt: false },
      rssScope: 'tree',
    };
    const pre = simulateWatcherExit(segv, 'pre-fix');
    const post = simulateWatcherExit(segv, 'post-fix');
    expect(pre.fingerprint[2]).toBe('signal:11');
    expect(post.fingerprint[2]).toBe('signal:11');
    expect(post.fingerprint).toEqual(pre.fingerprint);
  });
});
