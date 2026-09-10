/**
 * Windows indeterminate-status (0xFFFFFFFF) exit attribution (HQ-DESKTOP-66, this
 * reopen).
 *
 * The Windows auto-sync watcher child died with status 0xFFFFFFFF and the capture
 * named NO cause — not because the evidence was unavailable, but because every
 * cause channel was structurally gated off for this exit class:
 *   1. classify_windows_exit_status maps -1 (0xFFFFFFFF) to IndeterminateStatus
 *      BEFORE the fault test, so the watcher exit takes the None arm — which built
 *      no deferred read. So the crash-surviving Node diagnostic report requested for
 *      this generation was NEVER read: runner_report_read kept its request-time SEED
 *      ("report_absent"), the SAME token a genuinely-read-but-missing report emits,
 *      and the requested file was left on disk for the sibling prune to delete unread.
 *   2. The registered watcher child is the cmd.exe/npx.cmd batch shim, so 0xFFFFFFFF
 *      is the SHIM's status — whether the Node runner died, died first, or outlived
 *      the shim was observed nowhere.
 *
 * This lane closes those gates as instrumentation (it does NOT guess a cause):
 *   - Leg A/A2: the non-fault watcher route now reads the diagnostic report OFF the
 *     exit path through the SAME read_runner_diagnostic_report + apply_report_to_fault_tags
 *     the fault worker uses, so runner_report_read becomes a MEASUREMENT, and the
 *     per-generation report directory is removed after EVERY exit.
 *   - Leg B: --report-uncaught-exception is armed in BOTH spawn-flag composers, so a
 *     runner that dies on an uncaught exception leaves a report on Windows too.
 *   - Leg C: a read-only Job Object live-PID query at the exit boundary renders
 *     watcher_job_survivors (+ count) — the shim-vs-runner discriminator.
 *   - Leg D: both new tags are registered in the hq-telemetry allow-list (fail closed).
 *
 * The Rust suites (hq-desktop-core, hq-telemetry, the app crate) pin the seam from
 * the inside. This spec pins the same properties at the *source-contract* and
 * *artifact* levels, following the fixture-backed pattern of
 * windows-fatal-reason-attribution.spec.ts, so it runs on Linux/macOS CI and proves
 * the base-red / candidate-pass pair without a Windows host.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary, bounded
 * integers, and a digest — never argv, stderr, symbols, paths, pids, or company slugs.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// repoRoot is apps/sync; shared crate sources are read via '../../crates'.
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const processSource = readRepoFile('src-tauri/src/commands/process.rs');
const coreDaemonSource = readRepoFile('../../crates/hq-desktop-core/src/daemon.rs');
const coreReportSource = readRepoFile('../../crates/hq-desktop-core/src/runner_diagnostic_report.rs');
const watcherFaultSource = readRepoFile('../../crates/hq-desktop-core/src/watcher_fault.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

describe('windows indeterminate-exit attribution — source contracts', () => {
  it('Leg A: reads the report on the NON-fault watcher route, OFF the exit callback', () => {
    // A non-fault exit that requested a report now carries a report-only deferral, so
    // the report is read off the exit path — the exact gate the base's None arm left
    // shut (it only set watcher_fault_provenance = NotApplicable).
    expect(daemonSource).toContain('watcher_report_deferred_read');
    expect(daemonSource).toContain('fn spawn_deferred_watcher_report_capture(');
    expect(daemonSource).toContain('fn defer_watcher_report_capture(');
    // The read reuses the SAME shared reader + applier the fault worker uses, so the
    // two routes cannot drift.
    expect(daemonSource).toContain('fn apply_deferred_report_read(');
    expect(daemonSource).toContain('let report = read_runner_diagnostic_report(report_dir);');
    expect(daemonSource).toContain('apply_report_to_fault_tags(tags, &report)');
    // A report-derived class NEVER overrides a stderr-derived one (precedence lives in
    // the shared applier, unchanged).
    expect(daemonSource).toContain('current_class == "none"');
  });

  it('Leg A2: the report directory is cleaned after EVERY exit via an explicit disposition', () => {
    // The exit callback now removes the directory unless a deferred worker owns the
    // read, so a requested-but-not-deferred generation is no longer left for the
    // sibling prune to delete unread.
    expect(daemonSource).toContain('enum RunnerReportDirDisposition');
    expect(daemonSource).toContain('RetainedByWorker');
    expect(daemonSource).toContain('CallerCleansUp');
    expect(daemonSource).toContain(
      'if report_dir_disposition == RunnerReportDirDisposition::CallerCleansUp {',
    );
    // The shared reader still deletes the directory after the terminal read.
    expect(daemonSource).toContain('remove_runner_report_dir(report_dir);');
    expect(daemonSource).toContain('fn prune_stale_runner_report_siblings(');
  });

  it('Leg B: arms --report-uncaught-exception in BOTH spawn-flag composers', () => {
    // Windows otherwise armed only --report-on-fatalerror (the signal report is
    // POSIX-only), so an uncaught JS exception left no report. The trigger appears in
    // BOTH the argv and NODE_OPTIONS composers.
    expect(coreDaemonSource).toContain('--report-uncaught-exception');
    const armings = coreDaemonSource.split('--report-uncaught-exception').length - 1;
    expect(armings).toBeGreaterThanOrEqual(2);
    // classify_report_fatal already accepts an 'exception' trigger (and refuses a
    // 'Signal' one), so no classifier change is required.
    expect(coreReportSource).toContain('fn classify_report_fatal(trigger: &str, event: &str)');
    expect(coreReportSource).toContain('trigger.contains("exception")');
    expect(coreReportSource).toContain('trigger.eq_ignore_ascii_case("Signal")');
  });

  it('Leg C: samples the shim-vs-runner discriminator AT shim-exit, not at the exit callback', () => {
    // A single read-only QueryInformationJobObject(JobObjectBasicProcessIdList),
    // resolved to the closed survivor vocabulary and a bare count.
    expect(processSource).toContain('pub fn sample_watcher_job_survivors_for_generation(');
    expect(processSource).toContain('query_job_live_pids(job)');
    expect(processSource).toContain('JobObjectBasicProcessIdList');
    // The sample MUST be taken the instant the registered shim exits — a detector
    // that waits on the shim process and stashes the reading — because the exit
    // callback fires only after the child's inherited pipes drain to EOF, which an
    // orphaned Node runner defers by holding them open (a callback-time query would
    // see the runner already gone and report `none`).
    expect(processSource).toContain('fn spawn_shim_exit_survivor_sampler(');
    expect(processSource).toContain('fn wait_for_process_exit(');
    expect(processSource).toContain('spawn_shim_exit_survivor_sampler(handle, generation, pid)');
    // The watcher exit callback READS the shim-exit reading (never a fresh, too-late
    // sample of its own).
    expect(daemonSource).toContain('take_watcher_job_survivors_at_shim_exit(');
    expect(daemonSource).toContain('"watcher_job_survivors"');
    expect(daemonSource).toContain('"watcher_job_survivor_count"');
    // The token fold lives in the shared watcher_fault vocabulary — no re-declared
    // image list, and it renders no pid.
    expect(watcherFaultSource).toContain('pub fn watcher_job_survivors_token(');
    expect(watcherFaultSource).toContain('WATCHER_JOB_SURVIVORS_UNAVAILABLE');
    expect(watcherFaultSource).toContain('WatcherFaultBinary::NodeExe.as_str()');
  });

  it('Leg D: both new tags are registered in the hq-telemetry allow-list (fail closed)', () => {
    expect(telemetrySource).toContain(
      '"watcher_job_survivors" => Some(matches!(',
    );
    for (const token of ['none', 'node_exe', 'cmd_exe', 'other', 'mixed', 'unavailable']) {
      expect(telemetrySource).toContain(token);
    }
    expect(telemetrySource).toContain(
      '"watcher_job_survivor_count" => Some(value.is_empty() || value.parse::<u32>().is_ok())',
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

/** A Node `--report-uncaught-exception` / `--report-on-fatalerror` fixture. */
interface NodeReport {
  trigger: string;
  event: string;
}

/** The exit-boundary live-survivor reading. */
interface JobSurvivors {
  token: string;
  count: number;
}

const SURVIVOR_VOCAB = new Set(['none', 'node_exe', 'cmd_exe', 'other', 'mixed', 'unavailable']);

/** Mirror of `runner_diagnostic_report::classify_report_fatal` (incl. the Exception trigger). */
function classifyReportFatal(report: NodeReport): string {
  const t = report.trigger.toLowerCase();
  if (t === 'signal') return 'none';
  const probe = `${report.trigger} ${report.event}`.toLowerCase();
  if (probe.includes('heap out of memory') || probe.includes('allocation failed')) return 'heap_oom';
  if (t.includes('oom') || t.includes('out of memory')) return 'heap_oom';
  if (t.includes('fatalerror') || t.includes('fatal') || t.includes('exception')) return 'node_fatal';
  return 'none';
}

/**
 * The observed HQ-DESKTOP-66 0xFFFFFFFF indeterminate-exit envelope. This is the
 * FIXED part; the reason/discriminator axes differ by policy. The message and the
 * six-component fingerprint are grouping-critical and must be identical across policies.
 */
function baseIndeterminateEnvelope(): SentryEnvelope {
  return {
    message:
      'auto-sync watcher exited unexpectedly (with Windows status 0xFFFFFFFF (origin unknown))',
    fingerprint: [
      'sync',
      'auto-sync-watcher-termination',
      'windows:status-ffffffff',
      'eperm',
      'none',
      'none',
    ],
    tags: {
      sync_route: 'watcher',
      windows_exit_class: 'indeterminate_status',
      windows_exit_status: '0xFFFFFFFF',
      runner_fatal_class: 'none',
      watcher_fault_provenance: 'not_applicable',
      watcher_child_kind: 'cmd_shim',
    },
  };
}

/**
 * Apply a policy. Pre-fix took the None arm: it never read the report (the seed
 * ships, indistinguishable from a genuinely-missing one) and had no survivor
 * discriminator at all. Post-fix reads the report off the exit path (so
 * runner_report_read is a MEASUREMENT) and renders the survivor discriminator, while
 * watcher_fault_provenance stays not_applicable (this is a non-fault exit).
 */
function applyPolicy(
  policy: Policy,
  report: NodeReport | null,
  survivors: JobSurvivors,
): SentryEnvelope {
  const env = baseIndeterminateEnvelope();

  if (policy === 'pre-fix') {
    // The None arm seeded the token and read nothing — the seed shipped even when a
    // report existed. No survivor discriminator, no measured source.
    env.tags.runner_report_read = 'report_absent';
    return env;
  }

  // post-fix: the report is READ off the exit path.
  if (report === null) {
    env.tags.runner_report_read = 'report_absent';
    env.tags.runner_fatal_source = 'none';
  } else {
    env.tags.runner_report_read = 'report_read';
    const reportClass = classifyReportFatal(report);
    // A report-derived class is adopted ONLY because the stderr channel named none.
    if (reportClass !== 'none' && env.tags.runner_fatal_class === 'none') {
      env.tags.runner_fatal_class = reportClass;
      env.tags.runner_fatal_source = 'node_report';
    } else {
      env.tags.runner_fatal_source = 'none';
    }
  }
  env.tags.watcher_job_survivors = survivors.token;
  env.tags.watcher_job_survivor_count = String(survivors.count);
  return env;
}

const EXCEPTION_REPORT: NodeReport = { trigger: 'Exception', event: 'Uncaught TypeError' };
const ORPHANED_RUNNER: JobSurvivors = { token: 'node_exe', count: 2 };
const TREE_DIED_TOGETHER: JobSurvivors = { token: 'none', count: 0 };

// Fixed vocabulary, bounded integers, digests, the canonical uppercase-hex Windows
// status, and the `>` stack-shape separator — never a path, space, quote, pid, or
// other unsafe byte.
const CONTENT_SAFE = /^[A-Za-z0-9_,:>]+$/;

describe('windows indeterminate-exit attribution — envelope model (both directions)', () => {
  it('pre-fix cannot measure the report even when one was written (the seed ships)', () => {
    const env = applyPolicy('pre-fix', EXCEPTION_REPORT, ORPHANED_RUNNER);
    // The seed is indistinguishable from a genuinely-missing report — the exact
    // "asserted absence no code measured" the plan named.
    expect(env.tags.runner_report_read).toBe('report_absent');
    expect(env.tags.runner_fatal_source).toBeUndefined();
    // The survivor discriminator did not exist on base.
    expect(env.tags.watcher_job_survivors).toBeUndefined();
    expect(env.tags.watcher_job_survivor_count).toBeUndefined();
  });

  it('post-fix measures the report and adopts an uncaught-exception cause', () => {
    const env = applyPolicy('post-fix', EXCEPTION_REPORT, ORPHANED_RUNNER);
    expect(env.tags.runner_report_read).toBe('report_read');
    expect(env.tags.runner_fatal_source).toBe('node_report');
    expect(env.tags.runner_fatal_class).toBe('node_fatal');
    // watcher_fault_provenance stays not_applicable for a non-fault exit — the fault /
    // Event Log channel is NOT widened to non-fault exits.
    expect(env.tags.watcher_fault_provenance).toBe('not_applicable');
  });

  it('post-fix, given NO report, renders a MEASURED report_absent (never a guessed cause)', () => {
    const env = applyPolicy('post-fix', null, TREE_DIED_TOGETHER);
    expect(env.tags.runner_report_read).toBe('report_absent');
    expect(env.tags.runner_fatal_source).toBe('none');
    expect(env.tags.runner_fatal_class).toBe('none');
  });

  it('the survivor discriminator separates an orphaned runner from a tree that died together', () => {
    const orphan = applyPolicy('post-fix', null, ORPHANED_RUNNER);
    expect(orphan.tags.watcher_job_survivors).toBe('node_exe');
    expect(orphan.tags.watcher_job_survivor_count).toBe('2');

    const together = applyPolicy('post-fix', null, TREE_DIED_TOGETHER);
    expect(together.tags.watcher_job_survivors).toBe('none');
    expect(together.tags.watcher_job_survivor_count).toBe('0');

    // Whatever the reading, the token is always from the closed vocabulary.
    for (const survivors of [ORPHANED_RUNNER, TREE_DIED_TOGETHER, { token: 'unavailable', count: 0 }]) {
      const env = applyPolicy('post-fix', null, survivors);
      expect(SURVIVOR_VOCAB.has(env.tags.watcher_job_survivors)).toBe(true);
    }
  });

  it('grouping continuity: message + fingerprint are identical across policies', () => {
    const pre = applyPolicy('pre-fix', EXCEPTION_REPORT, ORPHANED_RUNNER);
    const post = applyPolicy('post-fix', EXCEPTION_REPORT, ORPHANED_RUNNER);
    expect(post.message).toBe(pre.message);
    expect(post.fingerprint).toEqual(pre.fingerprint);
    // The six-component windows:status-ffffffff fingerprint keeps the cluster's
    // history continuous.
    expect(post.fingerprint[2]).toBe('windows:status-ffffffff');
    expect(post.fingerprint).toHaveLength(6);
    // The pre-existing windows exit axes are untouched.
    expect(post.tags.windows_exit_class).toBe(pre.tags.windows_exit_class);
    expect(post.tags.windows_exit_status).toBe(pre.tags.windows_exit_status);
  });

  it('every modeled envelope tag is content-safe (fixed vocabulary + integers, no pids/paths)', () => {
    for (const report of [EXCEPTION_REPORT, null]) {
      for (const survivors of [ORPHANED_RUNNER, TREE_DIED_TOGETHER, { token: 'unavailable', count: 0 }]) {
        const env = applyPolicy('post-fix', report, survivors);
        for (const [key, value] of Object.entries(env.tags)) {
          expect(value, `${key}=${value}`).toMatch(CONTENT_SAFE);
        }
      }
    }
  });
});
