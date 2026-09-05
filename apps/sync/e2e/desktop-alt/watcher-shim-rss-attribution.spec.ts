/**
 * Watcher shim RSS attribution (HQ-DESKTOP-4M).
 *
 * On Windows the auto-sync watcher's registered/sampled child is the `cmd.exe`
 * batch shim (`npx.cmd`), and `sample_watcher_rss_scoped` had no whole-tree arm on
 * Windows — so every RSS sample described the ~5-8MB shim, `resolve_rss_scope`
 * mapped that single-PID sample to scope `shim`, and `render_last_rss` WITHHELD the
 * number as `unattributed:shim`. HQ-DESKTOP-4M's 0xFFFFFFFF exits were therefore
 * untriageable: the one memory fact that would separate a Node heap-OOM from a
 * small-footprint kill never reached the event. The shipped title suffix was:
 *   ` [uptime=26m47s; last_rss=unattributed:shim (sampled 17s before exit)]`.
 *
 * The fix sums each live PID's working set across the watcher's retained Job Object
 * (a seam that already runs on Windows for fault provenance), yielding the
 * runner-inclusive footprint as `RssSampleKind::Tree` — which `resolve_rss_scope`
 * already maps to `tree` and `render_last_rss` already renders as a real number.
 *
 * The Rust suites pin the seam from the inside (the pure `sum_job_working_set_kb`
 * on every lane; the real-child job-sum test on the windows-check gate). This spec
 * pins the same property at the *source-contract* and *artifact* levels, following
 * the fixture-backed pattern of watcher-heap-oom-attribution.spec.ts:
 *
 * 1. Source contracts over the code that actually ships — the Windows
 *    `sample_watcher_rss_scoped` arm reaches the job sum and falls back to
 *    `RssSampleKind::Single`; the process.rs helper resolves by generation and
 *    closes nothing; the stale "Windows keeps its single-PID sampler" justification
 *    is gone — so deleting or bypassing any seam fails here, not only in Rust.
 * 2. An envelope simulator run in BOTH directions: the pre-fix policy reproduces
 *    the observed HQ-DESKTOP-4M envelope (rss_scope=shim, the withheld suffix), and
 *    the post-fix policy produces the tree-scoped real number — keeping the passing
 *    direction non-vacuous.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary and bounded
 * integers — never argv, paths, image names, PIDs, or raw job bytes.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { assertContentSafeDiagnostics } from './windows-reliability-harness';

// repoRoot is apps/sync, so the app crate sources are read relative to it.
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const processSource = readRepoFile('src-tauri/src/commands/process.rs');

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

describe('watcher shim RSS attribution — source contracts', () => {
  it('reaches the job-object working-set sum on the Windows sampler arm', () => {
    const windowsArm = sliceBetween(
      daemonSource,
      '#[cfg(target_os = "windows")]\nfn sample_watcher_rss_scoped(',
      '\n}\n',
      'windows sample_watcher_rss_scoped',
    );
    // Resolve the CURRENT generation and ask the process module for the job's
    // per-PID working-set samples, then sum them into a Tree scope.
    expect(windowsArm).toContain('generation_for_handle(DAEMON_HANDLE)');
    expect(windowsArm).toContain(
      'crate::commands::process::watcher_job_working_set_samples(DAEMON_HANDLE, generation)',
    );
    expect(windowsArm).toContain('sum_job_working_set_kb(&samples, pid)');
    expect(windowsArm).toContain('RssSampleKind::Tree');
  });

  it('falls back to today’s exact single-PID sample on ANY failure', () => {
    const windowsArm = sliceBetween(
      daemonSource,
      '#[cfg(target_os = "windows")]\nfn sample_watcher_rss_scoped(',
      '\n}\n',
      'windows sample_watcher_rss_scoped',
    );
    // The same pre-fix Windows fallback behaviour — a shim footprint stays WITHHELD
    // (single-PID, tagged `Single`) rather than reported as a wrong number. The
    // sample now rides the shared ScopedRssSample, whose tree decomposition is
    // withheld (`None`) on the Windows path since the job working-set sum cannot be
    // cheaply decomposed.
    expect(windowsArm).toContain('sample_pid_rss_kb(pid).map(|kb| ScopedRssSample {');
    expect(windowsArm).toContain('kind: RssSampleKind::Single,');
    expect(windowsArm).toContain('tree_pid_count: None,');
  });

  it('keeps the non-Windows sampling path byte-identical (ps descendant sum)', () => {
    const unixArm = sliceBetween(
      daemonSource,
      '#[cfg(not(target_os = "windows"))]\nfn sample_watcher_rss_scoped(',
      '\n}\n',
      'unix sample_watcher_rss_scoped',
    );
    expect(unixArm).toContain('sample_pid_tree_rss_kb(pid)');
    expect(unixArm).toContain('RssSampleKind::Tree');
  });

  it('pure sum requires the root, a measured descendant, and saturates', () => {
    expect(daemonSource).toContain(
      'fn sum_job_working_set_kb(samples: &[(u32, Option<u64>)], root: u32) -> Option<u64>',
    );
    const sumFn = sliceBetween(
      daemonSource,
      'fn sum_job_working_set_kb(',
      '\n}\n',
      'sum_job_working_set_kb',
    );
    // Root-must-be-present (so a stale/foreign job is never reported) and
    // saturating add (so a pathological pair cannot wrap to a tiny wrong sum).
    expect(sumFn).toContain('samples.iter().any(|(pid, _)| *pid == root)');
    expect(sumFn).toContain('saturating_add');
    // A measured descendant is required: if only the shim (root) is readable, the
    // "tree" is just the shim — withhold rather than mislabel it as tree-complete.
    expect(sumFn).toContain('measured_descendant');
    expect(sumFn).toContain('if pid != root');
  });

  it('the process helper is generation-scoped and closes nothing', () => {
    const helper = sliceBetween(
      processSource,
      'pub fn watcher_job_working_set_samples(',
      '\n}\n',
      'watcher_job_working_set_samples',
    );
    // Resolved by generation exactly like the accounting read (active-at-generation
    // else retired), the live-PID list read under the lock, then the lock DROPPED
    // before any per-process OpenProcess work.
    expect(helper).toContain('.filter(|entry| entry.generation == generation)');
    expect(helper).toContain('query_job_live_pids(job)');
    expect(helper).toContain('drop(registry)');
    expect(helper).toContain('sample_pid_working_set_kb(pid)');
    // Read-only: it never closes, terminates, duplicates, or takes the job handle.
    expect(helper).not.toContain('CloseHandle');
    expect(helper).not.toContain('TerminateJobObject');
  });

  it('the stale single-PID justification comment is gone', () => {
    // The false premise PR #448 left behind — that the Windows single-PID sampler
    // is fine because the Job Object already carries whole-tree memory — must be
    // removed, not merely contradicted elsewhere.
    expect(daemonSource).not.toContain('Windows keeps its single-PID sampler');
    expect(daemonSource).not.toContain('already carries whole-tree memory');
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

interface ShimRssSample {
  /** The shim's own single-PID working set (KB) — what the shipped sampler read. */
  shimKb: number;
  /** The runner-inclusive job-summed working set (KB) the fix reports. */
  treeKb: number;
  ageSecs: number;
  uptimeSecs: number;
}

/** Mirror of `format_rss_kb`. */
function formatRssKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)}GB`;
  if (kb >= 1024) return `${Math.floor(kb / 1024)}MB`;
  return `${kb}KB`;
}

/** Mirror of `format_duration_secs`. */
function formatDurationSecs(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

/** Mirror of `render_last_rss` for the shim/tree scopes this cluster exercises. */
function renderLastRss(scope: 'shim' | 'tree', kb: number, ageSecs: number): string {
  if (scope === 'tree') {
    return `last_rss=${formatRssKb(kb)} (tree, sampled ${formatDurationSecs(ageSecs)} before exit)`;
  }
  // Non-runner single-PID scope: the number is WITHHELD, the scope named instead.
  return `last_rss=unattributed:${scope} (sampled ${formatDurationSecs(ageSecs)} before exit)`;
}

/**
 * Model one 0xFFFFFFFF watcher exit whose registered child is the npx.cmd shim.
 * `pre-fix` reproduces the shipped HQ-DESKTOP-4M envelope — a single-PID shim
 * sample whose number is withheld as `unattributed:shim`. `post-fix` reports the
 * runner-inclusive job-summed working set, tree-scoped. Only the MEASURED footprint
 * changes; capture policy, grouping, and the registered child kind are untouched.
 */
function simulateShimExitEnvelope(policy: Policy, rss: ShimRssSample): SentryEnvelopeEvent {
  const scope: 'shim' | 'tree' = policy === 'pre-fix' ? 'shim' : 'tree';
  const kb = policy === 'pre-fix' ? rss.shimKb : rss.treeKb;
  const tags: Record<string, string> = {
    sync_route: 'watcher',
    runner_fatal_class: 'none',
    watcher_child_kind: 'cmd_shim',
    windows_exit_status: '0xFFFFFFFF',
    windows_exit_class: 'indeterminate_status',
    rss_scope: scope,
  };
  const extras: Record<string, string | boolean | number> = {
    watcher_lifecycle_state: 'running',
    watcher_job_peak_commit_bucket: '128mb_to_512mb',
    watcher_job_process_count: 7,
  };
  const suffix = ` [uptime=${formatDurationSecs(rss.uptimeSecs)}; ${renderLastRss(scope, kb, rss.ageSecs)}]`;
  return {
    // Prefix derived from the shipped `describe_exit(-1, None)`:
    // "with Windows status 0xFFFFFFFF (origin unknown)".
    message:
      'auto-sync watcher exited unexpectedly (with Windows status 0xFFFFFFFF (origin unknown)), ' +
      `consecutive failure #1${suffix}`,
    // Grouping is driven by the termination fingerprint token, NOT the diagnostic
    // suffix — so the tree number never regroups this cluster.
    fingerprint: ['sync', 'auto-sync-watcher-termination', 'windows:status-ffffffff', 'none'],
    tags,
    extras,
  };
}

// The shim's own single-PID working set the shipped event withheld (~6MB), and the
// runner-inclusive job sum the fix reports inside the observed 128-512MB job.
const OBSERVED: ShimRssSample = {
  shimKb: 6 * 1024,
  treeKb: 312 * 1024,
  ageSecs: 17,
  uptimeSecs: 1607, // 26m47s
};

describe('watcher shim RSS attribution — shipped Sentry envelope', () => {
  it('pre-fix: reproduces the observed HQ-DESKTOP-4M envelope (non-vacuity guard)', () => {
    const event = simulateShimExitEnvelope('pre-fix', OBSERVED);
    expect(event.tags.watcher_child_kind).toBe('cmd_shim');
    expect(event.tags.rss_scope).toBe('shim');
    expect(event.tags.windows_exit_status).toBe('0xFFFFFFFF');
    expect(event.tags.windows_exit_class).toBe('indeterminate_status');
    expect(event.tags.runner_fatal_class).toBe('none');
    // The exact shipped title suffix — the memory number WITHHELD.
    expect(event.message).toContain(
      ' [uptime=26m47s; last_rss=unattributed:shim (sampled 17s before exit)]',
    );
    // No footprint number ever ships in the withholding direction.
    expect(event.message).not.toMatch(/last_rss=\d/);
    assertContentSafeDiagnostics(event);
  });

  it('post-fix: reports the runner-inclusive job-summed working set, tree-scoped', () => {
    const event = simulateShimExitEnvelope('post-fix', OBSERVED);
    expect(event.tags.rss_scope).toBe('tree');
    expect(event.message).toContain(
      ' [uptime=26m47s; last_rss=312MB (tree, sampled 17s before exit)]',
    );
    // The withheld sentinel is gone — a real number now reaches the event.
    expect(event.message).not.toContain('unattributed:shim');
    // watcher_child_kind is unchanged: the registered child is still the shim; only
    // what is MEASURED changed, never what is spawned.
    expect(event.tags.watcher_child_kind).toBe('cmd_shim');
    assertContentSafeDiagnostics(event);
  });

  it('never regroups: the fingerprint is suffix-independent across both directions', () => {
    const pre = simulateShimExitEnvelope('pre-fix', OBSERVED);
    const post = simulateShimExitEnvelope('post-fix', OBSERVED);
    expect(post.fingerprint).toEqual(pre.fingerprint);
    expect(post.fingerprint).toEqual([
      'sync',
      'auto-sync-watcher-termination',
      'windows:status-ffffffff',
      'none',
    ]);
    // Capture policy is untouched: 0xFFFFFFFF stays classed indeterminate_status.
    expect(post.tags.windows_exit_class).toBe('indeterminate_status');
    expect(pre.tags.windows_exit_class).toBe('indeterminate_status');
  });
});
