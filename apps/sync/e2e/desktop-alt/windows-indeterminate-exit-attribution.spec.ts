/**
 * Windows INDETERMINATE-status attribution — closing the four silent channels for a
 * 0xFFFFFFFF watcher exit (HQ-DESKTOP-66).
 *
 * The observed event (hq-sync-win@0.10.210, event 0338d8de…) died with
 * windows_exit_status=0xFFFFFFFF, sync_route=watcher, watcher_child_kind=cmd_shim and
 * named NO cause: runner_report_read=report_absent, runner_fatal_class=none,
 * runner_stack_shape=all_redacted, watcher_fault_provenance=not_applicable. That was
 * not missing evidence — every cause channel was structurally gated off for this exit
 * class:
 *
 *  - The crash-surviving Node diagnostic report was REQUESTED for the generation and
 *    then never read: the watcher-route reader lives inside the Windows-fault deferred
 *    worker, which a non-fault (indeterminate) exit never builds, so runner_report_read
 *    kept its pre-read SEED — "requested, never read" was indistinguishable on the wire
 *    from "read, file missing".
 *  - The observed 0xFFFFFFFF belongs to the cmd.exe batch shim, not the Node runner, so
 *    the runner's own fate was never observed.
 *
 * This lane makes the next occurrence DECIDABLE:
 *  - Leg A/A2: decouple the report read from the Windows-fault deferral so a non-fault
 *    exit that requested a report reads it OFF the terminal exit callback on a bounded
 *    worker (through the SAME read_runner_diagnostic_report + apply_report_to_fault_tags
 *    the fault worker and the manual route use), turning runner_report_read into a
 *    MEASUREMENT, and removes the report directory so it is no longer left unread.
 *  - Leg B: arm --report-uncaught-exception on both spawn spellings so an uncaught
 *    exception in the runner leaves a crash-surviving artifact on Windows too.
 *  - Leg C: record watcher_job_survivors / watcher_job_survivor_count — the images of
 *    the Job Object processes STILL LIVE at the exit boundary — the single fact that
 *    separates shim-death from a surviving orphaned runner.
 *  - Leg D: register both new tags in the hq-telemetry allow-list so they fail CLOSED.
 *
 * The Rust suites (hq-desktop-core, hq-telemetry, the app-crate wiring tests) pin the
 * seam from the inside. This spec pins the same properties at the SOURCE-CONTRACT and
 * ARTIFACT levels, following the fixture-backed pattern of
 * windows-fatal-reason-attribution.spec.ts, so it runs on Linux/macOS CI without a
 * Windows host.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary, bounded
 * integers, and a digest — never argv, stderr, symbols, paths, or company slugs.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// repoRoot is apps/sync; shared crate sources are read via '../../crates'.
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const processSource = readRepoFile('src-tauri/src/commands/process.rs');
const mainSource = readRepoFile('src-tauri/src/main.rs');
// HQ-DESKTOP-44 (re-entrant path): the Windows session-end teardown moved out of
// main.rs into the shared fn both RunEvent::Exit and the WH_CALLWNDPROC intercept
// call, so the session-end flush now lives here.
const sessionEndInterceptSource = readRepoFile(
  'src-tauri/src/commands/session_end_intercept.rs',
);
const coreDaemonSource = readRepoFile('../../crates/hq-desktop-core/src/daemon.rs');
const coreWatcherFaultSource = readRepoFile('../../crates/hq-desktop-core/src/watcher_fault.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

describe('windows indeterminate-status attribution — source contracts', () => {
  it('arms the uncaught-exception report on BOTH spawn spellings (Leg B)', () => {
    // Windows otherwise arms only --report-on-fatalerror (the signal report is
    // POSIX-only), so an uncaught JS exception left no crash-surviving artifact.
    const composerHits =
      coreDaemonSource.split('--report-uncaught-exception').length - 1;
    // The argv builder AND the NODE_OPTIONS builder each add it (plus the test).
    expect(composerHits).toBeGreaterThanOrEqual(2);
    expect(coreDaemonSource).toContain('fn runner_report_argv_flags(');
    expect(coreDaemonSource).toContain('fn runner_report_node_options_flags(');
    // Still composed at the ONE shared seam both spawn routes call.
    expect(coreDaemonSource).toContain('pub fn compose_runner_spawn_flags(');
  });

  it('reads the report on the NON-fault watcher path, OFF the exit callback (Leg A)', () => {
    // A dedicated non-fault deferral: the exit seam hands a requested-but-non-fault
    // capture to a bounded worker that reads + applies the report and sends.
    expect(daemonSource).toContain('fn spawn_deferred_runner_report_capture(');
    expect(daemonSource).toContain('fn defer_runner_report_capture(');
    expect(daemonSource).toContain('runner_report_deferred_dir');
    expect(daemonSource).toContain(
      'if let Some(report_dir) = &context.runner_report_deferred_dir {',
    );
    // The read + apply go through the SAME shared reader/applier the fault worker and
    // the manual route use, so the three seams cannot drift.
    expect(daemonSource).toContain('fn apply_deferred_runner_report(');
    expect(daemonSource).toContain('let report = read_runner_diagnostic_report(report_dir);');
    expect(daemonSource).toContain('apply_report_to_fault_tags(tags, &report);');
    // A report-derived class still never overrides a stderr-derived one (shared rule).
    expect(daemonSource).toContain('current_class == "none"');
  });

  it('removes the requested-but-non-fault report directory (Leg A2)', () => {
    // The exit callback cleans exactly the directories no deferred reader will, driven
    // by the handler's returned disposition — so a requested-but-not-deferred
    // generation is no longer left for the sibling prune to delete unread.
    expect(daemonSource).toContain('enum RunnerReportDirDisposition');
    expect(daemonSource).toContain('OwnedByDeferredReader');
    expect(daemonSource).toContain('RunnerReportDirDisposition::DeleteOnExitPath');
    // A teardown flush drains any in-flight non-fault capture (reading its report) so
    // the measured event is never lost.
    expect(daemonSource).toContain('pub fn flush_pending_runner_report_captures(');
    expect(mainSource).toContain(
      'flush_pending_runner_report_captures("app_quit_flush")',
    );
    expect(sessionEndInterceptSource).toContain(
      'flush_pending_runner_report_captures("session_end_flush")',
    );
  });

  it('records the shim-vs-runner survivor discriminator (Leg C)', () => {
    // The crate owns the closed vocabulary (reusing the watcher-fault image tokens).
    expect(coreWatcherFaultSource).toContain('pub struct WatcherJobSurvivors');
    expect(coreWatcherFaultSource).toContain('pub fn from_live_images(');
    expect(coreWatcherFaultSource).toContain(
      'pub const WATCHER_JOB_SURVIVORS_NONE: &str = "none";',
    );
    expect(coreWatcherFaultSource).toContain(
      'pub const WATCHER_JOB_SURVIVORS_MIXED: &str = "mixed";',
    );
    // The app reads live PIDs via the existing read-only job query + image resolver.
    expect(processSource).toContain('pub fn watcher_job_survivors_for_generation(');
    expect(processSource).toContain('query_job_live_pids(job)');
    expect(processSource).toContain('resolve_process_image_token(*pid)');
    // The tag + bare count are emitted from the watcher exit seam.
    expect(daemonSource).toContain('"watcher_job_survivors"');
    expect(daemonSource).toContain('"watcher_job_survivor_count"');
    expect(daemonSource).toContain('watcher_job_survivors_for_generation(');
  });

  it('gates BOTH new axes at telemetry egress so they fail closed (Leg D)', () => {
    expect(telemetrySource).toContain('"watcher_job_survivors" => Some(matches!(');
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
  extras: Record<string, number>;
}

const SURVIVOR_TOKENS = new Set(['none', 'node_exe', 'cmd_exe', 'other', 'mixed', 'unavailable']);
const REPORT_READ_TOKENS = new Set([
  'report_read',
  'report_absent',
  'report_unreadable',
  'report_not_requested',
  'report_disabled_by_user_options',
]);

/**
 * A crash-surviving Node report the runner wrote for this generation, or null when
 * none was written. `named` mirrors classify_report_fatal naming a cause (e.g. an
 * uncaught Exception or a heap OOM the stderr channel lost).
 */
interface NodeReport {
  present: boolean;
  named: boolean;
}

/**
 * Model the 0xFFFFFFFF watcher-exit envelope under a policy. Everything that is NOT a
 * reason axis — message, fingerprint, capture policy, watcher_fault_provenance — stays
 * exactly as the observed event carried it, so grouping continuity is provable.
 */
function modelIndeterminateEnvelope(
  policy: Policy,
  report: NodeReport,
  survivors: string,
  survivorCount: number | null,
): SentryEnvelope {
  const env: SentryEnvelope = {
    // The exact observed message and the six-component fingerprint of this cluster,
    // unchanged by the fix (message text is not a fingerprint input).
    message:
      'auto-sync watcher exited unexpectedly (with Windows status 0xFFFFFFFF (origin unknown)), consecutive failure #1',
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
      windows_exit_status: '0xFFFFFFFF',
      windows_exit_class: 'indeterminate_status',
      watcher_child_kind: 'cmd_shim',
      runner_fatal_class: 'none',
      runner_stack_shape: 'all_redacted',
      runner_stack_signature: 'unknown',
      // A non-fault exit: the Windows fault read never applies, before OR after the fix.
      watcher_fault_provenance: 'not_applicable',
    },
    extras: {},
  };

  if (policy === 'pre-fix') {
    // The report was requested but never read on the watcher route, so the seed shipped
    // unchanged — indistinguishable from a genuinely-missing report. No survivor axis
    // existed at all.
    env.tags.runner_report_read = 'report_absent';
    env.tags.runner_fatal_source = 'none';
    return env;
  }

  // Post-fix: runner_report_read is a MEASUREMENT, and a report that names a cause the
  // stderr channel lost is adopted with runner_fatal_source=node_report.
  if (!report.present) {
    env.tags.runner_report_read = 'report_absent';
    env.tags.runner_fatal_source = 'none';
  } else if (report.named) {
    env.tags.runner_report_read = 'report_read';
    env.tags.runner_fatal_class = 'node_fatal';
    env.tags.runner_stack_shape = 'node_report>node_fatal';
    env.tags.runner_stack_signature = '0123456789abcdef';
    env.tags.runner_fatal_source = 'node_report';
  } else {
    env.tags.runner_report_read = 'report_read';
    env.tags.runner_fatal_source = 'none';
  }

  // The shim-vs-runner discriminator: always present as a closed-vocabulary token; the
  // bare count rides an extra only when the live-PID query ran.
  env.tags.watcher_job_survivors = survivors;
  if (survivorCount !== null) {
    env.extras.watcher_job_survivor_count = survivorCount;
  }
  return env;
}

describe('windows indeterminate-status attribution — modeled envelope', () => {
  it('pre-fix ships the pre-read SEED and no survivor axis (base red)', () => {
    const env = modelIndeterminateEnvelope('pre-fix', { present: true, named: true }, 'unavailable', null);
    // The measurement never happened: the seed is on the wire even though a report was
    // written, and there is no way to tell "requested, unread" from "read, missing".
    expect(env.tags.runner_report_read).toBe('report_absent');
    expect(env.tags.runner_fatal_source).toBe('none');
    expect(env.tags.watcher_job_survivors).toBeUndefined();
    expect(env.extras.watcher_job_survivor_count).toBeUndefined();
  });

  it('post-fix reports a MEASURED report verdict and adopts a named cause', () => {
    const env = modelIndeterminateEnvelope(
      'post-fix',
      { present: true, named: true },
      'node_exe',
      2,
    );
    expect(env.tags.runner_report_read).toBe('report_read');
    expect(env.tags.runner_fatal_class).toBe('node_fatal');
    expect(env.tags.runner_fatal_source).toBe('node_report');
    expect(env.tags.runner_stack_signature).toHaveLength(16);
    // A surviving node_exe: the shim died while the runner kept running.
    expect(env.tags.watcher_job_survivors).toBe('node_exe');
    expect(env.extras.watcher_job_survivor_count).toBe(2);
  });

  it('post-fix still measures an ABSENT report distinctly from the seed', () => {
    const env = modelIndeterminateEnvelope(
      'post-fix',
      { present: false, named: false },
      'none',
      0,
    );
    // Same token string as the seed, but now it is a performed read (the class stays
    // none and the survivor query still ran, count 0 — the tree died together).
    expect(env.tags.runner_report_read).toBe('report_absent');
    expect(env.tags.runner_fatal_class).toBe('none');
    expect(env.tags.watcher_job_survivors).toBe('none');
    expect(env.extras.watcher_job_survivor_count).toBe(0);
  });

  it('grouping continuity: message, fingerprint, and fault provenance are unchanged', () => {
    const pre = modelIndeterminateEnvelope('pre-fix', { present: true, named: true }, 'unavailable', null);
    const post = modelIndeterminateEnvelope('post-fix', { present: true, named: true }, 'node_exe', 2);
    expect(post.message).toBe(pre.message);
    expect(post.fingerprint).toEqual(pre.fingerprint);
    expect(post.fingerprint).toEqual([
      'sync',
      'auto-sync-watcher-termination',
      'windows:status-ffffffff',
      'eperm',
      'none',
      'none',
    ]);
    // A non-fault exit never claims a Windows fault, before or after the fix.
    expect(post.tags.watcher_fault_provenance).toBe('not_applicable');
  });

  it('every new axis is a closed-vocabulary token or a bounded integer', () => {
    for (const survivors of SURVIVOR_TOKENS) {
      const env = modelIndeterminateEnvelope(
        'post-fix',
        { present: true, named: false },
        survivors,
        survivors === 'unavailable' ? null : 3,
      );
      expect(SURVIVOR_TOKENS.has(env.tags.watcher_job_survivors)).toBe(true);
      expect(REPORT_READ_TOKENS.has(env.tags.runner_report_read)).toBe(true);
      if (env.extras.watcher_job_survivor_count !== undefined) {
        expect(Number.isInteger(env.extras.watcher_job_survivor_count)).toBe(true);
        expect(env.extras.watcher_job_survivor_count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('no seeded path / slug / stderr byte appears anywhere in the rendered envelope', () => {
    const seeded = ['/Users/ada', 'C:\\Users', 'node.exe', 'indigo', 'ReadDirectoryChangesW', '.hq'];
    const env = modelIndeterminateEnvelope('post-fix', { present: true, named: true }, 'mixed', 4);
    const rendered = JSON.stringify(env);
    for (const needle of seeded) {
      expect(rendered).not.toContain(needle);
    }
  });
});
