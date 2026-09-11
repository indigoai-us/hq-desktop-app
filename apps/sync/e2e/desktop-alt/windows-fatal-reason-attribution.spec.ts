/**
 * Windows fatal-reason attribution — the crash-surviving third cause channel
 * (HQ-DESKTOP-5W, this reopen).
 *
 * The prior fix HELD but was INCOMPLETE: the post-fix recurrence
 * (hq-sync-win@0.10.200, event 781a20c9…) carries a NAMED culprit
 * ("sync/watcher: node_exe (windows fault 0xC0000409)") and the corrected
 * deadline_expired / stale accounting — proof the merged legs landed — yet it
 * still cannot name WHY the child died: runner_fatal_class=none,
 * runner_stack_shape=all_redacted, runner_stack_signature=unknown, with heavy
 * stderr traffic the classifier matched none of
 * (runner_unmatched_stderr_shapes=ndjson_record:1696,other:528,key_colon:31).
 *
 * On Windows both existing "why" channels are empirically dead for a 0xC0000409
 * fail-fast: WER binds no usable Application-Error record (pid_matched/window_only
 * = 0 in 90 days), and the runner's fatal stderr is queued on an async libuv pipe
 * and lost when the process dies. This lane adds a THIRD channel that survives the
 * abort — Node's `--report-on-fatalerror`, which writes a diagnostic report
 * SYNCHRONOUSLY at fatal-error time — reads it content-safely off the exit path,
 * and lets the reason reach the alert (the telemetry culprit no longer discards a
 * known fatal class for a Windows fault).
 *
 * The Rust suites (hq-desktop-core, hq-telemetry, and the app-crate wiring tests)
 * pin the seam from the inside. This spec pins the same properties at the
 * *source-contract* and *artifact* levels, following the fixture-backed pattern of
 * watcher-fault-deferred-attribution.spec.ts, so it runs on Linux/macOS CI and
 * proves the base-red / candidate-pass pair without a Windows host.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary, bounded
 * integers, and a digest — never argv, stderr, symbols, paths, or company slugs.
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// repoRoot is apps/sync; shared crate sources are read via '../../crates'.
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const syncSource = readRepoFile('src-tauri/src/commands/sync.rs');
const coreDaemonSource = readRepoFile('../../crates/hq-desktop-core/src/daemon.rs');
const coreReportSource = readRepoFile('../../crates/hq-desktop-core/src/runner_diagnostic_report.rs');
const coreSyncOutcomeSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

describe('windows fatal-reason attribution — source contracts', () => {
  it('asks Node for a crash-surviving report at ONE shared spawn-flags helper', () => {
    // The single shared composer exists, appends every report flag, and preserves
    // the ceiling precedence verbatim.
    expect(coreDaemonSource).toContain('pub fn compose_runner_spawn_flags(');
    for (const flag of [
      '--report-on-fatalerror',
      '--report-compact',
      '--report-directory=',
      '--report-filename=',
    ]) {
      expect(coreDaemonSource).toContain(flag);
    }
    expect(coreDaemonSource).toContain(
      'pub const RUNNER_DIAGNOSTIC_REPORT_FILENAME: &str = "runner-fatal.json";',
    );
    // A user's own --report-* suppresses ours (both spellings), recorded as its
    // own provenance token.
    expect(coreDaemonSource).toContain('pub fn node_options_has_report_flag(');
    expect(coreDaemonSource).toContain('DisabledByUserOptions');
    expect(coreDaemonSource).toContain('report_disabled_by_user_options');
  });

  it('calls the SAME spawn helper from BOTH spawn builders (no per-route copy)', () => {
    // The watcher builder (core) and the manual builder (app) both compose their
    // NODE_OPTIONS through the one shared helper, so the two routes cannot drift.
    const composeCalls = coreDaemonSource.split('compose_runner_spawn_flags(').length - 1;
    // At least the definition + the watcher-builder call site.
    expect(composeCalls).toBeGreaterThanOrEqual(2);
    expect(coreDaemonSource).toContain('build_watch_runner_args_for_target');
    expect(syncSource).toContain('hq_desktop_core::daemon::compose_runner_spawn_flags(');
    expect(syncSource).toContain('fn build_sync_spawn_args(');
    // The bare-`node` path double-applies the flags in argv (mirrors the ceiling).
    expect(coreDaemonSource).toContain('spawn_flags.node_argv');
  });

  it('reads the report content-safely in a PURE, size-capped, frame-capped parser', () => {
    expect(coreReportSource).toContain('pub fn parse_runner_diagnostic_report(');
    expect(coreReportSource).toContain('pub enum RunnerReportRead');
    expect(coreReportSource).toContain('pub const RUNNER_REPORT_MAX_BYTES');
    expect(coreReportSource).toContain('RUNNER_REPORT_NATIVE_FRAME_CAP');
    // The shape/signature are built through the EXISTING macOS heap-OOM frame
    // allow-list, not a new one.
    expect(coreReportSource).toContain('runner_stack_shape_from_native_symbols');
    expect(coreSyncOutcomeSource).toContain('pub fn runner_stack_shape_from_native_symbols(');
    expect(coreSyncOutcomeSource).toContain('heap_oom_stack_shape(symbols)');
    // A truncated/oversized/non-Node document degrades to an honesty token.
    expect(coreReportSource).toContain('RunnerDiagnosticReport::unreadable()');
    // The classifier consults ONLY Node-emitted trigger/event, never the message.
    expect(coreReportSource).toContain('fn classify_report_fatal(trigger: &str, event: &str)');
  });

  it('reads the report OFF the terminal exit callback, bounded, and deletes it', () => {
    // The read runs on the SAME deferred worker that already runs read_watcher_fault,
    // NOT in the terminal exit callback that gates emit_exit_then_deregister.
    expect(daemonSource).toContain('fn spawn_deferred_watcher_fault_capture(');
    expect(daemonSource).toContain('let report = read_runner_diagnostic_report(&report_dir);');
    expect(daemonSource).toContain('apply_report_to_fault_tags(&mut payload.tags, &report);');
    // The reader is a single bounded read (no directory listing) that removes the
    // report directory after reading, bounding disk on a crash-looping machine.
    expect(daemonSource).toContain('pub(crate) fn read_runner_diagnostic_report(');
    expect(daemonSource).toContain('RUNNER_REPORT_READ_MAX_BYTES');
    expect(daemonSource).toContain('remove_runner_report_dir(report_dir);');
    // Disk is bounded: leaked sibling directories are pruned at spawn (race-free —
    // the newest prior generation, the only one with a possible in-flight read, is
    // never pruned).
    expect(daemonSource).toContain('fn prune_stale_runner_report_siblings(');
    // The manual route shares the SAME one reader (no second copy).
    expect(syncSource).toContain('crate::commands::daemon::read_runner_diagnostic_report(');
  });

  it('a report-derived class NEVER overrides a stderr-derived one', () => {
    // The deferred worker adopts a report class only when the current class is none;
    // the manual builder adopts it only when the stderr class is None — so macOS
    // heap_oom and every existing stderr attribution keep priority.
    expect(daemonSource).toContain('current_class == "none"');
    expect(syncSource).toContain('stderr_class == RunnerFatalClass::None');
    expect(syncSource).toContain('"node_report"');
  });

  it('lets the reason reach the alert and gates the new axes at egress', () => {
    // The culprit no longer discards a known fatal class for a Windows fault: it
    // renders BOTH the windows shape and the reason.
    expect(telemetrySource).toContain('format!("{windows_phrase} / {reason}")');
    // The two new axes are allow-list validated with the same fail-closed discipline.
    expect(telemetrySource).toContain(
      '"runner_fatal_source" => Some(matches!(value, "stderr" | "node_report" | "none"))',
    );
    expect(telemetrySource).toContain('"runner_report_read" => Some(matches!(');
    for (const token of [
      'report_read',
      'report_absent',
      'report_unreadable',
      'report_not_requested',
      'report_disabled_by_user_options',
    ]) {
      expect(telemetrySource).toContain(token);
    }
  });

  it('escapes the report directory so a Windows path survives Node’s NODE_OPTIONS parser', () => {
    // The HQ-DESKTOP-5W recurrence defect: the report directory was double-quoted but
    // UNESCAPED, so Node's NODE_OPTIONS parser ate every Windows separator and the exit
    // reader found nothing (`report_absent`). The fix renders it through a pure encoder
    // that escapes backslash and quote; the argv mirror stays a single unquoted OS
    // argument.
    expect(coreDaemonSource).toContain('fn node_options_quoted_value(');
    expect(coreDaemonSource).toContain(
      'node_options_quoted_value(&report_dir.display().to_string())',
    );
    // A faithful port of Node's own tokenizer is the in-crate round-trip oracle the
    // prior suite lacked (every prior fixture path was POSIX).
    expect(coreDaemonSource).toContain('fn node_options_tokenize(');
    expect(coreDaemonSource).toContain(
      'fn node_options_report_directory_round_trips_through_the_node_tokenizer(',
    );
  });

  it('records report-directory delivery provenance at both routes and gates it at egress', () => {
    expect(coreDaemonSource).toContain('pub enum RunnerReportDirDelivery');
    expect(coreDaemonSource).toContain('pub fn resolve_runner_report_dir_delivery(');
    // Both exit seams emit the axis (watcher + manual), from the one shared resolver.
    expect(daemonSource).toContain('"runner_report_dir_delivery"');
    expect(syncSource).toContain('"runner_report_dir_delivery"');
    // The egress allow-list validates the exact fixed vocabulary and fails closed.
    expect(telemetrySource).toContain('"runner_report_dir_delivery" => Some(matches!(');
    for (const token of ['env_escaped', 'env_and_argv', 'disabled_by_user_options', 'not_requested']) {
      expect(telemetrySource).toContain(token);
    }
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
  culprit: string | null;
}

/** A Node `--report-on-fatalerror` fixture, or null when none was written. */
interface NodeReport {
  trigger: string;
  event: string;
  /** Whether the native OOM stack was present (drives shape != all_redacted). */
  nativeOomStack: boolean;
}

const RUNNER_FATAL_CLASS_TOKENS = new Set([
  'libuv_assert',
  'libuv_fatal_syscall',
  'node_check_abort',
  'node_fatal',
  'heap_oom',
  'rust_panic',
  'exec_permission_denied',
  'exec_not_found',
  'node_too_old',
  'disk_full',
  'npm_install_relay',
  'none',
]);

/** Mirror of `runner_diagnostic_report::classify_report_fatal` for the OOM/fatal cases. */
function classifyReportFatal(report: NodeReport): string {
  const probe = `${report.trigger} ${report.event}`.toLowerCase();
  if (probe.includes('heap out of memory') || probe.includes('allocation failed')) {
    return 'heap_oom';
  }
  const t = report.trigger.toLowerCase();
  if (t.includes('oom') || t.includes('out of memory')) return 'heap_oom';
  if (t.includes('fatalerror') || t.includes('fatal') || t.includes('exception')) return 'node_fatal';
  return 'none';
}

/** Mirror of hq-telemetry `sync_child_exit_detail`, INCLUDING this lane's fix. */
function syncChildExitDetail(
  exitClass: string | undefined,
  exitStatus: string | undefined,
  fatalClass: string | undefined,
): string | null {
  const fatalPhrase = () =>
    fatalClass && RUNNER_FATAL_CLASS_TOKENS.has(fatalClass) && fatalClass !== 'none'
      ? fatalClass.replace(/_/g, ' ')
      : null;
  const isWindowsClass = ['console_control', 'session_terminate', 'indeterminate_status', 'fault', 'ordinary'].includes(
    exitClass ?? '',
  );
  if (!isWindowsClass) return fatalPhrase();
  const status = exitStatus && /^0x[0-9A-F]{8}$/.test(exitStatus) ? exitStatus : null;
  let windowsPhrase: string;
  switch (exitClass) {
    case 'fault':
      windowsPhrase = status ? `windows fault ${status}` : 'windows fault';
      break;
    case 'session_terminate':
      windowsPhrase = 'windows session terminate';
      break;
    case 'console_control':
      windowsPhrase = 'windows console control';
      break;
    case 'indeterminate_status':
      windowsPhrase = 'windows indeterminate status';
      break;
    default:
      return fatalPhrase();
  }
  const reason = fatalPhrase();
  return reason ? `${windowsPhrase} / ${reason}` : windowsPhrase;
}

/** Mirror of hq-telemetry `derive_sync_child_exit_culprit` (watcher/manual). */
function deriveCulprit(tags: Record<string, string>): string | null {
  const seam = tags.sync_route === 'watcher' ? 'watcher' : tags.sync_route === 'manual' ? 'runner' : null;
  if (!seam || tags.runner_fatal_class === undefined) return null;
  let prefix = `sync/${seam}`;
  if (seam === 'runner' && ['scan', 'push', 'pull'].includes(tags.runner_phase ?? '')) {
    prefix += ` ${tags.runner_phase}`;
  }
  const namedBinary = (v: string | undefined) =>
    v && v !== 'unavailable' && v !== 'other' ? v : null;
  let binary: string | null = null;
  if (['pid_matched', 'window_only'].includes(tags.watcher_fault_provenance ?? '')) {
    binary = namedBinary(tags.watcher_fault_faulting_image);
  } else if (tags.watcher_fault_job_image_provenance === 'job_tree_observed') {
    binary = namedBinary(tags.watcher_fault_job_culprit_candidate);
  }
  const detail = syncChildExitDetail(
    tags.windows_exit_class,
    tags.windows_exit_status,
    tags.runner_fatal_class,
  );
  if (binary && detail) return `${prefix}: ${binary} (${detail})`;
  if (binary) return `${prefix}: ${binary}`;
  if (detail) return `${prefix}: ${detail}`;
  return prefix;
}

/**
 * The observed HQ-DESKTOP-5W 0.10.200 recurrence envelope: both prior-fix legs
 * landed (named culprit candidate + corrected deadline_expired/stale accounting),
 * but the reason is still blank. This is the FIXED part; the reason axes differ by
 * policy.
 */
function baseRecurrenceEnvelope(): SentryEnvelope {
  return {
    message: 'auto-sync watcher exited unexpectedly',
    fingerprint: ['sync', 'auto-sync-watcher-termination', 'windows:fault:0xC0000409', 'none'],
    tags: {
      sync_route: 'watcher',
      windows_exit_class: 'fault',
      windows_exit_status: '0xC0000409',
      runner_fatal_class: 'none',
      runner_stack_shape: 'all_redacted',
      runner_stack_signature: 'unknown',
      watcher_fault_provenance: 'deadline_expired',
      watcher_fault_faulting_image: 'unavailable',
      watcher_fault_job_culprit_candidate: 'node_exe',
      watcher_fault_job_image_provenance: 'job_tree_observed',
      watcher_fault_read: 'seen:12,parsed:12,stale:12,rej_win:0,rej_code:0,sweeps:57,ms:60473',
      runner_unmatched_stderr_shapes: 'ndjson_record:1696,other:528,key_colon:31',
    },
    culprit: null,
  };
}

/**
 * Apply a policy to the recurrence envelope. Pre-fix ships no reason axes at all
 * (they do not exist) and cannot name the cause. Post-fix adds the two axes and,
 * when a report named a cause the stderr channel lost, adopts it — flipping
 * runner_fatal_source to node_report and rendering the reason in the culprit.
 */
function applyPolicy(policy: Policy, report: NodeReport | null): SentryEnvelope {
  const env = baseRecurrenceEnvelope();

  if (policy === 'pre-fix') {
    // The reason axes did not exist, and a valid Windows class short-circuited the
    // culprit so the reason (had one existed) was dropped.
    env.culprit = deriveCulprit(env.tags);
    return env;
  }

  // post-fix: the production watcher is the npx/cmd_shim path, so the report
  // directory is delivered through the escaped NODE_OPTIONS value only — recorded as
  // env_escaped regardless of whether a report was ultimately written.
  env.tags.runner_report_dir_delivery = 'env_escaped';
  // seed the read provenance, then read the report.
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
      env.tags.runner_stack_shape = report.nativeOomStack
        ? 'node_oom_handler>v8_report_oom>v8_fatal_process_oom'
        : 'all_redacted';
      env.tags.runner_stack_signature = report.nativeOomStack ? '0f1e2d3c4b5a6978' : 'unknown';
    } else {
      env.tags.runner_fatal_source = 'none';
    }
  }
  env.culprit = deriveCulprit(env.tags);
  return env;
}

const HEAP_OOM_REPORT: NodeReport = {
  trigger: 'FatalError',
  event: 'Allocation failed - JavaScript heap out of memory',
  nativeOomStack: true,
};

// Fixed vocabulary, bounded integers, digests, the canonical uppercase-hex
// Windows status, and the `>` stack-shape separator — never a path, space, quote,
// or other unsafe byte.
const CONTENT_SAFE = /^[A-Za-z0-9_,:>]+$/;

describe('windows fatal-reason attribution — envelope model (both directions)', () => {
  it('pre-fix reproduces the observed 0.10.200 envelope verbatim (no reason)', () => {
    const env = applyPolicy('pre-fix', HEAP_OOM_REPORT);
    expect(env.tags.runner_fatal_class).toBe('none');
    expect(env.tags.runner_stack_shape).toBe('all_redacted');
    expect(env.tags.runner_stack_signature).toBe('unknown');
    expect(env.tags.watcher_fault_provenance).toBe('deadline_expired');
    expect(env.tags.watcher_fault_read).toBe(
      'seen:12,parsed:12,stale:12,rej_win:0,rej_code:0,sweeps:57,ms:60473',
    );
    // The reason axes do not exist on base.
    expect(env.tags.runner_fatal_source).toBeUndefined();
    expect(env.tags.runner_report_read).toBeUndefined();
    expect(env.tags.runner_report_dir_delivery).toBeUndefined();
    // The culprit names the shape + candidate, but NOT a reason.
    expect(env.culprit).toBe('sync/watcher: node_exe (windows fault 0xC0000409)');
    expect(env.culprit).not.toContain('heap oom');
  });

  it('post-fix, given the SAME envelope + a Node fatal report, names the reason', () => {
    const env = applyPolicy('post-fix', HEAP_OOM_REPORT);
    expect(env.tags.runner_report_read).toBe('report_read');
    expect(env.tags.runner_fatal_source).toBe('node_report');
    expect(env.tags.runner_fatal_class).toBe('heap_oom');
    expect(env.tags.runner_stack_shape).not.toBe('all_redacted');
    expect(env.tags.runner_stack_signature).toMatch(/^[0-9a-f]{16}$/);
    // The culprit now names BOTH the Windows shape and the cause.
    expect(env.culprit).toBe('sync/watcher: node_exe (windows fault 0xC0000409 / heap oom)');
  });

  it('post-fix, given NO report, renders report_absent and today’s culprit unchanged', () => {
    const env = applyPolicy('post-fix', null);
    expect(env.tags.runner_report_read).toBe('report_absent');
    expect(env.tags.runner_fatal_source).toBe('none');
    expect(env.tags.runner_fatal_class).toBe('none');
    // Byte-identical to the base culprit — a missing report is never a fabricated cause.
    expect(env.culprit).toBe('sync/watcher: node_exe (windows fault 0xC0000409)');
  });

  it('post-fix attributes an empty channel: env_escaped delivery alongside report_absent', () => {
    // The exact recurrence shape after this lane: a 0xC0000409 exit whose report channel
    // was armed and delivered correctly but wrote nothing. `report_absent` is now
    // decisive, not ambiguous — the delivery axis proves Node WAS asked correctly, which
    // is the positive evidence a further lane would need.
    const env = applyPolicy('post-fix', null);
    expect(env.tags.runner_report_read).toBe('report_absent');
    expect(env.tags.runner_report_dir_delivery).toBe('env_escaped');
    expect(env.tags.runner_fatal_source).toBe('none');
  });

  it('grouping continuity: message + fingerprint are identical across policies', () => {
    const pre = applyPolicy('pre-fix', HEAP_OOM_REPORT);
    const post = applyPolicy('post-fix', HEAP_OOM_REPORT);
    expect(post.message).toBe(pre.message);
    expect(post.fingerprint).toEqual(pre.fingerprint);
    // Only diagnostic reason axes + the enriched attribution differ; the fixed
    // watcher_fault_* accounting and the stderr rollup are untouched.
    expect(post.tags.watcher_fault_provenance).toBe(pre.tags.watcher_fault_provenance);
    expect(post.tags.watcher_fault_read).toBe(pre.tags.watcher_fault_read);
    expect(post.tags.runner_unmatched_stderr_shapes).toBe(pre.tags.runner_unmatched_stderr_shapes);
  });

  it('every modeled envelope tag is content-safe (fixed vocabulary + integers)', () => {
    for (const report of [HEAP_OOM_REPORT, null]) {
      const env = applyPolicy('post-fix', report);
      for (const [key, value] of Object.entries(env.tags)) {
        expect(value, `${key}=${value}`).toMatch(CONTENT_SAFE);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact-level round-trip against the REAL Node NODE_OPTIONS parser
// ---------------------------------------------------------------------------

/**
 * Mirror of `daemon.rs::node_options_quoted_value`: wrap the value in double quotes
 * and escape every backslash and double quote, so Node's `ParseNodeOptionsEnvVar`
 * decodes it back byte-for-byte. The in-crate Rust oracle proves the encoder against
 * a faithful port of the tokenizer; this proves the SAME rule against the ACTUAL
 * parser in the repo's own Node — platform-independent, so it runs on Linux/macOS CI
 * without a Windows host.
 */
function nodeOptionsQuotedValue(value: string): string {
  let out = '"';
  for (const ch of value) {
    if (ch === '\\' || ch === '"') out += '\\';
    out += ch;
  }
  return `${out}"`;
}

/**
 * Compose the NODE_OPTIONS the app emits for a report directory, run the repo's own
 * Node with it, and return what Node actually parsed as `process.report.directory`.
 * `node -p` never writes a report, so a Windows-shaped directory is never touched on
 * disk — only parsed.
 */
function reportDirectoryThroughRealNode(directoryToken: string): string {
  const nodeOptions = [
    '--report-on-fatalerror',
    '--report-uncaught-exception',
    '--report-compact',
    `--report-directory=${directoryToken}`,
    '--report-filename=runner-fatal.json',
  ].join(' ');
  const out = execFileSync(process.execPath, ['-p', 'process.report.directory'], {
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    encoding: 'utf8',
  });
  return out.replace(/\r?\n$/, '');
}

describe('windows fatal-reason attribution — artifact round-trip (real Node parser)', () => {
  // NOTE: written with normal escaped strings (not String.raw) because a template
  // literal ending in a backslash escapes its own closing backtick — the exact
  // trailing-separator case below. Each `\\` is a single backslash at runtime.
  const MATRIX = [
    'C:\\Users\\donal\\.hq\\runner-reports\\watcher\\12',
    'C:\\Users\\Ada Lovelace\\.hq\\rr\\7',
    'C:\\Users\\donal\\.hq\\rr\\7\\',
    '/home/ada/.hq/runner-reports/7',
    '/home/ada/Ada Lovelace/.hq/rr/7',
    'C:\\weird"name\\rr',
  ];

  it('the escaped encoder round-trips every directory through the real Node parser', () => {
    for (const dir of MATRIX) {
      expect(reportDirectoryThroughRealNode(nodeOptionsQuotedValue(dir)), dir).toBe(dir);
    }
  });

  it('the prior double-quoted-but-unescaped rendering is proven to LOSE Windows separators', () => {
    // Non-vacuity / base-red: the naive rendering the prior fix shipped mangles a
    // Windows path against the same real parser, so the round-trip above is a genuine
    // base-red / candidate-green pair rather than a tautology.
    const dir = 'C:\\Users\\donal\\.hq\\rr\\12';
    const mangled = reportDirectoryThroughRealNode(`"${dir}"`);
    expect(mangled).not.toBe(dir);
    expect(mangled).toBe('C:Usersdonal.hqrr12');
  });
});
