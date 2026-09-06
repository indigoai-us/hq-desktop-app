/**
 * Sync child-exit culprit projection (HQ-DESKTOP-5W / HQ-DESKTOP-5X).
 *
 * Every sync child-exit alert is a `sentry::capture_message`, which carries no
 * exception and no stacktrace, so Sentry derives an EMPTY culprit — the issue
 * reads "cannot name a culprit" even though the event already carries the
 * fixed-vocabulary tags (sync_route, windows_exit_class/status, runner_fatal_class,
 * the WER binary candidate) that name the failing seam. `before_send` is the ONE
 * site that projects a bounded, content-safe culprit from those tags.
 *
 * Content-safety is absolute: `Event.culprit` is NOT a tag, so the runner-diagnostic
 * tag scrubber does not cover it. The builder therefore re-validates EVERY
 * component itself against the same allow-list predicates, so a producer bug that
 * shipped a path, a company slug, a machine name, or a raw process name into a tag
 * can never reach the culprit.
 *
 * This spec pins those properties at the source-contract level and with a
 * two-direction simulator, following the fixture-backed pattern of the sibling
 * attribution specs, so it runs on Linux/macOS CI without a Windows host.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

/** Slice the region between two unique anchors; throw rather than degrade. */
function sliceBetween(source: string, startAnchor: string, endAnchor: string, label: string): string {
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

describe('sync exit culprit — source contracts (hq-telemetry)', () => {
  const builder = sliceBetween(
    telemetrySource,
    'fn derive_sync_child_exit_culprit(',
    'pub fn before_send(',
    'derive_sync_child_exit_culprit',
  );

  it('projects the culprit at exactly ONE site, inside before_send, only when empty', () => {
    expect(telemetrySource).toContain('fn derive_sync_child_exit_culprit(');
    expect(telemetrySource).toContain(
      'if let Some(culprit) = derive_sync_child_exit_culprit(&event) {',
    );
    // Exactly one assignment to Event.culprit anywhere in the crate.
    const assigns = telemetrySource.split('event.culprit = Some(culprit)').length - 1;
    expect(assigns).toBe(1);
    // Guarded on the event having no culprit already — it never overwrites one.
    expect(telemetrySource).toContain(
      'if event.culprit.as_deref().map_or(true, str::is_empty) {',
    );
  });

  it('reads ONLY allow-listed tag axes, never the message or request', () => {
    // Every component comes from a re-validated tag; the builder never reads the
    // event message or any free-text field.
    expect(builder).toContain('event.tags.get(key)');
    expect(builder).not.toContain('event.message');
    expect(builder).not.toContain('event.request');
    expect(builder).not.toContain('breadcrumb');
    // The gate: only a valid sync_route capture is ever named.
    expect(builder).toContain('match tag("sync_route")');
    expect(builder).toContain('Some("watcher") => "watcher"');
    expect(builder).toContain('Some("manual") => "runner"');
    expect(builder).toContain('_ => return None');
  });

  it('re-validates every component against the allow-list predicates', () => {
    // Because culprit is not a tag, the tag scrubber does not cover it; the builder
    // re-validates each axis itself so a poisoned producer value cannot ride in.
    expect(builder).toContain('watcher_fault_named_binary');
    expect(telemetrySource).toContain('fn is_windows_exit_class_token(');
    expect(telemetrySource).toContain('fn is_windows_exit_status_hex(');
    expect(telemetrySource).toContain('fn is_runner_fatal_class_token(');
    // A named binary is only projected on a BOUND provenance, or a tree-observed
    // candidate — a weaker signal is never promoted to a fault attribution.
    expect(builder).toContain('Some("pid_matched" | "window_only")');
    expect(builder).toContain('== Some("job_tree_observed")');
    // The two non-name sentinels are never named.
    expect(telemetrySource).toContain('"unavailable" | "other" => None');
  });

  it('gates on the child-exit discriminator and never falls a bound image back to a candidate', () => {
    // The exit-specific discriminator: a valid sync_route is not enough; the
    // capture must also carry runner_fatal_class (both exit seams set it; the
    // non-exit memory-preempt does not).
    expect(builder).toContain('if tag("runner_fatal_class").is_none() {');
    // Bound provenance names ONLY the bound image; the candidate fallback lives in
    // the `else` (non-binding) arm, so a bound-but-unnamed image is never replaced.
    const boundArm = builder.indexOf(
      'tag("watcher_fault_faulting_image").and_then(watcher_fault_named_binary)',
    );
    const elseArm = builder.indexOf('} else {');
    const candidateArm = builder.indexOf(
      'tag("watcher_fault_job_culprit_candidate").and_then(watcher_fault_named_binary)',
    );
    expect(boundArm).toBeGreaterThan(-1);
    expect(elseArm).toBeGreaterThan(boundArm);
    expect(candidateArm).toBeGreaterThan(elseArm);
  });

  it('names the runner fatal reason alongside a Windows fault, and registers the new axes', () => {
    // The `fault` arm no longer short-circuits before the fatal phrase — it appends
    // "/ <reason>" when a fatal class is known (base-red: this construction does not
    // exist before the fix). This is what lets the Windows fail-fast finally reach
    // the alert with a reason, via the crash-surviving Node report.
    const detail = sliceBetween(
      telemetrySource,
      'fn sync_child_exit_detail(',
      'fn derive_sync_child_exit_culprit(',
      'sync_child_exit_detail',
    );
    expect(detail).toContain('format!("{base} / {phrase}")');
    // The two reason-attribution axes are registered in the egress allow-list so
    // they fail closed — an off-vocabulary or [Filtered] value never reaches a tag.
    expect(telemetrySource).toContain(
      '"runner_fatal_source" => Some(matches!(value, "stderr" | "node_report" | "none"))',
    );
    expect(telemetrySource).toContain('"runner_report_read" => Some(matches!(');
  });
});

// ---------------------------------------------------------------------------
// Two-direction culprit simulator (faithful mirror of the Rust builder)
// ---------------------------------------------------------------------------

type Tags = Record<string, string>;

const NAMED_BINARIES = new Set([
  'node_exe',
  'npx_cmd',
  'cmd_exe',
  'hq_sync_menubar_exe',
  'ntdll_dll',
  'kernelbase_dll',
  'ucrtbase_dll',
  'msvcrt_dll',
]);
const EXIT_CLASSES = new Set([
  'console_control',
  'session_terminate',
  'indeterminate_status',
  'fault',
  'ordinary',
]);
const FATAL_CLASSES = new Set([
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

function namedBinary(value?: string): string | null {
  if (!value || value === 'unavailable' || value === 'other') return null;
  return NAMED_BINARIES.has(value) ? value : null;
}

function isStatusHex(value?: string): boolean {
  return !!value && /^0x[0-9A-F]{8}$/.test(value);
}

function exitDetail(cls?: string, status?: string, fatal?: string): string | null {
  const fatalPhrase = () =>
    fatal && FATAL_CLASSES.has(fatal) && fatal !== 'none' ? fatal.replace(/_/g, ' ') : null;
  if (!cls || !EXIT_CLASSES.has(cls)) return fatalPhrase();
  const hex = isStatusHex(status) ? status : undefined;
  switch (cls) {
    case 'fault': {
      // A Windows fault now also names the reason when a runner fatal class is
      // known (reachable via the crash-surviving Node report on Windows). Byte-
      // identical when the class is `none`/off-vocabulary (HQ-DESKTOP-5W/5X).
      const base = hex ? `windows fault ${hex}` : 'windows fault';
      const phrase = fatalPhrase();
      return phrase ? `${base} / ${phrase}` : base;
    }
    case 'session_terminate':
      return 'windows session terminate';
    case 'console_control':
      return 'windows console control';
    case 'indeterminate_status':
      return 'windows indeterminate status';
    default:
      return fatalPhrase(); // ordinary — not a Windows-signalled shape
  }
}

/** Faithful mirror of `hq_telemetry::derive_sync_child_exit_culprit`. */
function deriveCulprit(tags: Tags): string | null {
  const t = (key: string): string | undefined => tags[key];
  let seam: string;
  if (t('sync_route') === 'watcher') seam = 'watcher';
  else if (t('sync_route') === 'manual') seam = 'runner';
  else return null;
  // Exit-specific discriminator: BOTH seams set runner_fatal_class; a non-exit
  // capture (the supervisor memory-preempt) with sync_route=watcher does not.
  if (t('runner_fatal_class') === undefined) return null;

  let prefix = `sync/${seam}`;
  const phase = t('runner_phase');
  if (seam === 'runner' && phase && ['scan', 'push', 'pull'].includes(phase)) {
    prefix += ` ${phase}`;
  }

  // Bound provenance -> the record's faulting image (or nothing if unnamed); a
  // bound-but-unnamed image is NEVER replaced by a tree candidate. Only a
  // non-binding provenance falls back to the job-tree culprit CANDIDATE.
  let binary: string | null = null;
  if (['pid_matched', 'window_only'].includes(t('watcher_fault_provenance') ?? '')) {
    binary = namedBinary(t('watcher_fault_faulting_image'));
  } else {
    const candidate = namedBinary(t('watcher_fault_job_culprit_candidate'));
    if (candidate && t('watcher_fault_job_image_provenance') === 'job_tree_observed') {
      binary = candidate;
    }
  }

  const detail = exitDetail(t('windows_exit_class'), t('windows_exit_status'), t('runner_fatal_class'));
  if (binary && detail) return `${prefix}: ${binary} (${detail})`;
  if (binary) return `${prefix}: ${binary}`;
  if (detail) return `${prefix}: ${detail}`;
  return prefix;
}

/** Pre-fix: a message capture ships an EMPTY culprit (no exception to derive one
 * from). Post-fix: before_send projects one from the tags. */
function culpritUnderPolicy(tags: Tags, policy: 'pre-fix' | 'post-fix'): string {
  return policy === 'pre-fix' ? '' : deriveCulprit(tags) ?? '';
}

// The observed HQ-DESKTOP-5W watcher-fault tag set (culprit='' on the live issue).
const WATCHER_5W: Tags = {
  sync_route: 'watcher',
  windows_exit_class: 'fault',
  windows_exit_status: '0xC0000409',
  windows_fault_symbol: 'STATUS_STACK_BUFFER_OVERRUN',
  watcher_fault_provenance: 'rejected_out_of_window',
  watcher_fault_faulting_image: 'unavailable',
  watcher_fault_job_culprit_candidate: 'node_exe',
  watcher_fault_job_image_provenance: 'job_tree_observed',
  runner_fatal_class: 'none',
};

// The observed HQ-DESKTOP-5X manual session-terminate tag set (culprit='').
const MANUAL_5X: Tags = {
  sync_route: 'manual',
  runner_phase: 'push',
  windows_exit_class: 'session_terminate',
  windows_exit_status: '0x40010004',
  sync_termination_reason: 'uncancelled',
  runner_fatal_class: 'none',
};

const CULPRIT_SAFE = /^[A-Za-z0-9 _/():]+$/;

describe('sync exit culprit — envelope simulator (both directions)', () => {
  it('pre-fix renders an empty culprit for both observed envelopes', () => {
    expect(culpritUnderPolicy(WATCHER_5W, 'pre-fix')).toBe('');
    expect(culpritUnderPolicy(MANUAL_5X, 'pre-fix')).toBe('');
  });

  it('post-fix names the seam + candidate + fault for HQ-DESKTOP-5W', () => {
    expect(culpritUnderPolicy(WATCHER_5W, 'post-fix')).toBe(
      'sync/watcher: node_exe (windows fault 0xC0000409)',
    );
  });

  it('post-fix names the seam + phase + shape for HQ-DESKTOP-5X', () => {
    expect(culpritUnderPolicy(MANUAL_5X, 'post-fix')).toBe(
      'sync/runner push: windows session terminate',
    );
  });

  it('post-fix names the report-derived reason alongside the fault on BOTH routes', () => {
    // HQ-DESKTOP-5W watcher fault whose reason the crash-surviving Node report
    // recovered (runner_fatal_class now populated where stderr was silent).
    const watcherWithReason: Tags = { ...WATCHER_5W, runner_fatal_class: 'heap_oom' };
    expect(culpritUnderPolicy(watcherWithReason, 'post-fix')).toBe(
      'sync/watcher: node_exe (windows fault 0xC0000409 / heap oom)',
    );
    // A manual-route Windows fault (HQ-DESKTOP-5X shape) is pinned to the SAME
    // rendering — seam + phase + fault + reason — proving both routes render alike.
    const manualFaultWithReason: Tags = {
      sync_route: 'manual',
      runner_phase: 'push',
      windows_exit_class: 'fault',
      windows_exit_status: '0xC0000409',
      runner_fatal_class: 'heap_oom',
    };
    expect(culpritUnderPolicy(manualFaultWithReason, 'post-fix')).toBe(
      'sync/runner push: windows fault 0xC0000409 / heap oom',
    );
  });

  it('a Windows fault with no known reason stays byte-identical to today (no regression)', () => {
    // runner_fatal_class=none → no "/ reason" suffix; the merged HQ-DESKTOP-5W/5X
    // rendering is preserved exactly.
    expect(culpritUnderPolicy(WATCHER_5W, 'post-fix')).toBe(
      'sync/watcher: node_exe (windows fault 0xC0000409)',
    );
  });

  it('both derived culprits are bounded and content-safe', () => {
    for (const tags of [WATCHER_5W, MANUAL_5X]) {
      const culprit = culpritUnderPolicy(tags, 'post-fix');
      expect(culprit.length).toBeLessThanOrEqual(180);
      expect(culprit).toMatch(CULPRIT_SAFE);
    }
  });

  it('names a bound image directly, never a non-bound one', () => {
    const bound = { ...WATCHER_5W, watcher_fault_provenance: 'pid_matched', watcher_fault_faulting_image: 'node_exe' };
    expect(deriveCulprit(bound)).toBe('sync/watcher: node_exe (windows fault 0xC0000409)');
    // The same image on a non-bound provenance is not promoted — the candidate is
    // ALSO absent here, so only the seam + shape stand.
    const unbound = {
      sync_route: 'watcher',
      runner_fatal_class: 'none',
      windows_exit_class: 'fault',
      windows_exit_status: '0xC0000409',
      watcher_fault_provenance: 'rejected_out_of_window',
      watcher_fault_faulting_image: 'node_exe',
    };
    expect(deriveCulprit(unbound)).toBe('sync/watcher: windows fault 0xC0000409');
  });

  it('never substitutes a tree candidate for a bound-but-unnamed image', () => {
    // WER bound a record (pid_matched) whose faulting image is not allow-listed
    // (`other`); the job-tree candidate (node_exe) must NOT be used — that would
    // falsely name Node. The image stays unnamed; only the seam + shape are named.
    const boundUnnamed: Tags = {
      sync_route: 'watcher',
      runner_fatal_class: 'none',
      windows_exit_class: 'fault',
      windows_exit_status: '0xC0000409',
      watcher_fault_provenance: 'pid_matched',
      watcher_fault_faulting_image: 'other',
      watcher_fault_job_culprit_candidate: 'node_exe',
      watcher_fault_job_image_provenance: 'job_tree_observed',
    };
    const culprit = deriveCulprit(boundUnnamed);
    expect(culprit).toBe('sync/watcher: windows fault 0xC0000409');
    expect(culprit).not.toContain('node_exe');
  });

  it('requires the child-exit discriminator (runner_fatal_class), excluding a memory-preempt', () => {
    // The supervisor memory-preempt capture carries sync_route=watcher but is not a
    // child exit and sets no runner_fatal_class — it must not be named.
    const preempt: Tags = {
      sync_route: 'watcher',
      rss_scope: 'tree',
      runner_heap_ceiling_source: 'declared_default',
    };
    expect(deriveCulprit(preempt)).toBeNull();
  });

  it('refuses poisoned tag values — a path, machine name, or junk status never leaks', () => {
    const poisoned: Tags = {
      sync_route: 'watcher',
      runner_fatal_class: 'none',
      windows_exit_class: 'fault',
      windows_exit_status: '0xC0000409',
      watcher_fault_provenance: 'pid_matched',
      watcher_fault_faulting_image: 'C:/Users/Ada/node.exe',
      watcher_fault_job_culprit_candidate: 'DESKTOP-53H1N93',
      watcher_fault_job_image_provenance: 'job_tree_observed',
      runner_phase: 'acme_corp_internal',
    };
    const culprit = deriveCulprit(poisoned);
    expect(culprit).toBe('sync/watcher: windows fault 0xC0000409');
    for (const poison of ['Users', 'Ada', 'DESKTOP-53H1N93', 'acme_corp_internal']) {
      expect(culprit).not.toContain(poison);
    }
    // A junk status is dropped, leaving a bare "windows fault".
    expect(
      deriveCulprit({
        sync_route: 'watcher',
        runner_fatal_class: 'none',
        windows_exit_class: 'fault',
        windows_exit_status: '0x/etc/passwd',
      }),
    ).toBe('sync/watcher: windows fault');
  });

  it('leaves a non-sync event unnamed in both directions', () => {
    const unrelated: Tags = { runner_error_http: 'http_500:1' };
    expect(deriveCulprit(unrelated)).toBeNull();
    expect(culpritUnderPolicy(unrelated, 'pre-fix')).toBe('');
    expect(culpritUnderPolicy(unrelated, 'post-fix')).toBe('');
  });
});
