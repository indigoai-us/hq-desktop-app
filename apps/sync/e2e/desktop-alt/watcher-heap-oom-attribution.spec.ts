/**
 * Watcher heap-OOM attribution (HQ-DESKTOP-55).
 *
 * The auto-sync Node runner died of a V8 JavaScript heap OOM (SIGABRT) during
 * the pull phase, and the crash report could not attribute it: the exit path
 * derived the stack shape from the LAST 8 stderr lines — mid-stack native frames
 * a fixed vocabulary with zero V8 entries collapses to `all_redacted`/`unknown`;
 * the RSS headline sampled only the registered npx LAUNCHER (32KB), not the Node
 * runner that exhausted its heap; and V8's heap figures and native frames were
 * discarded. The shipped HQ-DESKTOP-55 title was:
 *   `[sync] auto-sync watcher exited unexpectedly (aborted with SIGABRT),
 *    consecutive failure #1 [uptime=35m23s; last_rss=32KB (sampled 8s before exit)]`.
 *
 * The Rust suites (hq-desktop-core, hq-telemetry, and real-capture tests in the
 * app crate) pin the seam from the inside. This spec pins the same property at
 * the *source-contract* and *artifact* levels, following the fixture-backed
 * pattern of watcher-stall-teardown-attribution.spec.ts:
 *
 * 1. Source contracts over the code that actually ships — the record_stderr_line
 *    heap-OOM retention, the class-scoped selection helper at BOTH exit routes,
 *    the scope-aware RSS renderer, and the telemetry egress arms — so deleting
 *    or bypassing any seam fails here, not only in the Rust suite.
 * 2. An envelope simulator run in BOTH directions: the post-fix policy carries a
 *    class-scoped V8 shape + 16-hex signature + banner + integer heap extras and
 *    a tree-scoped (or explicitly withheld) RSS; the SAME simulator under the
 *    pre-fix policy reproduces the observed HQ-DESKTOP-55 envelope, keeping the
 *    passing direction non-vacuous.
 *
 * Content-safety: every modeled envelope carries only fixed vocabulary, bounded
 * integers, and a digest — never argv, stderr, symbols, paths, or company slugs.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { assertContentSafeDiagnostics } from './windows-reliability-harness';

// repoRoot is apps/sync, so the shared crate sources are read via '../../crates'.
const coreSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
const coreDaemonSource = readRepoFile('../../crates/hq-desktop-core/src/daemon.rs');
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const syncSource = readRepoFile('src-tauri/src/commands/sync.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

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

/** Read the production default instead of letting this artifact model drift. */
function declaredU32Constant(name: string): number {
  const match = coreDaemonSource.match(new RegExp(`pub const ${name}: u32 = (\\d+);`));
  if (!match) throw new Error(`missing declared core constant: ${name}`);
  return Number(match[1]);
}

const RUNNER_HEAP_CEILING_DEFAULT_MB = declaredU32Constant('RUNNER_HEAP_CEILING_DEFAULT_MB');

describe('watcher heap-OOM attribution — source contracts', () => {
  it('retains heap-OOM evidence at the shared record_stderr_line seam', () => {
    // Both routes feed record_stderr_line, so retaining here inherits parity.
    expect(coreSource).toContain('self.record_heap_oom_stderr_line(line, signature.class);');
    const retention = sliceBetween(
      coreSource,
      'fn record_heap_oom_stderr_line(',
      'pub fn runner_heap_oom_banner(',
      'record_heap_oom_stderr_line',
    );
    // GC candidate → banner → bounded native-frame capture, single-pass.
    expect(retention).toContain('parse_gc_heap_candidate(line)');
    expect(retention).toContain('RunnerFatalClass::HeapOom');
    expect(retention).toContain('"reached_heap_limit"');
    expect(retention).toContain('"ineffective_mark_compacts"');
    expect(retention).toContain('parse_native_frame_symbol(line)');
    expect(retention).toContain('HEAP_OOM_FRAME_CAP');
  });

  it('digests the FULL captured section into the signature, not just the shape window', () => {
    const shapeFn = sliceBetween(
      coreSource,
      'fn heap_oom_stack_shape(frames: &[String]) -> RunnerStackShape {',
      '\n}\n',
      'heap_oom_stack_shape',
    );
    // Shape is the first RUNNER_STACK_FRAME_CAP tokens (≤ 8, the telemetry cap) …
    expect(shapeFn).toContain('.take(RUNNER_STACK_FRAME_CAP)');
    // … but the signature digests the FULL frame list, so the allocating frame —
    // which sits past frame 8 — still discriminates two same-machinery stacks.
    expect(shapeFn).toContain('Sha256::digest(frames.join("\\n").as_bytes())');
  });

  it('wires the class-scoped selection helper into BOTH exit routes', () => {
    expect(daemonSource).toContain('runner_stack_shape_for_exit(&totals, stderr_tail)');
    expect(syncSource).toContain('runner_stack_shape_for_exit(totals, &context.stderr_tail)');
  });

  it('emits the banner tag + integer heap extras at BOTH routes when present', () => {
    for (const source of [daemonSource, syncSource]) {
      expect(source).toContain('"runner_oom_banner"');
      expect(source).toContain('"runner_heap_used_mb"');
      expect(source).toContain('"runner_heap_total_mb"');
      expect(source).toContain('"runner_oom_frame_count"');
    }
  });

  it('renders RSS scope-aware: tree qualified, non-runner single-PID withheld', () => {
    const renderer = sliceBetween(daemonSource, 'fn render_last_rss(', '\n}\n', 'render_last_rss');
    expect(renderer).toContain('(tree, sampled');
    expect(renderer).toContain('unattributed:{other}');
    // The `runner` scope keeps the historical plain-number string exactly.
    expect(renderer).toContain('last_rss={}');

    const resolver = sliceBetween(daemonSource, 'fn resolve_rss_scope(', '\n}\n', 'resolve_rss_scope');
    // `runner` is NEVER produced by inference — only a Tree sample yields `tree`,
    // every fallback keeps today's command-derived scope.
    expect(resolver).toContain('Some(RssSampleKind::Tree) => "tree"');
    expect(resolver).toContain('rss_scope(watcher_command)');
  });

  it('sums the descendant tree for the honest RSS scope', () => {
    expect(daemonSource).toContain('fn sum_pid_tree_rss_kb(');
    expect(daemonSource).toContain('fn sample_watcher_rss_scoped(');
    // The supervisor tick uses the scoped sampler (one ps spawn, not an added one).
    expect(daemonSource).toContain('sample_watcher_rss_scoped(pid)');
  });

  it('registers the heap-OOM + tree vocabulary at the telemetry egress boundary', () => {
    expect(telemetrySource).toContain('"runner_oom_banner" => Some(matches!(');
    expect(telemetrySource).toContain('"shim" | "launcher" | "runner" | "tree"');
    expect(telemetrySource).toContain(
      '"runner_heap_used_mb" | "runner_heap_total_mb" | "runner_oom_frame_count"',
    );
  });

  it('carries the declared runner heap ceiling on the watcher exit (auto-sync watcher memory cluster)', () => {
    // The heap-OOM exit now also records the ceiling that bounded the heap, plus
    // its provenance, and the telemetry egress registers both keys.
    expect(daemonSource).toContain('"runner_heap_ceiling_mb"');
    expect(daemonSource).toContain('"runner_heap_ceiling_source"');
    expect(telemetrySource).toContain('"runner_heap_ceiling_source" => Some(matches!(');
  });

  it('keeps the stack-token vocabulary identical across producer and validator', () => {
    for (const token of [
      'node_oom_handler',
      'v8_report_oom',
      'v8_fatal_process_oom',
      'v8_heap_allocator',
      'v8_heap',
      'v8_factory',
      'v8_runtime',
      'anon',
    ]) {
      expect(coreSource).toContain(`"${token}"`);
      expect(telemetrySource).toContain(`"${token}"`);
    }
    // A cross-crate parity test exists so a one-sided token edit fails CI.
    expect(telemetrySource).toContain('fn runner_stack_tokens_match_across_crates(');
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

/**
 * The exact stderr of two real reproduced V8 heap OOMs (node v22, exit 134).
 * They share an identical first-8 machinery prefix and diverge only from frame
 * 9, with different allocating frames — the direct proof that a fixed 8-frame
 * window plus fixed-token hashing cannot discriminate them, but a signature over
 * the full captured section can.
 */
const FIXTURE_A: string[] = [
  '',
  '<--- Last few GCs --->',
  '',
  '[1174487:0x1e0a3000]       66 ms: Mark-Compact 47.7 (80.5) -> 47.7 (80.5) MB, pooled: 0 MB, 1.65 / 0.00 ms  (average mu = 0.862, current mu = 0.808) allocation failure; scavenge might not succeed',
  '',
  '',
  '<--- JS stacktrace --->',
  '',
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  '----- Native stack trace -----',
  '',
  ' 1: 0xe46bbe node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]',
  ' 2: 0x1243740 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]',
  ' 3: 0x1243a17 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]',
  ' 4: 0x1472925  [node]',
  ' 5: 0x148c1b9 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [node]',
  ' 6: 0x14608b8 v8::internal::HeapAllocator::AllocateRawWithLightRetrySlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]',
  ' 7: 0x14617e5 v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]',
  ' 8: 0x1439b0e v8::internal::Factory::AllocateRaw(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]',
  ' 9: 0x1427e9a v8::internal::FactoryBase<v8::internal::Factory>::AllocateRawArray(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]',
  '10: 0x1428608 v8::internal::FactoryBase<v8::internal::Factory>::NewFixedDoubleArray(int, v8::internal::AllocationType) [node]',
  '11: 0x16075a6  [node]',
  '12: 0x1621b62  [node]',
  '13: 0x1642638  [node]',
  '14: 0x1644ba5 v8::internal::ArrayConstructInitializeElements(v8::internal::Handle<v8::internal::JSArray>, v8::internal::Arguments<(v8::internal::ArgumentsType)1>*) [node]',
  '15: 0x1889f5d v8::internal::Runtime_NewArray(int, unsigned long*, v8::internal::Isolate*) [node]',
  '16: 0x1dfcaf6  [node]',
  'timeout: the monitored command dumped core',
];

const FIXTURE_B: string[] = [
  '',
  '<--- Last few GCs --->',
  '',
  '[2510830:0x1f857000]       73 ms: Mark-Compact 47.4 (80.5) -> 47.4 (80.5) MB, pooled: 0 MB, 8.34 / 0.00 ms  (average mu = 0.681, current mu = 0.276) allocation failure; scavenge might not succeed',
  '',
  '',
  '<--- JS stacktrace --->',
  '',
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  '----- Native stack trace -----',
  '',
  ' 1: 0xe46bbe node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]',
  ' 2: 0x1243740 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]',
  ' 3: 0x1243a17 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]',
  ' 4: 0x1472925  [node]',
  ' 5: 0x148c1b9 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [node]',
  ' 6: 0x14608b8 v8::internal::HeapAllocator::AllocateRawWithLightRetrySlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]',
  ' 7: 0x14617e5 v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]',
  ' 8: 0x1439b0e v8::internal::Factory::AllocateRaw(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]',
  ' 9: 0x1428944 v8::internal::FactoryBase<v8::internal::Factory>::AllocateRawWithImmortalMap(int, v8::internal::AllocationType, v8::internal::Tagged<v8::internal::Map>, v8::internal::AllocationAlignment) [node]',
  '10: 0x1429e0e v8::internal::FactoryBase<v8::internal::Factory>::NewRawOneByteString(int, v8::internal::AllocationType) [node]',
  '11: 0x178001d v8::internal::String::SlowFlatten(v8::internal::Isolate*, v8::internal::Handle<v8::internal::ConsString>, v8::internal::AllocationType) [node]',
  '12: 0x143d1eb v8::internal::Factory::NewProperSubString(v8::internal::Handle<v8::internal::String>, int, int) [node]',
  '13: 0x18bd5ea v8::internal::Runtime_StringSubstring(int, unsigned long*, v8::internal::Isolate*) [node]',
  '14: 0x1dfcaf6  [node]',
  'timeout: the monitored command dumped core',
];

interface RssSample {
  kb: number;
  ageSecs: number;
  kind: 'tree' | 'single';
  /** Command-derived scope when the sample is single-PID (npx = launcher). */
  commandScope: 'launcher' | 'shim' | 'runner';
}

// ── TS mirrors of the shipped Rust retention/rendering (fixture-driven) ──────

/** Mirror of `RUNTIME_FRAME_TABLE` heap tokens in `heap_oom_frame_token`. */
function heapOomFrameToken(symbol: string): string {
  if (symbol.includes('OOMErrorHandler')) return 'node_oom_handler';
  if (symbol.includes('node::Abort') || symbol.includes('OnFatalError')) return 'node_abort';
  if (symbol.includes('ReportOOMFailure')) return 'v8_report_oom';
  if (symbol.includes('FatalProcessOutOfMemory')) return 'v8_fatal_process_oom';
  if (symbol.includes('HeapAllocator')) return 'v8_heap_allocator';
  if (symbol.includes('v8::internal::Heap')) return 'v8_heap';
  if (symbol.includes('Factory')) return 'v8_factory';
  if (symbol.includes('Runtime_')) return 'v8_runtime';
  if (symbol.includes('Builtins_')) return 'v8_builtin';
  if (symbol.includes('v8::')) return 'v8_other';
  if (symbol.includes('node::')) return 'node_native';
  return 'anon';
}

/** Mirror of `parse_native_frame_symbol`. */
function parseNativeFrameSymbol(line: string): string | null {
  const trimmed = line.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0 || colon > 3) return null;
  const ordinal = trimmed.slice(0, colon);
  if (!/^\d{1,3}$/.test(ordinal)) return null;
  const rest = trimmed.slice(colon + 1).replace(/^\s+/, '');
  const wsIndex = rest.search(/\s/);
  const address = wsIndex === -1 ? rest : rest.slice(0, wsIndex);
  const tail = wsIndex === -1 ? '' : rest.slice(wsIndex + 1);
  if (!/^0x[0-9a-fA-F]+$/.test(address)) return null;
  let symbol = tail.trim();
  const bracket = symbol.match(/\[[^\]]*\]$/);
  if (bracket) symbol = symbol.slice(0, symbol.length - bracket[0].length).trimEnd();
  return symbol === '' ? 'anon' : symbol;
}

/** Mirror of `parse_gc_heap_candidate` + `round_mb` (half away from zero). */
function parseGcHeap(line: string): [number, number] | null {
  const arrow = line.lastIndexOf('-> ');
  if (arrow === -1) return null;
  const after = line.slice(arrow + 3).replace(/^\s+/, '');
  const match = after.match(/^(\d+(?:\.\d+)?)\s*\(\s*(\d+(?:\.\d+)?)\s*\)\s*MB/);
  if (!match) return null;
  const used = parseFloat(match[1]);
  const total = parseFloat(match[2]);
  if (used < 0 || used >= 1048576 || total < 0 || total >= 1048576) return null;
  return [used, total];
}

interface HeapEvidence {
  banner: string;
  usedTotal: [number, number] | null;
  symbols: string[];
}

/** Mirror of the `record_stderr_line` heap-OOM state machine. */
function retainHeapOom(lines: string[]): HeapEvidence | null {
  let gc: [number, number] | null = null;
  let evidence: HeapEvidence | null = null;
  let framesDone = false;
  for (const line of lines) {
    if (!evidence) {
      const parsed = parseGcHeap(line);
      if (parsed) gc = parsed;
    }
    if (!evidence && /javascript heap out of memory/i.test(line)) {
      const lower = line.toLowerCase();
      const banner = lower.includes('reached heap limit')
        ? 'reached_heap_limit'
        : lower.includes('ineffective mark-compacts')
          ? 'ineffective_mark_compacts'
          : 'other';
      evidence = { banner, usedTotal: gc ? [Math.round(gc[0]), Math.round(gc[1])] : null, symbols: [] };
      continue;
    }
    if (evidence && !framesDone) {
      const symbol = parseNativeFrameSymbol(line);
      if (symbol !== null) {
        if (evidence.symbols.length < 32) evidence.symbols.push(symbol);
      } else if (line.trim() === '') {
        // tolerate blank lines between the banner and the frames
      } else if (evidence.symbols.length === 0) {
        // tolerate the "----- Native stack trace -----" preamble
      } else {
        framesDone = true;
      }
    }
  }
  return evidence;
}

/** Mirror of `format_rss_kb`. */
function formatRssKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)}GB`;
  if (kb >= 1024) return `${Math.floor(kb / 1024)}MB`;
  return `${kb}KB`;
}

/** Mirror of `render_last_rss`. */
function renderLastRss(rss: RssSample, scope: string): string {
  const clause = ` (sampled ${rss.ageSecs}s before exit)`;
  if (scope === 'runner') return `last_rss=${formatRssKb(rss.kb)}${clause}`;
  if (scope === 'tree') return `last_rss=${formatRssKb(rss.kb)} (tree, sampled ${rss.ageSecs}s before exit)`;
  return `last_rss=unattributed:${scope}${clause}`;
}

/**
 * Model one heap-OOM watcher exit into the Sentry envelope the artifact ships.
 * `pre-fix` reproduces the shipped HQ-DESKTOP-55 output (generic last-8 tail →
 * all_redacted, an unqualified launcher RSS, no heap fields); `post-fix` retains
 * the evidence and honestly scopes the RSS.
 */
function simulateHeapOomEnvelope(
  stderr: string[],
  policy: Policy,
  rss: RssSample,
): SentryEnvelopeEvent {
  const tags: Record<string, string> = {
    sync_route: 'watcher',
    runner_fatal_class: 'heap_oom',
    watcher_child_kind:
      rss.commandScope === 'shim' ? 'cmd_shim' : rss.commandScope === 'launcher' ? 'launcher' : 'direct_executable',
  };
  const extras: Record<string, string | boolean | number> = {
    watcher_lifecycle_state: 'running',
    runner_phase: 'pull',
    fatal_runner_signature_seen: true,
  };
  let lastRss: string;

  if (policy === 'pre-fix') {
    // The generic path over the last-8 V8 native frames matches no marker in the
    // fixed vocabulary, so it collapses to the observed all_redacted / unknown.
    const tail = stderr.slice(-8);
    tags.runner_stack_shape = 'all_redacted';
    tags.runner_stack_signature = 'unknown';
    tags.rss_scope = rss.commandScope; // launcher — an UNQUALIFIED number ships
    extras.runner_stack_depth = tail.length;
    extras.runner_stack_redacted_frames = tail.length;
    lastRss = `last_rss=${formatRssKb(rss.kb)} (sampled ${rss.ageSecs}s before exit)`;
  } else {
    const evidence = retainHeapOom(stderr);
    if (!evidence) throw new Error('post-fix: expected retained heap evidence');
    const tokens = evidence.symbols.slice(0, 8).map(heapOomFrameToken);
    tags.runner_stack_shape = tokens.join('>');
    tags.runner_stack_signature = createHash('sha256')
      .update(evidence.symbols.join('\n'))
      .digest('hex')
      .slice(0, 16);
    tags.runner_oom_banner = evidence.banner;
    const resolvedScope = rss.kind === 'tree' ? 'tree' : rss.commandScope;
    tags.rss_scope = resolvedScope;
    extras.runner_stack_depth = tokens.length;
    extras.runner_stack_redacted_frames = tokens.filter((token) => token === 'anon').length;
    extras.runner_oom_frame_count = evidence.symbols.length;
    if (evidence.usedTotal) {
      extras.runner_heap_used_mb = evidence.usedTotal[0];
      extras.runner_heap_total_mb = evidence.usedTotal[1];
    }
    // The declared runner heap ceiling now rides EVERY watcher exit (auto-sync
    // watcher unbounded-memory cluster), so a heap OOM is interpretable against
    // the ceiling that bounded it. The scope-withholding assertions are unchanged.
    extras.runner_heap_ceiling_mb = RUNNER_HEAP_CEILING_DEFAULT_MB;
    tags.runner_heap_ceiling_source = 'declared_default';
    lastRss = renderLastRss(rss, resolvedScope);
  }

  return {
    message: `auto-sync watcher exited unexpectedly (aborted with SIGABRT), consecutive failure #1 [uptime=35m23s; ${lastRss}]`,
    fingerprint: ['sync', 'auto-sync-watcher-termination', 'signal:6', 'none'],
    tags,
    extras,
  };
}

// The npx LAUNCHER single-PID sample the shipped event measured (the impossible
// 32KB), and the honest whole-tree sample the fix takes.
const LAUNCHER_SINGLE: RssSample = { kb: 32, ageSecs: 8, kind: 'single', commandScope: 'launcher' };
const TREE_SAMPLE: RssSample = { kb: 48 * 1024, ageSecs: 8, kind: 'tree', commandScope: 'launcher' };

describe('watcher heap-OOM attribution — shipped Sentry envelope', () => {
  it('post-fix: carries a class-scoped V8 shape, signature, banner, and heap integers', () => {
    const event = simulateHeapOomEnvelope(FIXTURE_A, 'post-fix', TREE_SAMPLE);
    expect(event.tags.runner_stack_shape).toBe(
      'node_oom_handler>v8_report_oom>v8_fatal_process_oom>anon>v8_heap>v8_heap_allocator>v8_heap_allocator>v8_factory',
    );
    expect(event.tags.runner_stack_signature).not.toBe('unknown');
    expect(event.tags.runner_stack_signature).toMatch(/^[0-9a-f]{16}$/);
    expect(event.tags.runner_oom_banner).toBe('reached_heap_limit');
    expect(event.extras.runner_heap_used_mb).toBe(48);
    expect(event.extras.runner_heap_total_mb).toBe(81);
    expect(event.extras.runner_oom_frame_count).toBe(16);
    // The RSS is tree-scoped and qualified — never an unqualified launcher number.
    expect(event.tags.rss_scope).toBe('tree');
    expect(event.message).toContain('last_rss=48MB (tree, sampled 8s before exit)');
    expect(event.message).not.toMatch(/last_rss=\d+KB \(sampled/);
    // …and the declared runner heap ceiling now rides the heap-OOM exit too.
    expect(event.extras.runner_heap_ceiling_mb).toBe(RUNNER_HEAP_CEILING_DEFAULT_MB);
    expect(event.tags.runner_heap_ceiling_source).toBe('declared_default');
    assertContentSafeDiagnostics(event);
  });

  it('post-fix: discriminates two same-machinery stacks by their allocating frame', () => {
    const a = simulateHeapOomEnvelope(FIXTURE_A, 'post-fix', TREE_SAMPLE);
    const b = simulateHeapOomEnvelope(FIXTURE_B, 'post-fix', TREE_SAMPLE);
    // Identical first-8 machinery shape …
    expect(a.tags.runner_stack_shape).toBe(b.tags.runner_stack_shape);
    // … but DIFFERENT full-section signatures (the review's required property).
    expect(a.tags.runner_stack_signature).not.toBe(b.tags.runner_stack_signature);
    expect(b.extras.runner_heap_used_mb).toBe(47);
  });

  it('post-fix: withholds the number as unattributed:<scope> when only a single-PID sample exists', () => {
    // The descendant-tree sample failed, so the honest fallback names the scope
    // and refuses to print the launcher footprint as the runner's.
    const event = simulateHeapOomEnvelope(FIXTURE_A, 'post-fix', LAUNCHER_SINGLE);
    expect(event.tags.rss_scope).toBe('launcher');
    expect(event.message).toContain('last_rss=unattributed:launcher (sampled 8s before exit)');
    expect(event.message).not.toContain('last_rss=32KB');
    assertContentSafeDiagnostics(event);
  });

  it('pre-fix: reproduces the observed HQ-DESKTOP-55 envelope (non-vacuity guard)', () => {
    const event = simulateHeapOomEnvelope(FIXTURE_A, 'pre-fix', LAUNCHER_SINGLE);
    expect(event.tags.runner_stack_shape).toBe('all_redacted');
    expect(event.tags.runner_stack_signature).toBe('unknown');
    expect(event.extras.runner_stack_depth).toBe(8);
    expect(event.extras.runner_stack_redacted_frames).toBe(8);
    expect(event.tags.rss_scope).toBe('launcher');
    // The exact shipped title fragment — an unqualified launcher footprint.
    expect(event.message).toContain('last_rss=32KB (sampled 8s before exit)');
    // No heap-OOM fields at all before the fix.
    expect(event.tags.runner_oom_banner).toBeUndefined();
    expect(event.extras.runner_oom_frame_count).toBeUndefined();
    expect(event.extras.runner_heap_used_mb).toBeUndefined();
    assertContentSafeDiagnostics(event);
  });

  it('never regroups: the fingerprint is message-independent across both directions', () => {
    const post = simulateHeapOomEnvelope(FIXTURE_A, 'post-fix', TREE_SAMPLE);
    const pre = simulateHeapOomEnvelope(FIXTURE_A, 'pre-fix', LAUNCHER_SINGLE);
    expect(post.fingerprint).toEqual(pre.fingerprint);
    expect(post.fingerprint).toEqual(['sync', 'auto-sync-watcher-termination', 'signal:6', 'none']);
  });
});
