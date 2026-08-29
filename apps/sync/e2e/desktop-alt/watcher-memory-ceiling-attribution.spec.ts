/**
 * Auto-sync watcher memory-ceiling attribution.
 *
 * One mechanism — the Node sync-runner outgrowing its memory bound mid-pull —
 * arrived as THREE unresolved Sentry issues because the app declared no ceiling,
 * so which lethal event won varied by host and each death carried a different
 * termination fingerprint:
 *   - 7676269601: a V8 heap-OOM SIGABRT (heap 3662/3802 MB) → `abort:sigabrt`
 *   - 7675812922: an OS SIGKILL before V8 aborted (tree RSS 5.9 GB, no heap
 *     evidence) → `signal:9`
 *   - 7676678003: a Windows 0xC0000409 fault whose registered child was the
 *     npx.cmd shim (rss_scope=shim, last_rss=7 MB, runner_phase=idle, peak
 *     commit 512mb_to_1gb) → `windows:fault:0xC0000409`
 *
 * The Rust suites (hq-desktop-core, hq-telemetry) pin the pure seams from the
 * inside. This spec pins the same properties at the source-contract and artifact
 * levels, following watcher-heap-oom-attribution.spec.ts:
 *
 * 1. Source contracts over the code that ships — the declared ceiling merged into
 *    NODE_OPTIONS on BOTH spawn paths, the footprint high-water evidence gate, the
 *    evidence-gated fingerprint convergence, the ceiling extras/tag, and the
 *    telemetry egress arms — so deleting or bypassing any seam fails here too.
 * 2. A two-direction envelope simulator: the pre-fix policy reproduces all three
 *    shipped envelopes with three DISTINCT fingerprints and no declared ceiling;
 *    the post-fix policy declares a ceiling on every exit, converges the two
 *    evidence-backed memory deaths onto one token, and — the honest-separation
 *    property this cluster owes issue 7676678003 — keeps an evidence-free SIGKILL
 *    at `signal:9` and an idle-phase low-commit Windows fault at its Windows
 *    token, while making that Windows exit memory-factful (ceiling + job peak
 *    commit) so the next occurrence is classifiable.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary, bounded
 * integers, and buckets — never argv, stderr, symbols, paths, or company slugs.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { assertContentSafeDiagnostics } from './windows-reliability-harness';

// repoRoot is apps/sync, so shared crate sources are read via '../../crates'.
const coreDaemonSource = readRepoFile('../../crates/hq-desktop-core/src/daemon.rs');
const coreOutcomeSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

// The two declared limits, mirrored from hq-desktop-core so a drift in either
// direction is caught by the anti-drift source contract below.
const DECLARED_CEILING_MB = 2048; // WATCH_RUNNER_MAX_OLD_SPACE_MB
const FOOTPRINT_HIGH_WATER_MB = 4096; // WATCH_RUNNER_FOOTPRINT_HIGH_WATER_MB
const MEMORY_TOKEN = 'memory:runner-exhaustion';

describe('watcher memory-ceiling attribution — source contracts', () => {
  it('declares a runner heap ceiling merged into NODE_OPTIONS on BOTH spawn paths', () => {
    expect(coreDaemonSource).toContain(
      `pub const WATCH_RUNNER_MAX_OLD_SPACE_MB: u64 = ${DECLARED_CEILING_MB};`,
    );
    // The pure merge helper never clobbers an inherited value, and the spawn
    // builder writes NODE_OPTIONS shared across BOTH the pinned npx path and the
    // dev node path.
    expect(coreDaemonSource).toContain('pub fn merge_runner_node_options(');
    expect(coreDaemonSource).toContain('let node_options = current_runner_node_options();');
    expect(coreDaemonSource).toContain('"NODE_OPTIONS".to_string(),');
    // The dev `node` path additionally passes the flag in argv, gated on our own
    // injection so a user's inherited --max-old-space-size is never overridden.
    expect(coreDaemonSource).toContain('if node_options.injected {');
    expect(coreDaemonSource).toContain('"--max-old-space-size={}"');
    // An env escape hatch raises the ceiling without a rebuild.
    expect(coreDaemonSource).toContain('HQ_SYNC_RUNNER_MAX_OLD_SPACE_MB');
  });

  it('has a pure footprint high-water evidence gate fed by the supervisor RSS sampler', () => {
    expect(coreDaemonSource).toContain(
      `pub const WATCH_RUNNER_FOOTPRINT_HIGH_WATER_MB: u64 = ${FOOTPRINT_HIGH_WATER_MB};`,
    );
    // The pure gate: a last comparable whole-tree sample at or above the mark is
    // the evidence that attributes an out-of-memory death at the exit boundary.
    expect(coreDaemonSource).toContain('pub fn footprint_sample_over_high_water(');
    // The supervisor tick samples the whole-tree RSS (reusing the scoped sampler,
    // no added ps spawn) so the last footprint before death is available; the gate
    // itself is evaluated at the exit boundary, not as an active pre-empt.
    expect(daemonSource).toContain('sample_watcher_rss_scoped(pid)');
    expect(daemonSource).toContain('note_watcher_rss(kb, kind);');
    expect(daemonSource).toContain(
      'footprint_at_or_above_ceiling: hq_desktop_core::daemon::footprint_sample_over_high_water(',
    );
  });

  it('converges the fingerprint on EVIDENCE only, delegating to the host token otherwise', () => {
    expect(coreOutcomeSource).toContain(
      `pub const MEMORY_EXHAUSTION_FINGERPRINT_TOKEN: &str = "${MEMORY_TOKEN}";`,
    );
    expect(coreOutcomeSource).toContain('pub struct MemoryExhaustionEvidence');
    for (const gate of ['heap_oom_class', 'footprint_at_or_above_ceiling']) {
      expect(coreOutcomeSource).toContain(gate);
    }
    expect(coreOutcomeSource).toContain('pub fn termination_fingerprint_token_for_memory(');
    // Evidence-free exits delegate byte-for-byte to the host contract.
    const fn = coreOutcomeSource.slice(
      coreOutcomeSource.indexOf('pub fn termination_fingerprint_token_for_memory('),
    );
    expect(fn).toContain('if evidence.is_attributed() {');
    expect(fn).toContain('termination_fingerprint_token_for_host(code, signal, host)');
  });

  it('gates the exit fingerprint on evidence and records the ceiling on every exit', () => {
    expect(daemonSource).toContain(
      'termination_fingerprint_token_for_memory(code, signal, host, memory_evidence)',
    );
    expect(daemonSource).toContain('let memory_evidence = MemoryExhaustionEvidence {');
    // The declared ceiling (MB) + provenance ride every watcher exit.
    expect(daemonSource).toContain('"runner_heap_ceiling_mb"');
    expect(daemonSource).toContain('"runner_heap_ceiling_source"');
  });

  it('registers the ceiling vocabulary at the telemetry egress boundary', () => {
    expect(telemetrySource).toContain(
      '"runner_heap_ceiling_mb" => Some(value.is_empty() || value.parse::<u64>().is_ok())',
    );
    expect(telemetrySource).toContain('"runner_heap_ceiling_source" => Some(matches!(');
    expect(telemetrySource).toContain(
      '"declared_default" | "user_override" | "inherited_node_options"',
    );
  });
});

// ---------------------------------------------------------------------------
// Artifact-level envelope model
// ---------------------------------------------------------------------------

type Policy = 'pre-fix' | 'post-fix';

interface SentryEnvelopeEvent {
  message: string;
  fingerprint: string[];
  tags: Record<string, string>;
  extras: Record<string, string | boolean | number>;
}

interface WatcherExit {
  label: string;
  code: number | null;
  signal: number | null;
  rssKb: number | null;
  rssScope: 'tree' | 'shim' | 'launcher' | 'runner';
  /** Present when V8 aborted on a heap OOM this pass (the definitive signal). */
  heapOomBanner: string | null;
  heapUsedTotalMb: [number, number] | null;
  runnerPhase: string;
  /** The bucketed Windows Job Object peak per-process commit (present pre & post). */
  jobPeakCommitBucket: string;
  uptime: string;
}

/** Mirror of `termination_fingerprint_token_for_host` for the modeled shapes. */
function hostToken(code: number | null, signal: number | null): string {
  if (code === null && signal !== null) {
    if (signal === 6) return 'abort:sigabrt'; // normalized_abort folds SIGABRT
    return `signal:${signal}`;
  }
  if (code !== null && signal === null) {
    if ((code >>> 0) === 0xc0000409) return 'windows:fault:0xC0000409';
    return `exit:${code}`;
  }
  return 'unknown';
}

/** Mirror of `MemoryExhaustionEvidence` derivation at the exit boundary. */
function memoryEvidence(exit: WatcherExit): {
  heapOomClass: boolean;
  footprintAtOrAboveCeiling: boolean;
} {
  return {
    heapOomClass: exit.heapOomBanner !== null,
    footprintAtOrAboveCeiling:
      exit.rssScope === 'tree' &&
      exit.rssKb !== null &&
      Math.floor(exit.rssKb / 1024) >= FOOTPRINT_HIGH_WATER_MB,
  };
}

function isAttributed(e: ReturnType<typeof memoryEvidence>): boolean {
  return e.heapOomClass || e.footprintAtOrAboveCeiling;
}

/** Mirror of `format_rss_kb`. */
function formatRssKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)}GB`;
  if (kb >= 1024) return `${Math.floor(kb / 1024)}MB`;
  return `${kb}KB`;
}

/**
 * Model one watcher exit into the Sentry envelope the artifact ships. `pre-fix`
 * reproduces the shipped output (host token, no declared ceiling); `post-fix`
 * declares a ceiling on every exit and converges an EVIDENCE-attributed memory
 * death onto one token.
 */
function simulate(exit: WatcherExit, policy: Policy): SentryEnvelopeEvent {
  const evidence = memoryEvidence(exit);
  const attributed = policy === 'post-fix' && isAttributed(evidence);
  const token = attributed ? MEMORY_TOKEN : hostToken(exit.code, exit.signal);

  const tags: Record<string, string> = {
    sync_route: 'watcher',
    rss_scope: exit.rssScope,
    // The whole-tree job peak-commit bucket ships pre and post (HQ-DESKTOP-4X).
    watcher_job_peak_commit_bucket: exit.jobPeakCommitBucket,
  };
  const extras: Record<string, string | boolean | number> = {
    watcher_lifecycle_state: 'running',
    runner_phase: exit.runnerPhase,
    runner_fatal_class_seen: exit.heapOomBanner !== null,
  };
  if (exit.heapOomBanner !== null) {
    tags.runner_oom_banner = exit.heapOomBanner;
    if (exit.heapUsedTotalMb) {
      extras.runner_heap_used_mb = exit.heapUsedTotalMb[0];
      extras.runner_heap_total_mb = exit.heapUsedTotalMb[1];
    }
  }

  if (policy === 'post-fix') {
    // Present on EVERY exit so a footprint is always interpretable against the
    // ceiling in force — this is the fact the Windows exit was missing.
    extras.runner_heap_ceiling_mb = DECLARED_CEILING_MB;
    tags.runner_heap_ceiling_source = 'declared_default';
    // The raw host token is preserved whenever the emitted token diverged.
    if (attributed) extras.termination_status_raw = hostToken(exit.code, exit.signal);
  }

  const lastRss = exit.rssKb === null ? 'last_rss=unavailable' : `last_rss=${formatRssKb(exit.rssKb)} (${exit.rssScope})`;
  return {
    message: `auto-sync watcher exited unexpectedly, consecutive failure #1 [uptime=${exit.uptime}; ${lastRss}]`,
    fingerprint: ['sync', 'auto-sync-watcher-termination', token, 'none'],
    tags,
    extras,
  };
}

// The three shipped deaths, one mechanism.
const HEAP_OOM_SIGABRT: WatcherExit = {
  label: '7676269601',
  code: null,
  signal: 6, // SIGABRT (posix, hq-sync@0.10.113)
  rssKb: Math.round(3.8 * 1024 * 1024),
  rssScope: 'tree',
  heapOomBanner: 'ineffective_mark_compacts',
  heapUsedTotalMb: [3662, 3802],
  runnerPhase: 'pull',
  jobPeakCommitBucket: 'unknown',
  uptime: '35m23s',
};

const OS_SIGKILL_TREE: WatcherExit = {
  label: '7675812922',
  code: null,
  signal: 9, // OS killed the tree before V8 aborted (hq-sync@0.10.113)
  rssKb: Math.round(5.9 * 1024 * 1024),
  rssScope: 'tree',
  heapOomBanner: null, // the SIGKILL destroyed the heap evidence
  heapUsedTotalMb: null,
  runnerPhase: 'pull',
  jobPeakCommitBucket: 'unknown',
  uptime: '2h11m',
};

const WINDOWS_IDLE_FAULT: WatcherExit = {
  label: '7676678003',
  code: 0xc0000409, // STATUS_STACK_BUFFER_OVERRUN (hq-sync-win@0.10.105)
  signal: null,
  rssKb: 7 * 1024, // the npx.cmd shim, not the runner
  rssScope: 'shim',
  heapOomBanner: null,
  heapUsedTotalMb: null,
  runnerPhase: 'idle',
  jobPeakCommitBucket: '512mb_to_1gb',
  uptime: '4m02s',
};

// A force-quit / external SIGKILL that is NOT a memory death: a healthy small
// footprint, no heap class, no pre-empt.
const FORCE_QUIT_SIGKILL: WatcherExit = {
  label: 'force-quit',
  code: null,
  signal: 9,
  rssKb: 200 * 1024, // well under the footprint ceiling
  rssScope: 'tree',
  heapOomBanner: null,
  heapUsedTotalMb: null,
  runnerPhase: 'idle',
  jobPeakCommitBucket: 'under_128mb',
  uptime: '9s',
};

describe('watcher memory-ceiling attribution — shipped Sentry envelopes', () => {
  it('pre-fix: reproduces all three shipped envelopes with THREE distinct fingerprints (non-vacuity)', () => {
    const heap = simulate(HEAP_OOM_SIGABRT, 'pre-fix');
    const kill = simulate(OS_SIGKILL_TREE, 'pre-fix');
    const win = simulate(WINDOWS_IDLE_FAULT, 'pre-fix');

    expect(heap.fingerprint[2]).toBe('abort:sigabrt');
    expect(heap.extras.runner_heap_used_mb).toBe(3662);
    expect(heap.extras.runner_heap_total_mb).toBe(3802);

    expect(kill.fingerprint[2]).toBe('signal:9');
    expect(kill.extras.runner_fatal_class_seen).toBe(false);
    expect(kill.extras.runner_heap_used_mb).toBeUndefined();
    expect(kill.message).toContain('last_rss=5.9GB (tree)');

    expect(win.fingerprint[2]).toBe('windows:fault:0xC0000409');
    expect(win.tags.rss_scope).toBe('shim');
    // The shim footprint (~7 MB) is not the runner's — that IS the defect.
    expect(win.message).toContain('last_rss=7MB (shim)');

    // Three distinct issues — the defect.
    const tokens = [heap, kill, win].map((e) => e.fingerprint[2]);
    expect(new Set(tokens).size).toBe(3);
    // And NO declared ceiling anywhere before the fix.
    for (const e of [heap, kill, win]) {
      expect(e.extras.runner_heap_ceiling_mb).toBeUndefined();
      expect(e.tags.runner_heap_ceiling_source).toBeUndefined();
      assertContentSafeDiagnostics(e);
    }
  });

  it('post-fix: the two evidence-backed memory deaths converge on ONE token', () => {
    const heap = simulate(HEAP_OOM_SIGABRT, 'post-fix');
    const kill = simulate(OS_SIGKILL_TREE, 'post-fix');

    // Heap OOM class → memory token; the SIGKILL whose tree footprint breached
    // the ceiling → the SAME memory token. One mechanism, one issue.
    expect(heap.fingerprint[2]).toBe(MEMORY_TOKEN);
    expect(kill.fingerprint[2]).toBe(MEMORY_TOKEN);
    expect(heap.fingerprint).toEqual(kill.fingerprint);
    // The raw host tokens are preserved so nothing is lost.
    expect(heap.extras.termination_status_raw).toBe('abort:sigabrt');
    expect(kill.extras.termination_status_raw).toBe('signal:9');
    for (const e of [heap, kill]) {
      expect(e.extras.runner_heap_ceiling_mb).toBe(DECLARED_CEILING_MB);
      expect(e.tags.runner_heap_ceiling_source).toBe('declared_default');
      assertContentSafeDiagnostics(e);
    }
  });

  it('post-fix: honestly SEPARATES the idle-phase Windows fault — not claimed as memory', () => {
    const win = simulate(WINDOWS_IDLE_FAULT, 'post-fix');
    // No heap class, a non-comparable shim footprint, an idle phase, and only a
    // 512mb_to_1gb peak commit: no memory evidence, so it keeps its Windows token.
    expect(win.fingerprint[2]).toBe('windows:fault:0xC0000409');
    expect(win.fingerprint[2]).not.toBe(MEMORY_TOKEN);
    // But it is no longer memory-factless: it now carries the declared ceiling
    // AND the job peak-commit bucket, so the next occurrence is classifiable.
    expect(win.extras.runner_heap_ceiling_mb).toBe(DECLARED_CEILING_MB);
    expect(win.tags.runner_heap_ceiling_source).toBe('declared_default');
    expect(win.tags.watcher_job_peak_commit_bucket).toBe('512mb_to_1gb');
    // No divergence, so no raw-token extra is added.
    expect(win.extras.termination_status_raw).toBeUndefined();
    assertContentSafeDiagnostics(win);
  });

  it('post-fix: an evidence-free force-quit SIGKILL is NEVER relabelled a memory death', () => {
    const forced = simulate(FORCE_QUIT_SIGKILL, 'post-fix');
    expect(forced.fingerprint[2]).toBe('signal:9');
    expect(forced.fingerprint[2]).not.toBe(MEMORY_TOKEN);
    // Still carries the declared ceiling (present on every exit) — but its small
    // tree footprint sat below the ceiling, so it is not attributed.
    expect(forced.extras.runner_heap_ceiling_mb).toBe(DECLARED_CEILING_MB);
    expect(forced.extras.termination_status_raw).toBeUndefined();
    assertContentSafeDiagnostics(forced);
  });

  it('every post-fix exit declares a ceiling; the fingerprint stays message-independent', () => {
    for (const exit of [HEAP_OOM_SIGABRT, OS_SIGKILL_TREE, WINDOWS_IDLE_FAULT, FORCE_QUIT_SIGKILL]) {
      const post = simulate(exit, 'post-fix');
      expect(post.extras.runner_heap_ceiling_mb).toBe(DECLARED_CEILING_MB);
      expect(post.tags.runner_heap_ceiling_source).toBe('declared_default');
      // Grouping never depends on the (variable) message text.
      const other = simulate({ ...exit, uptime: '99h99m' }, 'post-fix');
      expect(post.fingerprint).toEqual(other.fingerprint);
    }
  });
});
