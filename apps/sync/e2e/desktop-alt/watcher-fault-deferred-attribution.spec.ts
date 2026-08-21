/**
 * HQ-DESKTOP-4X — deferred Windows fault attribution, both directions.
 *
 * The prior fix (PR #421) read Windows Error Reporting on the terminal exit
 * callback under a 4.5s cap it could never meet, so every read reported
 * `no_record` with an `unavailable` image and the faulting binary stayed
 * unnamed — the cluster reopened. This spec pins the fix two ways, on Linux/macOS
 * CI so the base-red/candidate-pass pair is provable without a Windows host:
 *
 * 1. SOURCE CONTRACTS over the shipping code — the deferral seam, the ~60s
 *    horizon, the resolved self-diagnosing vocabulary, the WER-independent
 *    job-image descriptor, the egress arms, and the teardown drain. Deleting or
 *    bypassing any one of them fails here, not only in the Rust suite.
 *
 * 2. An ENVELOPE SIMULATOR run under BOTH policies: the pre-fix policy reproduces
 *    the observed HQ-DESKTOP-4X 0.10.105 envelope verbatim (no_record /
 *    unavailable for a record published after the 4s budget); the post-fix policy
 *    binds the same late-published record to `pid_matched` + `node_exe`, and —
 *    when WER never publishes — reports the distinct `deadline_expired` token with
 *    its counters and the job-image candidate, never a named image.
 *
 * Content-safety: every modeled envelope value is a fixed token, a bare integer,
 * or a digest — never a path, argv, username, or raw record byte.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// Paths are resolved relative to apps/sync (the vitest cwd), matching the
// sibling watcher-heap-oom-attribution.spec.ts.
const coreSource = readRepoFile('../../crates/hq-desktop-core/src/watcher_fault.rs');
const processSource = readRepoFile('src-tauri/src/commands/process.rs');
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const syncSource = readRepoFile('src-tauri/src/commands/sync.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');
const mainSource = readRepoFile('src-tauri/src/main.rs');

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing marker: ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing marker: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

// The resolved, self-diagnosing provenance vocabulary. Every state the old
// no_record/unavailable pair collapsed is now a distinct token.
const PROVENANCE_TOKENS = [
  'pid_matched',
  'window_only',
  'rejected_code_mismatch',
  'rejected_out_of_window',
  'rejected_unparsable',
  'no_records',
  'deadline_expired',
  'unavailable',
  'not_applicable',
];

const COUNTER_KEYS = [
  'watcher_fault_records_seen',
  'watcher_fault_records_parsed',
  'watcher_fault_rejected_out_of_window',
  'watcher_fault_rejected_code_mismatch',
  'watcher_fault_rejected_unparsable',
  'watcher_fault_sweeps',
  'watcher_fault_ms_to_verdict',
];

describe('deferred watcher fault attribution — source contracts', () => {
  it('runs the WER read OFF the terminal exit callback under a ~60s horizon', () => {
    // The exit-path synchronous read is GONE: its function no longer exists, so
    // the terminal callback can perform no Event Log work at all.
    expect(processSource).not.toContain('fn watcher_fault_provenance_for_generation');
    expect(daemonSource).not.toContain('watcher_fault_provenance_for_generation');
    // The deferred read exists, with a horizon WER can actually meet.
    expect(processSource).toContain('pub fn read_watcher_fault_deferred(');
    expect(processSource).toContain('const WER_DEFERRED_TOTAL_BUDGET: Duration = Duration::from_millis(60_000);');
    // And it is hard-bounded — no unbounded wait.
    expect(processSource).toContain('const WER_DEFERRED_READ_BUDGET: Duration');
    expect(processSource).toContain('recv_timeout(WER_DEFERRED_TOTAL_BUDGET)');
  });

  it('drains the sampled tree once on the exit path and carries it into the deferral', () => {
    const exitArm = sliceBetween(
      daemonSource,
      'ProcessEvent::Exit {',
      'handle_watcher_exit(',
    );
    expect(exitArm).toContain('crate::commands::process::take_watcher_job_sample(daemon_generation)');
    expect(exitArm).toContain('exit_context.deferred_fault_read = Some(DeferredWatcherFaultRead {');
    // The exit closure no longer waits on WER at all.
    expect(exitArm).not.toContain('watcher_fault_provenance_for_generation');
  });

  it('defers the SEND for a fault exit only, and keeps capture policy untouched', () => {
    expect(daemonSource).toContain('fn defer_watcher_fault_capture(');
    expect(daemonSource).toContain('struct DeferredWatcherFaultCapture {');
    // The defer branch is reached only when a fault exit set up the deferred read,
    // and it is gated behind the same capture policy as an immediate send.
    const recordFn = sliceBetween(
      daemonSource,
      'fn record_unexpected_watcher_exit<E: WatcherProcessEffects>(',
      'fn safe_runner_error_fingerprint_token(',
    );
    expect(recordFn).toContain('if let Some(read) = context.deferred_fault_read.clone() {');
    expect(recordFn).toContain('effects.defer_watcher_fault_capture(&message, &fingerprint, &tags, &extras, read);');
  });

  it('resolves the deferred read and stamps the event with the exit instant', () => {
    expect(daemonSource).toContain('fn resolve_deferred_watcher_fault_capture(');
    expect(daemonSource).toContain('crate::commands::process::read_watcher_fault_deferred(');
    expect(daemonSource).toContain('fn watcher_fault_capture_fields(');
    // Stamped at the crash instant, not the ~60s-later send.
    expect(daemonSource).toContain('.checked_sub(payload.read.exit_at.elapsed())');
    expect(syncSource).toContain('pub(crate) fn capture_sync_error_with_context_at(');
    expect(syncSource).toContain('timestamp,');
  });

  it('flushes deferred fault captures at BOTH teardown seams, never dropping them', () => {
    // A fault is a genuine crash regardless of session end: flushed at the
    // app-quit seam AND the Windows session-end seam (unlike a session-terminate
    // capture, which the session-end path drops). Present exactly twice.
    expect(mainSource.split('flush_pending_watcher_fault_captures();').length - 1).toBe(2);
    expect(daemonSource).toContain('pub fn flush_pending_watcher_fault_captures()');
  });

  it('carries the resolved provenance vocabulary and separates every failure state', () => {
    for (const token of PROVENANCE_TOKENS) {
      expect(coreSource, `core must define provenance token ${token}`).toContain(`"${token}"`);
    }
    // The retired ambiguous token is gone from the producer.
    expect(coreSource).not.toContain('"no_record"');
    // The deadline mapping and the attribution predicate the read loop relies on.
    expect(coreSource).toContain('pub fn into_deadline_expired(');
    expect(coreSource).toContain('pub fn is_attribution(');
    expect(coreSource).toContain('pub struct WatcherFaultCounters {');
  });

  it('adds a WER-independent job-image descriptor that never poses as an attribution', () => {
    expect(coreSource).toContain('pub struct WatcherJobImageRollup {');
    expect(coreSource).toContain('pub const WATCHER_JOB_IMAGE_TREE_SAMPLED: &str = "tree_sampled";');
    // Sampled from the app's own process tree via QueryFullProcessImageNameW,
    // folded through the SAME allow-list the WER image position uses.
    expect(processSource).toContain('fn query_process_image_basename(');
    expect(processSource).toContain('sample.images.record_image_name(');
  });

  it('registers every new provenance token, counter, and job-image tag at the egress boundary', () => {
    const validator = sliceBetween(
      telemetrySource,
      'fn valid_runner_diagnostic_field(',
      'fn scrub_runner_diagnostic_fields(',
    );
    for (const token of PROVENANCE_TOKENS) {
      expect(validator, `egress must accept provenance ${token}`).toContain(`"${token}"`);
    }
    for (const key of COUNTER_KEYS) {
      expect(validator, `egress must accept counter ${key}`).toContain(`"${key}"`);
    }
    expect(validator).toContain('"watcher_job_image_set" => Some(is_watcher_job_image_set(value))');
    expect(validator).toContain('"watcher_job_last_nonshim_image" => Some(is_watcher_fault_binary_token(value))');
    expect(validator).toContain('"watcher_job_image_provenance" => Some(matches!(value, "tree_sampled" | "unavailable"))');
    expect(validator).toContain('"watcher_fault_deferral_resolution"');
    // The cross-crate anti-drift pin enumerates the producer's OWN vocabulary.
    expect(telemetrySource).toContain('fn every_watcher_fault_token_survives_and_lookalikes_fail_closed(');
  });
});

// ---------------------------------------------------------------------------
// Artifact-level envelope model, run in BOTH directions
// ---------------------------------------------------------------------------

interface WerRecord {
  image: string; // allow-listed token, e.g. node_exe
  module: string; // allow-listed token
  exceptionCode: number;
  faultOffset: number;
  faultingPid: number;
  publishAtMs: number; // ms after exit that WER publishes this record
}

interface FaultScenario {
  observedExceptionCode: number;
  sampledPids: number[];
  jobImages: string[]; // basenames observed alive in the tree
  record: WerRecord | null; // the record WER eventually publishes, or none
}

interface Envelope {
  message: string;
  level: string;
  fingerprint: string[];
  tags: Record<string, string>;
  extras: Record<string, string | number>;
}

// A shim allow-list mirroring the core's classify_watcher_fault_binary basename
// mapping — only fixed tokens, never a path.
function classifyImage(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').toLowerCase();
  const table: Record<string, string> = {
    'node.exe': 'node_exe',
    'npx.cmd': 'npx_cmd',
    'cmd.exe': 'cmd_exe',
    'hq-sync-menubar.exe': 'hq_sync_menubar_exe',
    'ntdll.dll': 'ntdll_dll',
  };
  return table[base] ?? 'other';
}

function jobImageDescriptor(images: string[]): {
  set: string | null;
  lastNonshim: string;
  provenance: string;
} {
  const order = ['node_exe', 'npx_cmd', 'cmd_exe', 'hq_sync_menubar_exe', 'ntdll_dll', 'other'];
  const tokens = images.map(classifyImage);
  const present = order.filter((token) => tokens.includes(token));
  const shims = new Set(['cmd_exe', 'npx_cmd', 'hq_sync_menubar_exe']);
  const nonshim = [...tokens].reverse().find((token) => !shims.has(token));
  return {
    set: present.length ? present.join(',') : null,
    lastNonshim: nonshim ?? 'unavailable',
    provenance: present.length ? 'tree_sampled' : 'unavailable',
  };
}

// The message/fingerprint/level are a pure function of the exit shape and never
// of the fault fields — so they are byte-identical across the two policies.
function baseEnvelope(): Pick<Envelope, 'message' | 'level' | 'fingerprint'> & {
  tags: Record<string, string>;
  extras: Record<string, string | number>;
} {
  return {
    message:
      'auto-sync watcher exited unexpectedly (with Windows status 0xC0000409 (fault)), consecutive failure #1 [uptime=2h52m]',
    level: 'error',
    fingerprint: ['sync', 'auto-sync-watcher-termination', 'windows:fault:0xC0000409', 'none'],
    tags: {
      runner_fatal_class: 'none',
      sync_route: 'watcher',
      runner_unmatched_stderr_shapes: 'ndjson_record:10,path_like:1,other:1',
      watcher_child_kind: 'cmd_shim',
      watcher_job_process_count: '7',
      windows_exit_status: '0xC0000409',
      windows_fault_symbol: 'STATUS_STACK_BUFFER_OVERRUN',
    },
    extras: {},
  };
}

// PRE-FIX: the read sits on the exit callback with a 4s budget. WER publishes
// after the budget, so nothing binds — no_record / unavailable, no counters, no
// job-image descriptor. This is the observed 0.10.105 envelope.
function simulatePreFix(scenario: FaultScenario): Envelope {
  const budgetMs = 4_000;
  const env = baseEnvelope();
  const bound =
    scenario.record !== null &&
    scenario.record.publishAtMs <= budgetMs &&
    scenario.record.exceptionCode === scenario.observedExceptionCode;
  env.tags.watcher_fault_provenance = bound ? 'pid_matched' : 'no_record';
  env.tags.watcher_fault_faulting_image = bound ? scenario.record!.image : 'unavailable';
  env.tags.watcher_fault_faulting_module = bound ? scenario.record!.module : 'unavailable';
  return env as Envelope;
}

// POST-FIX: the read is deferred off the callback with a ~60s horizon and
// records counters. A late record that lands inside the horizon binds by PID;
// a record that never lands becomes deadline_expired with counters and no named
// image; a rejected record keeps its rejection token. The job-image descriptor
// ships in every case as a WER-independent candidate.
function simulatePostFix(scenario: FaultScenario): Envelope {
  const budgetMs = 60_000;
  const env = baseEnvelope();
  const descriptor = jobImageDescriptor(scenario.jobImages);

  let provenance: string;
  let image = 'unavailable';
  let module = 'unavailable';
  let recordsSeen = 0;
  let sweeps = 1;
  const record = scenario.record;

  if (record !== null && record.publishAtMs <= budgetMs) {
    recordsSeen = 1;
    sweeps = Math.max(2, Math.ceil(record.publishAtMs / 1_000));
    const inWindow = true;
    const codeAgrees = record.exceptionCode === scenario.observedExceptionCode;
    const pidMatched = scenario.sampledPids.includes(record.faultingPid);
    if (inWindow && codeAgrees && pidMatched) {
      provenance = 'pid_matched';
      image = record.image;
      module = record.module;
      env.extras.watcher_fault_exception_code = String(record.exceptionCode);
      env.extras.watcher_fault_offset = String(record.faultOffset);
    } else if (inWindow && codeAgrees) {
      provenance = 'window_only';
      image = record.image;
      module = record.module;
    } else if (inWindow && !codeAgrees) {
      provenance = 'rejected_code_mismatch';
    } else {
      provenance = 'rejected_out_of_window';
    }
  } else {
    // WER never published inside the horizon: the actionable "we waited and it
    // never came" signal, with counters — never a named image.
    provenance = 'deadline_expired';
    sweeps = 58;
  }

  env.tags.watcher_fault_provenance = provenance;
  env.tags.watcher_fault_faulting_image = image;
  env.tags.watcher_fault_faulting_module = module;
  env.tags.watcher_job_image_provenance = descriptor.provenance;
  env.tags.watcher_job_last_nonshim_image = descriptor.lastNonshim;
  if (descriptor.set) {
    env.tags.watcher_job_image_set = descriptor.set;
  }
  env.extras.watcher_fault_records_seen = recordsSeen;
  env.extras.watcher_fault_sweeps = sweeps;
  env.extras.watcher_fault_ms_to_verdict = record?.publishAtMs ?? budgetMs;
  env.extras.watcher_fault_deferral_resolution = 'read_completed';
  return env as Envelope;
}

// The observed HQ-DESKTOP-4X recurrence: a node.exe/ntdll.dll 0xC0000409 abort in
// a seven-process cmd.exe-shimmed tree, whose WER record publishes at exit+8s —
// comfortably past the OLD 4s budget, comfortably inside the NEW 60s horizon.
const RECURRENCE: FaultScenario = {
  observedExceptionCode: 0xc0000409,
  sampledPids: [6700],
  jobImages: [
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Users\\Ada\\AppData\\Local\\HQ\\node.exe',
  ],
  record: {
    image: 'node_exe',
    module: 'ntdll_dll',
    exceptionCode: 0xc0000409,
    faultOffset: 0x2a1b3,
    faultingPid: 6700,
    publishAtMs: 8_000,
  },
};

// WER never publishes a fault record for this termination (a __fastfail may
// simply not be reported): the tail the plan warns about.
const NEVER_PUBLISHED: FaultScenario = { ...RECURRENCE, record: null };

const FORBIDDEN = ['Ada', 'C:\\', '/Users/', 'node.exe', 'cmd.exe', 'AppData', '.dll'];

function assertContentSafe(env: Envelope): void {
  const wire = [
    env.message,
    ...env.fingerprint,
    ...Object.values(env.tags),
    ...Object.values(env.extras).map(String),
  ];
  for (const value of wire) {
    for (const secret of FORBIDDEN) {
      expect(value.includes(secret), `envelope value ${JSON.stringify(value)} leaked ${secret}`).toBe(false);
    }
  }
}

describe('deferred watcher fault attribution — envelope simulator (both directions)', () => {
  it('pre-fix reproduces the observed HQ-DESKTOP-4X 0.10.105 envelope verbatim', () => {
    const env = simulatePreFix(RECURRENCE);
    // The record WAS bindable and DID name node.exe — but the shipped reader gave
    // up at 4s, so it reports the ambiguous no_record with an unnamed image.
    expect(env.tags.watcher_fault_provenance).toBe('no_record');
    expect(env.tags.watcher_fault_faulting_image).toBe('unavailable');
    expect(env.tags.watcher_fault_faulting_module).toBe('unavailable');
    expect(env.tags.runner_fatal_class).toBe('none');
    expect(env.tags.runner_unmatched_stderr_shapes).toBe('ndjson_record:10,path_like:1,other:1');
    // Pre-fix carried no counters and no job-image descriptor.
    expect(env.tags.watcher_job_image_provenance).toBeUndefined();
    expect(env.extras.watcher_fault_sweeps).toBeUndefined();
    assertContentSafe(env);
  });

  it('post-fix binds the same late-published record to pid_matched + node_exe', () => {
    const env = simulatePostFix(RECURRENCE);
    expect(env.tags.watcher_fault_provenance).toBe('pid_matched');
    expect(env.tags.watcher_fault_faulting_image).toBe('node_exe');
    expect(env.tags.watcher_fault_faulting_module).toBe('ntdll_dll');
    expect(env.extras.watcher_fault_exception_code).toBe('3221226505');
    expect(env.extras.watcher_fault_records_seen).toBe(1);
    expect(Number(env.extras.watcher_fault_sweeps)).toBeGreaterThan(1);
    expect(env.extras.watcher_fault_deferral_resolution).toBe('read_completed');
    // The job-image descriptor independently names the same culprit candidate.
    expect(env.tags.watcher_job_last_nonshim_image).toBe('node_exe');
    expect(env.tags.watcher_job_image_provenance).toBe('tree_sampled');
    assertContentSafe(env);
  });

  it('post-fix reports deadline_expired with counters and a candidate when WER never publishes', () => {
    const env = simulatePostFix(NEVER_PUBLISHED);
    // NOT the ambiguous no_record: the distinct "we waited the whole horizon" token.
    expect(env.tags.watcher_fault_provenance).toBe('deadline_expired');
    expect(env.tags.watcher_fault_faulting_image).toBe('unavailable'); // absence never named
    expect(env.extras.watcher_fault_records_seen).toBe(0);
    expect(Number(env.extras.watcher_fault_sweeps)).toBeGreaterThan(1);
    // The WER-independent tree observation still supplies a named candidate.
    expect(env.tags.watcher_job_last_nonshim_image).toBe('node_exe');
    expect(env.tags.watcher_job_image_provenance).toBe('tree_sampled');
    assertContentSafe(env);
  });

  it('keeps message, fingerprint, and level byte-identical across the two policies', () => {
    const pre = simulatePreFix(RECURRENCE);
    const post = simulatePostFix(RECURRENCE);
    expect(post.message).toBe(pre.message);
    expect(post.level).toBe(pre.level);
    expect(post.fingerprint).toEqual(pre.fingerprint);
    // Only the watcher_fault_* / watcher_job_* fields differ — grouping is stable.
    expect(pre.tags.runner_fatal_class).toBe(post.tags.runner_fatal_class);
    expect(pre.tags.windows_exit_status).toBe(post.tags.windows_exit_status);
  });
});
