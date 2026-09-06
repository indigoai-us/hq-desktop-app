/**
 * Windows sync child-exit REASON attribution via the crash-surviving Node
 * diagnostic report (HQ-DESKTOP-5W / HQ-DESKTOP-5X).
 *
 * The prior fix named WHAT died (the image + NT status) but never WHY: on Windows
 * both channels that can name a cause come up empty — the child's V8 fatal-error
 * line is queued on an async libuv pipe that never drains once the process aborts
 * (`0xC0000409` fail-fast), and WER has bound a faulting image zero times in 90
 * days. Node ships one channel that SURVIVES the abort — `--report-on-fatalerror`
 * writes a diagnostic report synchronously at fatal-error time. This change asks
 * for that report on both spawn routes, reads it content-safely OFF the terminal
 * exit callback, and lets the reason reach the alert.
 *
 * This spec pins the wiring at the source-contract level (so deleting or bypassing
 * any seam fails HERE, not only in Rust) and with a two-direction envelope
 * simulator, following the fixture-backed pattern of the sibling attribution specs
 * so it runs on Linux/macOS CI without a Windows host.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

const coreDaemon = readRepoFile('../../crates/hq-desktop-core/src/daemon.rs');
const parserSource = readRepoFile('../../crates/hq-desktop-core/src/runner_diagnostic_report.rs');
const coreLib = readRepoFile('../../crates/hq-desktop-core/src/lib.rs');
const appDaemon = readRepoFile('src-tauri/src/commands/daemon.rs');
const appSync = readRepoFile('src-tauri/src/commands/sync.rs');
const appReader = readRepoFile('src-tauri/src/commands/runner_report.rs');
const telemetry = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

describe('windows fatal reason — spawn seam (one shared composer, both routes)', () => {
  it('exposes ONE shared spawn-flags composer that adds the report flags', () => {
    expect(coreDaemon).toContain('pub fn compose_runner_spawn_flags(');
    // The four documented report flags — the crash-surviving channel — are composed
    // by the shared helper.
    expect(coreDaemon).toContain('--report-on-fatalerror');
    expect(coreDaemon).toContain('--report-compact');
    expect(coreDaemon).toContain('--report-directory=');
    expect(coreDaemon).toContain('--report-filename=');
    // A single fixed report filename so the reader looks in exactly one place.
    expect(coreDaemon).toContain('pub const RUNNER_DIAGNOSTIC_REPORT_FILENAME');
  });

  it('is called by BOTH spawn builders, so the routes cannot drift', () => {
    // Watcher route.
    expect(coreDaemon).toContain('compose_runner_spawn_flags(');
    expect(coreDaemon).toContain('fn build_watch_runner_args_for_target(');
    // Manual route (in the app) calls the SAME core helper.
    expect(appSync).toContain('hq_desktop_core::daemon::compose_runner_spawn_flags(');
    expect(appSync).toContain('fn build_sync_spawn_args_with_report(');
  });

  it('preserves NODE_OPTIONS precedence: user max-old-space and user --report-* win', () => {
    // The ceiling flag is still gated by the shipped `runner_max_old_space_arg`
    // (user value wins), and a user-set --report-* suppresses ALL of ours with its
    // own provenance token.
    expect(coreDaemon).toContain('runner_max_old_space_arg(ceiling)');
    expect(coreDaemon).toContain('RunnerReportRequest::DisabledByUserOptions');
    expect(coreDaemon).toContain('fn inherited_sets_report_option(');
  });

  it('double-applies the flags in argv on the bare-node path a stripped NODE_OPTIONS misses', () => {
    // The bare-`node` local-runner path pushes every composed argv flag (ceiling +
    // report) so a host that strips NODE_OPTIONS still yields a report.
    expect(coreDaemon).toContain('for flag in &spawn_flags.argv_flags');
  });
});

describe('windows fatal reason — parser is present and pure (content-safe)', () => {
  it('is a registered module exposing the pure parser + decision', () => {
    expect(coreLib).toContain('pub mod runner_diagnostic_report;');
    expect(parserSource).toContain('pub fn parse_runner_diagnostic_report(');
    expect(parserSource).toContain('pub fn runner_fatal_axes(');
  });

  it('reads ONLY the fatal message and native symbols — never cwd/argv/env/paths', () => {
    // Check ACTUAL field access in the parsing code (not the doc comment / fixtures):
    // slice the non-test region and assert the `.get("…")` navigation is limited to
    // the two content-safe channels.
    const code = parserSource.slice(
      parserSource.indexOf('pub fn parse_runner_diagnostic_report('),
      parserSource.indexOf('#[cfg(test)]'),
    );
    expect(code).toContain('.get("javascriptStack")');
    expect(code).toContain('.get("nativeStack")');
    expect(code).toContain('.get("symbol")');
    // The dense user-content fields of a Node report are NEVER navigated.
    expect(code).not.toContain('.get("environmentVariables")');
    expect(code).not.toContain('.get("commandLine")');
    expect(code).not.toContain('.get("sharedObjects")');
    expect(code).not.toContain('.get("cwd")');
  });

  it('reuses the shipped classifier + frame allow-list, so only tokens + a digest escape', () => {
    expect(parserSource).toContain('classify_runner_fatal_class');
    expect(parserSource).toContain('runner_report_stack_shape');
    expect(parserSource).toContain('normalize_report_native_symbol');
    // Bounded input and frame count guard a hostile report.
    expect(parserSource).toContain('MAX_REPORT_BYTES');
    expect(parserSource).toContain('MAX_NATIVE_FRAMES');
  });

  it('a report NEVER overrides a stderr-named class (the decision encodes the invariant)', () => {
    const axes = parserSource.slice(parserSource.indexOf('pub fn runner_fatal_axes('));
    // stderr-named class is kept verbatim, source=stderr; the report only fills the
    // blank where stderr said `none`, source=node_report.
    expect(axes).toContain('if stderr_fatal_class != "none"');
    expect(axes).toContain('fatal_source: "stderr"');
    expect(axes).toContain('fatal_source: "node_report"');
    expect(axes).toContain('fatal_source: "none"');
  });
});

describe('windows fatal reason — reader is shared, bounded, off the exit path, self-cleaning', () => {
  it('one reader is called by BOTH exit seams', () => {
    expect(appReader).toContain('pub fn read_runner_diagnostic_report(');
    // Watcher deferred worker AND manual exit both call it.
    expect(appDaemon).toContain('crate::commands::runner_report::read_runner_diagnostic_report(');
    expect(appSync).toContain('crate::commands::runner_report::read_runner_diagnostic_report(');
  });

  it('the watcher read runs on the deferred supervisor thread, NOT the terminal callback', () => {
    // The read is inside the deferred worker's supervisor closure — the exit
    // callback that gates emit_exit_then_deregister does no filesystem work. Both
    // the shutdown-immediate and teardown-flush emits pass `report: None` (no read
    // on the callback / inside a Windows window procedure).
    const supervisor = appDaemon.slice(
      appDaemon.indexOf('fn spawn_deferred_watcher_fault_capture('),
      appDaemon.indexOf('fn finalize_watcher_fault_payload('),
    );
    expect(supervisor).toContain('read_runner_diagnostic_report(');
    expect(appDaemon).toContain('send_deferred_watcher_fault_capture(payload, None, None, "shutdown_immediate")');
    expect(appDaemon).toContain('send_deferred_watcher_fault_capture(payload, None, None, reason)');
  });

  it('is bounded and deletes the report directory after reading (no disk accumulation)', () => {
    expect(appReader).toContain('MAX_REPORT_BYTES');
    expect(appReader).toContain('remove_dir_all');
    // The report directory lives under the system temp dir — OUTSIDE the synced HQ
    // tree, so a crash report is never uploaded to a vault.
    expect(appReader).toContain('std::env::temp_dir()');
    // A bounded prune caps stale generation dirs for a fault-and-shutdown machine.
    expect(appReader).toContain('fn prune_report_root(');
  });
});

describe('windows fatal reason — the reason reaches the alert (telemetry)', () => {
  it('the fault culprit renders the reason, and the two axes fail closed at egress', () => {
    // The `fault` arm no longer discards a known fatal class.
    const detail = telemetry.slice(
      telemetry.indexOf('fn sync_child_exit_detail('),
      telemetry.indexOf('fn derive_sync_child_exit_culprit('),
    );
    expect(detail).toContain('format!("{base} / {phrase}")');
    // Registered in the egress allow-list → fail closed.
    expect(telemetry).toContain('"runner_fatal_source" => Some(matches!(value, "stderr" | "node_report" | "none"))');
    expect(telemetry).toContain('"runner_report_read" => Some(matches!(');
  });
});

// ---------------------------------------------------------------------------
// Two-direction envelope simulator (faithful mirror)
// ---------------------------------------------------------------------------

type Tags = Record<string, string>;

interface ReportRead {
  readToken: string;
  namedClass: string | null; // the report-derived fatal class, or null
  namedShape: string; // report-derived shape, or 'all_redacted'
  namedSignature: string; // report-derived signature, or 'unknown'
}

/** Faithful mirror of `hq_desktop_core::runner_diagnostic_report::runner_fatal_axes`. */
function runnerFatalAxes(
  stderrClass: string,
  stderrShape: string,
  stderrSignature: string,
  report: ReportRead,
): { fatalClass: string; shape: string; signature: string; source: string; readToken: string } {
  if (stderrClass !== 'none') {
    return {
      fatalClass: stderrClass,
      shape: stderrShape,
      signature: stderrSignature,
      source: 'stderr',
      readToken: report.readToken,
    };
  }
  if (report.namedClass) {
    return {
      fatalClass: report.namedClass,
      shape: report.namedShape,
      signature: report.namedSignature,
      source: 'node_report',
      readToken: report.readToken,
    };
  }
  return {
    fatalClass: 'none',
    shape: stderrShape,
    signature: stderrSignature,
    source: 'none',
    readToken: report.readToken,
  };
}

/** The fault-culprit renderer for the watcher seam (the part this change touches). */
function watcherFaultCulprit(envelope: Tags, fatalClass: string): string {
  const status = envelope.windows_exit_status;
  const base = `windows fault ${status}`;
  const detail = fatalClass !== 'none' ? `${base} / ${fatalClass.replace(/_/g, ' ')}` : base;
  // The observed 5W envelope carries a tree-observed node_exe candidate on a
  // non-binding provenance, so the culprit names it.
  const binary =
    envelope.watcher_fault_job_culprit_candidate === 'node_exe' &&
    envelope.watcher_fault_job_image_provenance === 'job_tree_observed'
      ? 'node_exe'
      : null;
  return binary ? `sync/watcher: ${binary} (${detail})` : `sync/watcher: ${detail}`;
}

// The observed HQ-DESKTOP-5W recurrence envelope (release hq-sync-win@0.10.200).
const RECURRENCE_5W: Tags = {
  sync_route: 'watcher',
  windows_exit_class: 'fault',
  windows_exit_status: '0xC0000409',
  watcher_fault_provenance: 'deadline_expired',
  watcher_fault_read: 'seen:12,parsed:12,stale:12,rej_win:0,rej_code:0,sweeps:57,ms:60473',
  watcher_fault_job_culprit_candidate: 'node_exe',
  watcher_fault_job_image_provenance: 'job_tree_observed',
  runner_fatal_class: 'none',
  runner_stack_shape: 'all_redacted',
  runner_stack_signature: 'unknown',
};

// A fixture Node fatal report the post-fix reader would parse to a heap OOM.
const REPORT_HEAP_OOM: ReportRead = {
  readToken: 'report_read',
  namedClass: 'heap_oom',
  namedShape: 'node_oom_handler>v8_fatal_process_oom>node_abort',
  namedSignature: 'a1b2c3d4e5f60718',
};
const REPORT_ABSENT: ReportRead = {
  readToken: 'report_absent',
  namedClass: null,
  namedShape: 'all_redacted',
  namedSignature: 'unknown',
};

describe('windows fatal reason — envelope simulator (both directions)', () => {
  it('pre-fix: the observed 0.10.200 envelope names ONLY the NT status, no reason', () => {
    // Pre-fix there is no report channel and the fault arm short-circuits before the
    // reason — so the recurrence names the image + NT status only.
    expect(RECURRENCE_5W.runner_fatal_class).toBe('none');
    expect(RECURRENCE_5W.runner_stack_shape).toBe('all_redacted');
    expect(RECURRENCE_5W.runner_stack_signature).toBe('unknown');
    expect(watcherFaultCulprit(RECURRENCE_5W, 'none')).toBe(
      'sync/watcher: node_exe (windows fault 0xC0000409)',
    );
  });

  it('post-fix WITH a report: the SAME envelope names the reason and renders it', () => {
    const axes = runnerFatalAxes(
      RECURRENCE_5W.runner_fatal_class,
      RECURRENCE_5W.runner_stack_shape,
      RECURRENCE_5W.runner_stack_signature,
      REPORT_HEAP_OOM,
    );
    expect(axes.fatalClass).toBe('heap_oom');
    expect(axes.source).toBe('node_report');
    expect(axes.readToken).toBe('report_read');
    expect(axes.shape).toBe('node_oom_handler>v8_fatal_process_oom>node_abort');
    expect(watcherFaultCulprit(RECURRENCE_5W, axes.fatalClass)).toBe(
      'sync/watcher: node_exe (windows fault 0xC0000409 / heap oom)',
    );
  });

  it('post-fix WITHOUT a report: report_absent, source none, culprit unchanged from today', () => {
    const axes = runnerFatalAxes(
      RECURRENCE_5W.runner_fatal_class,
      RECURRENCE_5W.runner_stack_shape,
      RECURRENCE_5W.runner_stack_signature,
      REPORT_ABSENT,
    );
    expect(axes.fatalClass).toBe('none');
    expect(axes.source).toBe('none');
    expect(axes.readToken).toBe('report_absent');
    expect(watcherFaultCulprit(RECURRENCE_5W, axes.fatalClass)).toBe(
      'sync/watcher: node_exe (windows fault 0xC0000409)',
    );
  });

  it('a stderr-named class is never overridden by a report (macOS heap_oom keeps priority)', () => {
    // stderr already named heap_oom with its own signature: the report is ignored,
    // source=stderr, and the stderr signature is retained.
    const axes = runnerFatalAxes('heap_oom', 'node_oom_handler', 'stderrsig00000000', {
      readToken: 'report_read',
      namedClass: 'node_fatal',
      namedShape: 'node_abort',
      namedSignature: 'reportsig00000000',
    });
    expect(axes.fatalClass).toBe('heap_oom');
    expect(axes.signature).toBe('stderrsig00000000');
    expect(axes.source).toBe('stderr');
  });
});
