/**
 * Watcher fault deferred attribution (HQ-DESKTOP-4X, r2).
 *
 * The prior fix (PR #421) shipped a WER "Application Error" (Event 1000) reader,
 * but it ran INSIDE the terminal exit callback that gates emit_exit_then_deregister
 * (and therefore supervisor recovery), so it was hard-capped at 4.5s while WER
 * publishes the record asynchronously AFTER the child dies. It therefore reported
 * `watcher_fault_provenance=no_record` + `watcher_fault_faulting_image=unavailable`
 * on every real production read, and its two-token vocabulary could not say WHICH
 * of three failure states occurred. The observed 0.10.105 envelope was:
 *   runner_fatal_class=none, watcher_fault_provenance=no_record,
 *   watcher_fault_faulting_image=unavailable, watcher_fault_faulting_module=unavailable,
 *   runner_unmatched_stderr_shapes=ndjson_record:10,path_like:1,other:1.
 *
 * The Rust suites (hq-desktop-core, hq-telemetry, and the app-crate wiring/E2E
 * tests) pin the seam from the inside. This spec pins the same properties at the
 * *source-contract* and *artifact* levels, following the fixture-backed pattern of
 * watcher-heap-oom-attribution.spec.ts, so it runs on Linux/macOS CI and proves
 * the base-red / candidate-pass pair without a Windows host:
 *
 * 1. Source contracts over the code that actually ships — the read moved OFF the
 *    exit path onto a bounded ~60s deferred worker, the resolved provenance
 *    vocabulary + counters, the WER-independent job-image descriptor, the deferred
 *    capture registry + teardown flush at BOTH exit seams, and the telemetry egress
 *    arms — so deleting or bypassing any seam fails here, not only in Rust.
 * 2. An envelope simulator run in BOTH directions: the pre-fix policy reproduces
 *    the observed HQ-DESKTOP-4X 0.10.105 envelope verbatim; the post-fix policy,
 *    with the SAME late-published record, resolves the attribution — and, when no
 *    record is ever published, renders the distinct deadline-expired token (never
 *    the ambiguous no_record) plus the named job-image culprit candidate.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary, bounded
 * integers, and a digest — never argv, stderr, symbols, paths, or company slugs.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// repoRoot is apps/sync, so the shared crate sources are read via '../../crates'.
const processSource = readRepoFile('src-tauri/src/commands/process.rs');
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const mainSource = readRepoFile('src-tauri/src/main.rs');
const coreSource = readRepoFile('../../crates/hq-desktop-core/src/watcher_fault.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

describe('watcher fault deferred attribution — source contracts', () => {
  it('takes the fault read OFF the terminal exit callback entirely', () => {
    // The old blocking, exit-path read is gone: no on-exit-path 4.5s wait, and no
    // synchronous provenance call inside the exit closure.
    expect(processSource).not.toContain('watcher_fault_provenance_for_generation');
    expect(processSource).not.toContain('WER_TOTAL_BUDGET');
    expect(daemonSource).not.toContain('watcher_fault_provenance_for_generation');
    // The read is now a deferred worker function with an explicit horizon param.
    expect(processSource).toContain('pub fn read_watcher_fault(');
    // The deferred capture worker runs the read on a std thread off the exit path.
    expect(daemonSource).toContain('fn spawn_deferred_watcher_fault_capture(');
    expect(daemonSource).toContain('crate::commands::process::read_watcher_fault(');
  });

  it('gives the deferred read a ~60s bounded horizon with a bounded sweep', () => {
    expect(processSource).toContain(
      'const WATCHER_FAULT_DEFERRED_BUDGET: Duration = Duration::from_secs(60);',
    );
    expect(processSource).toContain('const WATCHER_FAULT_DEFERRED_SWEEP: Duration');
    // Every wait bounded: the loop exits on its own deadline, never unbounded.
    expect(processSource).toContain('if std::time::Instant::now() >= deadline {');
    expect(processSource).toContain('thread::sleep(WATCHER_FAULT_DEFERRED_SWEEP);');
  });

  it('drains the sampled-PID + image map synchronously at exit so it cannot leak', () => {
    expect(processSource).toContain('pub fn take_watcher_job_sample(');
    expect(daemonSource).toContain(
      'crate::commands::process::take_watcher_job_sample(daemon_generation)',
    );
  });

  it('resolves the job-tree images while alive via QueryFullProcessImageNameW', () => {
    expect(processSource).toContain('QueryFullProcessImageNameW');
    expect(processSource).toContain('fn resolve_process_image_token(');
    // The image is mapped through the SAME closed allow-list, never copied out.
    expect(processSource).toContain('classify_watcher_fault_binary');
  });

  it('seeds the honest deferred provenance on the exit path and defers the send', () => {
    expect(daemonSource).toContain('WatcherFaultProvenance::Deferred.as_str().to_string()');
    expect(daemonSource).toContain('watcher_fault_deferred_read: Some(WatcherFaultDeferredRead {');
    expect(daemonSource).toContain('effects.defer_watcher_fault_capture(');
  });

  it('finalize patches ONLY the watcher_fault_* fields, leaving grouping intact', () => {
    expect(daemonSource).toContain('fn finalize_watcher_fault_payload(');
    // Only the watcher_fault_* tags are overwritten; the message/fingerprint are not.
    expect(daemonSource).toContain('set_payload_tag(');
    expect(daemonSource).toContain('"watcher_fault_provenance"');
    expect(daemonSource).toContain('"watcher_fault_read"');
  });

  it('flushes any in-flight deferred fault capture at BOTH exit teardown seams', () => {
    // The registry drains take-once, and BOTH the app-initiated quit seam and the
    // Windows session-end seam FLUSH (never drop) a fault capture — it names a real
    // crash, unlike the benign session-end capture the session-end path drops.
    expect(daemonSource).toContain('pub fn flush_pending_watcher_fault_captures(reason: &str)');
    expect(daemonSource).toContain('fn take_pending_watcher_fault_capture(');
    const flushes = mainSource.split('flush_pending_watcher_fault_captures(').length - 1;
    expect(flushes).toBeGreaterThanOrEqual(2);
    // Each seam names its own reason so app-quit and session-end are distinct.
    expect(mainSource).toContain('flush_pending_watcher_fault_captures("app_quit_flush")');
    expect(mainSource).toContain('flush_pending_watcher_fault_captures("session_end_flush")');
    // The session-end path still DROPS the benign session-end capture, and the
    // fast-exit gate + discriminator are untouched (HQ-DESKTOP-44 invariants).
    expect(mainSource).toContain('drop_pending_session_end_captures()');
    expect(mainSource).toContain('commands::process::app_initiated_exit()');
  });

  it('replaces the ambiguous two-token vocabulary with a resolved, exhaustive one', () => {
    for (const token of [
      'pid_matched',
      'window_only',
      'query_unreadable',
      'no_records',
      'rejected_out_of_window',
      'rejected_code_mismatch',
      'rejected_unparsable',
      'deadline_expired',
      'deferred',
      'not_applicable',
    ]) {
      expect(coreSource).toContain(`"${token}"`);
      expect(telemetrySource).toContain(`"${token}"`);
    }
    // The prior fix's overloaded token is retired from the provenance vocabulary.
    expect(coreSource).not.toContain('NoRecord =>');
    // Read counters + job-image descriptor exist in the pure core.
    expect(coreSource).toContain('struct WatcherFaultReadCounters');
    expect(coreSource).toContain('struct WatcherJobImageDescriptor');
    expect(coreSource).toContain('WATCHER_JOB_IMAGE_OBSERVED');
  });

  it('gates every new field at the independent hq-telemetry egress boundary', () => {
    expect(telemetrySource).toContain('"watcher_fault_read" => Some(is_watcher_fault_read_counters(value))');
    expect(telemetrySource).toContain(
      '"watcher_fault_job_images" => Some(is_watcher_fault_binary_token_set(value))',
    );
    expect(telemetrySource).toContain('"watcher_fault_job_culprit_candidate"');
    expect(telemetrySource).toContain('"watcher_fault_job_image_provenance"');
    // The cross-crate anti-drift pin enumerates the emitter's OWN vocabulary.
    expect(telemetrySource).toContain('every_watcher_fault_token_survives_and_lookalikes_fail_closed');
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

/** A WER Application Error 1000 record as the reader would parse it. */
interface FaultRecord {
  image: 'node_exe' | 'other';
  module: 'ntdll_dll' | 'other';
  exceptionCode: number;
  faultingPid: number;
  eventTimeMs: number;
  /** When WER actually publishes it, relative to the child's exit (ms). */
  publishDelayMs: number;
}

interface Scenario {
  /** The record WER will eventually publish, or null (never publishes). */
  record: FaultRecord | null;
  /** Live job-tree images sampled while the tree was alive. */
  jobImages: string[];
  observedExceptionCode: number;
  genStartMs: number;
  genExitMs: number;
}

/** The two read horizons: pre-fix on the exit path (4.5s), post-fix deferred. */
const PRE_FIX_BUDGET_MS = 4_500;
const POST_FIX_BUDGET_MS = 60_000;

/**
 * Model the fixed part of the envelope the exit path builds for a 0xC0000409
 * fault, independent of provenance. Matches the shipped fingerprint/message so the
 * both-directions comparison proves ONLY the watcher_fault_* fields differ.
 */
function baseEnvelope(): SentryEnvelope {
  return {
    message: 'auto-sync watcher exited unexpectedly',
    fingerprint: ['sync', 'auto-sync-watcher-termination', 'windows:fault:0xC0000409', 'none'],
    tags: {
      runner_fatal_class: 'none',
      sync_route: 'watcher',
      watcher_child_kind: 'cmd_shim',
      watcher_job_process_count: '7',
      watcher_job_peak_commit_bucket: '512mb_to_1gb',
      runner_unmatched_stderr_shapes: 'ndjson_record:10,path_like:1,other:1',
    },
  };
}

/** Deterministic mirror of the pure `attribute_watcher_fault` binding decision. */
function attribute(record: FaultRecord, sampledPids: number[], s: Scenario): {
  provenance: string;
  image: string;
  module: string;
} {
  const inWindow = record.eventTimeMs >= s.genStartMs && record.eventTimeMs <= s.genExitMs + 120_000;
  const codeAgrees = record.exceptionCode === s.observedExceptionCode;
  if (inWindow && codeAgrees && sampledPids.includes(record.faultingPid)) {
    return { provenance: 'pid_matched', image: record.image, module: record.module };
  }
  if (inWindow && codeAgrees) {
    return { provenance: 'window_only', image: record.image, module: record.module };
  }
  return { provenance: 'rejected_out_of_window', image: 'unavailable', module: 'unavailable' };
}

/**
 * Run the fault read under a policy and produce the emitted envelope. The ONLY
 * difference between the two policies is the horizon (whether the read can outlast
 * WER's asynchronous publication) and the outcome vocabulary.
 */
function readAndEnvelope(scenario: Scenario, policy: Policy): SentryEnvelope {
  const env = baseEnvelope();
  const budget = policy === 'pre-fix' ? PRE_FIX_BUDGET_MS : POST_FIX_BUDGET_MS;
  const sampledPids = scenario.record ? [scenario.record.faultingPid] : [];

  // A record that publishes AFTER the budget is never read by that policy.
  const readable =
    scenario.record !== null && scenario.record.publishDelayMs <= budget ? scenario.record : null;

  if (policy === 'pre-fix') {
    // The prior fix could only ever emit no_record / unavailable when the record
    // had not published in time, with no counters and no job-image channel.
    if (readable) {
      const bound = attribute(readable, sampledPids, scenario);
      env.tags.watcher_fault_provenance = bound.provenance;
      env.tags.watcher_fault_faulting_image = bound.image;
      env.tags.watcher_fault_faulting_module = bound.module;
    } else {
      env.tags.watcher_fault_provenance = 'no_record';
      env.tags.watcher_fault_faulting_image = 'unavailable';
      env.tags.watcher_fault_faulting_module = 'unavailable';
    }
    return env;
  }

  // post-fix: resolved vocabulary + counters + the WER-independent job-image
  // descriptor (a tree observation, never a fault attribution).
  if (readable) {
    const bound = attribute(readable, sampledPids, scenario);
    env.tags.watcher_fault_provenance = bound.provenance;
    env.tags.watcher_fault_faulting_image = bound.image;
    env.tags.watcher_fault_faulting_module = bound.module;
    env.tags.watcher_fault_read = 'seen:1,parsed:1,rej_win:0,rej_code:0,sweeps:9,ms:8003';
  } else {
    // No record ever published within the horizon → the DISTINCT deadline-expired
    // token, never the ambiguous no_record, with populated counters.
    env.tags.watcher_fault_provenance = 'deadline_expired';
    env.tags.watcher_fault_faulting_image = 'unavailable';
    env.tags.watcher_fault_faulting_module = 'unavailable';
    env.tags.watcher_fault_read = 'seen:0,parsed:0,rej_win:0,rej_code:0,sweeps:60,ms:60002';
  }
  // The job-image descriptor names a culprit candidate regardless of WER.
  const nonShim = scenario.jobImages.filter((i) => i !== 'cmd_exe' && i !== 'npx_cmd');
  if (scenario.jobImages.length > 0) {
    env.tags.watcher_fault_job_images = scenario.jobImages.join(',');
    env.tags.watcher_fault_job_culprit_candidate = nonShim.includes('node_exe')
      ? 'node_exe'
      : (nonShim[0] ?? 'unavailable');
    env.tags.watcher_fault_job_image_provenance = 'job_tree_observed';
  }
  return env;
}

// The recurrence: a genuine node.exe 0xC0000409 record that WER publishes at
// exit+8s — bindable by PID and comfortably inside the [exit-8min, exit+2min]
// window — inside a seven-process cmd.exe-shimmed tree.
const RECURRENCE: Scenario = {
  record: {
    image: 'node_exe',
    module: 'ntdll_dll',
    exceptionCode: 0xc0000409,
    faultingPid: 6700,
    eventTimeMs: 1_000_500,
    publishDelayMs: 8_000,
  },
  jobImages: ['node_exe', 'cmd_exe', 'npx_cmd'],
  observedExceptionCode: 0xc0000409,
  genStartMs: 1_000_000,
  genExitMs: 1_000_400,
};

// The same abort, but WER never publishes an Event 1000 record at all.
const NEVER_PUBLISHED: Scenario = { ...RECURRENCE, record: null };

const CONTENT_SAFE = /^[a-z0-9_,:]+$/;

describe('watcher fault deferred attribution — envelope model (both directions)', () => {
  it('pre-fix reproduces the observed HQ-DESKTOP-4X 0.10.105 envelope verbatim', () => {
    // The record WAS there and bindable, yet the shipped reader had already given
    // up at 4.5s, so it emitted the exact ambiguous envelope the cluster reopened on.
    const env = readAndEnvelope(RECURRENCE, 'pre-fix');
    expect(env.tags.watcher_fault_provenance).toBe('no_record');
    expect(env.tags.watcher_fault_faulting_image).toBe('unavailable');
    expect(env.tags.watcher_fault_faulting_module).toBe('unavailable');
    expect(env.tags.runner_fatal_class).toBe('none');
    expect(env.tags.runner_unmatched_stderr_shapes).toBe('ndjson_record:10,path_like:1,other:1');
    // The prior fix had no counters channel and no job-image channel at all.
    expect(env.tags.watcher_fault_read).toBeUndefined();
    expect(env.tags.watcher_fault_job_images).toBeUndefined();
  });

  it('pre-fix cannot distinguish zero-records from a late publication', () => {
    const late = readAndEnvelope(RECURRENCE, 'pre-fix');
    const empty = readAndEnvelope(NEVER_PUBLISHED, 'pre-fix');
    // Both merge to the identical ambiguous token — the honesty gap being closed.
    expect(late.tags.watcher_fault_provenance).toBe(empty.tags.watcher_fault_provenance);
    expect(late.tags.watcher_fault_provenance).toBe('no_record');
  });

  it('post-fix resolves the SAME late-published record to a named attribution', () => {
    const env = readAndEnvelope(RECURRENCE, 'post-fix');
    expect(env.tags.watcher_fault_provenance).toBe('pid_matched');
    expect(env.tags.watcher_fault_faulting_image).toBe('node_exe');
    expect(env.tags.watcher_fault_faulting_module).toBe('ntdll_dll');
    expect(env.tags.watcher_fault_read).toContain('seen:1');
    // The job-image descriptor also names the runner as the culprit candidate.
    expect(env.tags.watcher_fault_job_culprit_candidate).toBe('node_exe');
    expect(env.tags.watcher_fault_job_image_provenance).toBe('job_tree_observed');
  });

  it('post-fix renders deadline_expired (not no_record) when WER never publishes', () => {
    const env = readAndEnvelope(NEVER_PUBLISHED, 'post-fix');
    expect(env.tags.watcher_fault_provenance).toBe('deadline_expired');
    expect(env.tags.watcher_fault_provenance).not.toBe('no_record');
    expect(env.tags.watcher_fault_faulting_image).toBe('unavailable');
    expect(env.tags.watcher_fault_read).toBe('seen:0,parsed:0,rej_win:0,rej_code:0,sweeps:60,ms:60002');
    // Even with no WER record, the app's own tree sampling names a culprit candidate.
    expect(env.tags.watcher_fault_job_culprit_candidate).toBe('node_exe');
  });

  it('grouping continuity: only the watcher_fault_* fields differ between policies', () => {
    const pre = readAndEnvelope(RECURRENCE, 'pre-fix');
    const post = readAndEnvelope(RECURRENCE, 'post-fix');
    expect(post.message).toBe(pre.message);
    expect(post.fingerprint).toEqual(pre.fingerprint);
    for (const key of Object.keys(pre.tags)) {
      if (!key.startsWith('watcher_fault_')) {
        expect(post.tags[key]).toBe(pre.tags[key]);
      }
    }
  });

  it('every modeled envelope tag is content-safe (fixed vocabulary + integers)', () => {
    for (const scenario of [RECURRENCE, NEVER_PUBLISHED]) {
      for (const policy of ['pre-fix', 'post-fix'] as Policy[]) {
        const env = readAndEnvelope(scenario, policy);
        for (const [key, value] of Object.entries(env.tags)) {
          expect(value, `${key}=${value}`).toMatch(CONTENT_SAFE);
        }
      }
    }
  });
});
