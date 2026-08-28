/**
 * Manual runner-exit attribution (HQ-DESKTOP-4T).
 *
 * A manual-sync runner exit-2 with 7205 pull errors reached Sentry
 * unattributable: every error collapsed to the class/op catch-all OTHER/other,
 * the stack shape read `all_redacted` because the 8-line stderr tail was ndjson
 * error records rather than a stack, no runner version was attached, and the one
 * breadcrumb that would have named the auth-class line was deleted by Sentry's
 * default @password:filter scrubber because the app spelled its own token
 * `auth`.
 *
 * HQ-DESKTOP-5H later showed the SAME both-seams invariant had a hole: the
 * content-safe unmatched-stderr structural rollup (runner_unmatched_stderr_shapes)
 * was wired ONLY on the watcher route, so a manual-route runner that exited
 * non-zero after emitting one unrecognised plain-stderr line and no ndjson error
 * records reached Sentry with every attribution axis empty. This spec now also
 * pins that axis at BOTH seams.
 *
 * The Rust suites pin the seam from the inside (crates/hq-desktop-core,
 * crates/hq-telemetry, and real-child artifact tests in commands::sync that
 * drive the production capture path end to end — including the exact
 * 16-stdout/1-unrecognised-stderr/exit-1 shape of the reported event). This spec
 * pins the same properties at the *source-contract* level, following the
 * fixture-backed pattern of watcher-stall-teardown-attribution.spec.ts: the
 * additive attribution must be wired at BOTH capture seams from the one shared
 * hq-desktop-core source, and the breadcrumb renderer must not emit a
 * denylist-colliding token. Every assertion slices the exact function that ships,
 * so deleting or relocating an emission fails here — the guard is not vacuous.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

const syncSource = readRepoFile('src-tauri/src/commands/sync.rs');
const daemonSource = readRepoFile('src-tauri/src/commands/daemon.rs');
const coreSource = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
const shapeSource = readRepoFile('../../crates/hq-desktop-core/src/runner_error_shape.rs');
const telemetrySource = readRepoFile('../../crates/hq-telemetry/src/lib.rs');

/**
 * Slice the region between two unique anchors. Throws rather than degrading —
 * a moved anchor must fail loudly instead of silently asserting over ''.
 */
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

// Sentry's default-scrubber denylist. No breadcrumb token may contain any of
// these, or the server-side @password:filter deletes the breadcrumb.
const DENYLIST = [
  'auth',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'api_key',
  'apikey',
  'session',
  'private_key',
  'privatekey',
];

describe('manual runner-exit attribution — shared classifier source', () => {
  it('defines the message-shape, path-root, and stack-input classifiers in a dedicated module', () => {
    expect(shapeSource).toContain('pub fn classify_runner_error_shape(');
    expect(shapeSource).toContain('pub fn classify_runner_path_root(');
    expect(shapeSource).toContain('pub fn classify_runner_stack_input(');
    // The dominant real-world shape, grounded on hq-cloud's verbatim message.
    expect(shapeSource).toContain('containment_escape');
    expect(shapeSource).toContain('escaped the sync root');
  });

  it('renders bounded, fixed-vocabulary tags that never copy input bytes', () => {
    // Top-N keeps the tag value under Sentry's 200-char limit under a flood.
    expect(shapeSource).toContain('const ROLLUP_TAG_TOP_N');
    // Path roots are matched to a closed vocabulary, unrecognised -> Other.
    expect(shapeSource).toMatch(/"knowledge"\s*=>\s*RunnerPathRoot::Knowledge/);
    expect(shapeSource).toContain('_ => RunnerPathRoot::Other');
  });

  it('defines the HTTP-status and cause axes with denylist-safe emitted tokens', () => {
    expect(shapeSource).toContain('pub fn classify_runner_error_http_status(');
    expect(shapeSource).toContain('pub fn classify_runner_error_cause(');
    // The two axes' EMITTED token vocabularies (their as_str arms) must contain
    // no Sentry denylist substring, or the server-side @password:filter deletes
    // the very attribution they add — the original HQ-DESKTOP-4T loss.
    const httpTokens = sliceBetween(
      shapeSource,
      'Self::Http400 => "http_400",',
      'Self::HttpOther => "http_other",',
      'RunnerErrorHttpStatus tokens',
    );
    const causeTokens = sliceBetween(
      shapeSource,
      'Self::EntityNotFound => "entity_not_found",',
      'Self::UnknownUnnamed => "unknown_unnamed",',
      'RunnerErrorCause tokens',
    );
    for (const denied of DENYLIST) {
      expect(httpTokens).not.toMatch(new RegExp(`"[^"]*${denied}[^"]*"`));
      expect(causeTokens).not.toMatch(new RegExp(`"[^"]*${denied}[^"]*"`));
    }
    // The identity-adjacent causes use the safe spelling, never *_token/*_auth —
    // including the Cognito identities, spelled cognito_identity, never *_auth.
    expect(causeTokens).toContain('"expired_identity"');
    expect(causeTokens).toContain('"vault_identity"');
    expect(causeTokens).toContain('"cognito_identity"');
    expect(causeTokens).toContain('"cognito_identity_refresh"');
  });

  it('completes the cause vocabulary against the real identity set and pins it', () => {
    // The reopen: the vocabulary now covers hq-cloud's REAL identity set, not the
    // 16-name sample — the Vault*/StateStore*/Cursor/BaseVersion families the
    // prior fix collapsed to `unknown` are now named tokens.
    for (const token of [
      'vault_not_found',
      'vault_permission_denied',
      'state_store_corruption',
      'cursor_retired',
      'base_version_unavailable',
      'rate_limited',
      'source_not_found',
    ]) {
      expect(shapeSource).toContain(`"${token}"`);
    }
    // The flat residual is split so a future unlisted identity stays describable,
    // and only the named side is correlatable by signature.
    expect(shapeSource).toContain('"unknown_named"');
    expect(shapeSource).toContain('"unknown_unnamed"');
    expect(shapeSource).toContain('pub fn runner_error_cause_signature(');
    expect(shapeSource).toContain('pub struct RunnerErrorCauseSignatureRollup');
    // The staleness pin: the vocabulary source version is asserted equal to the
    // runner pin, so bumping the runner without re-deriving fails the build.
    expect(shapeSource).toContain('CAUSE_VOCABULARY_SOURCE_VERSION');
    expect(shapeSource).toContain('crate::hq_cloud::HQ_CLOUD_VERSION');
  });

  it('re-pins the built-in JS + errno cause families, the errno classes, and the compile-time drift guard (r2)', () => {
    // The regression reopen (HQ-DESKTOP-4T r2): the production recurrence decoded
    // to a JavaScript RangeError, and per-file faults carried Node errno codes the
    // vocabulary did not know. Both families are now named.

    // (1) The ECMAScript/Node built-in identity family — emitted tokens and their
    // producer-name mappings. RangeError is the decoded recurrence.
    for (const [name, token] of [
      ['RangeError', 'range_error'],
      ['TypeError', 'type_error'],
      ['SyntaxError', 'syntax_error'],
      ['ReferenceError', 'reference_error'],
      ['EvalError', 'eval_error'],
      ['URIError', 'uri_error'],
      ['AggregateError', 'aggregate_error'],
      ['AbortError', 'abort_error'],
      ['SystemError', 'system_error'],
    ]) {
      expect(shapeSource).toContain(`"${token}"`);
      expect(shapeSource).toContain(`"${name}" => RunnerErrorCause::`);
    }

    // (2) The closed Node/libuv errno vocabulary, read from a `code=` value or a
    // leading bare `ERRNO:` token — including the four the class axis knows so the
    // cause and class axes agree on the same message.
    for (const [code, token] of [
      ['ENOENT', 'enoent'],
      ['EEXIST', 'eexist'],
      ['ENOTEMPTY', 'enotempty'],
      ['EXDEV', 'exdev'],
      ['ETIMEDOUT', 'etimedout'],
      ['ECONNRESET', 'econnreset'],
      ['EAI_AGAIN', 'eai_again'],
      ['EPERM', 'eperm'],
      ['EACCES', 'eacces'],
      ['ENOSPC', 'enospc'],
      ['EBUSY', 'ebusy'],
    ]) {
      expect(shapeSource).toContain(`"${token}"`);
      expect(shapeSource).toContain(`"${code}" => RunnerErrorCause::`);
    }

    // (3) The one hq-cloud identity the ~6.15.79 pin added.
    expect(shapeSource).toContain('"child_process_sync_worker"');
    expect(shapeSource).toContain(
      '"ChildProcessSyncWorkerError" => RunnerErrorCause::ChildProcessSyncWorker',
    );

    // (4) The pin now matches the runner floor, AND the guard fires at COMPILE
    // time (a const assertion, not only a #[test]) so a pin bump on ANY branch —
    // including one cut before the guard existed, the PR #533 defect — fails the
    // build instead of silently merging a mismatch.
    expect(shapeSource).toContain('CAUSE_VOCABULARY_SOURCE_VERSION: &str = "~6.15.79"');
    expect(shapeSource).toMatch(/const _: \(\) = assert!\(\s*const_str_eq\(/);

    // (5) The new filesystem errno CLASSES (sync_outcome), added as new variants so
    // a rename fault reports a real class instead of OTHER while the op axis keeps
    // reporting rename. Pre-existing class tokens stay byte-identical (pinned below).
    for (const [variant, tag] of [
      ['Enoent', 'ENOENT'],
      ['Eexist', 'EEXIST'],
      ['Enotempty', 'ENOTEMPTY'],
      ['Exdev', 'EXDEV'],
    ]) {
      expect(coreSource).toContain(`Self::${variant} => "${tag}"`);
    }

    // (6) The egress mirror (hq-telemetry) accepts the new cause tokens and the new
    // class breadcrumb tokens, so nothing the producer now emits is [Filtered].
    expect(telemetrySource).toContain('"range_error"');
    expect(telemetrySource).toContain('"enoent"');
    expect(telemetrySource).toContain('"child_process_sync_worker"');
  });
});

describe('manual runner-exit attribution — manual capture seam (commands::sync)', () => {
  const telemetryContext = sliceBetween(
    syncSource,
    'fn runner_exit_telemetry_context(',
    'fn capture_runner_exit_error(',
    'runner_exit_telemetry_context',
  );

  it('emits the shape and path-root rollups from the shared RunTotals source', () => {
    expect(telemetryContext).toContain('totals.runner_error_shapes.tag_value()');
    expect(telemetryContext).toContain('"runner_error_shapes"');
    expect(telemetryContext).toContain('totals.runner_error_path_roots.tag_value()');
    expect(telemetryContext).toContain('"runner_error_path_roots"');
  });

  it('emits the HTTP-status, cause, and cause-signature rollups from the shared source', () => {
    expect(telemetryContext).toContain('totals.runner_error_http.tag_value()');
    expect(telemetryContext).toContain('"runner_error_http"');
    expect(telemetryContext).toContain('totals.runner_error_causes.tag_value()');
    expect(telemetryContext).toContain('"runner_error_causes"');
    expect(telemetryContext).toContain('totals.runner_error_cause_signature.tag_value()');
    expect(telemetryContext).toContain('"runner_error_cause_signature"');
  });

  it('attaches runner provenance so the npx-resolved runner is identifiable', () => {
    expect(telemetryContext).toContain('"hq_cloud_version"');
    expect(telemetryContext).toContain('HQ_CLOUD_VERSION');
    expect(telemetryContext).toContain('"hq_cloud_package"');
    expect(telemetryContext).toContain('HQ_CLOUD_PACKAGE');
  });

  it('makes the stack shape honest and reports the true stderr line count and scope', () => {
    expect(telemetryContext).toContain('classify_runner_stack_input(&context.stderr_tail)');
    expect(telemetryContext).toContain('"runner_stack_input"');
    expect(telemetryContext).toContain('"runner_stderr_line_count"');
    expect(telemetryContext).toContain('context.stderr_line_count');
    expect(telemetryContext).toContain('totals.runner_error_scope()');
    expect(telemetryContext).toContain('"runner_error_scope"');
  });

  it('records the unmatched-stderr rollup on every line and attaches it at the manual seam', () => {
    // HQ-DESKTOP-5H: a manual-route non-zero exit whose only evidence was one
    // unrecognised stderr line reached Sentry with this axis empty, because the
    // rollup was wired ONLY on the watcher route. The manual run loop must now feed
    // the shared hq-desktop-core recorder on every stderr line and carry the
    // rendered value onto the exit context, and the capture builder must push the
    // tag — exactly as the watcher route does. Deleting any leg fails here.
    const runLoop = sliceBetween(
      syncSource,
      'let mut runner_stderr_sequence = 0_u32;',
      'apply_runner_exit_disposition(',
      'manual run loop',
    );
    expect(runLoop).toContain('UnmatchedStderrShapeRollup::default()');
    expect(runLoop).toContain('runner_unmatched_stderr.record_if_unmatched(&line)');
    expect(runLoop).toContain('exit_context.runner_unmatched_stderr_shapes');
    expect(runLoop).toContain('runner_unmatched_stderr.tag_value()');
    // The capture builder pushes the tag from the rendered value, absent-safe.
    expect(telemetryContext).toContain('context.runner_unmatched_stderr_shapes');
    expect(telemetryContext).toContain('"runner_unmatched_stderr_shapes"');
  });

  it('renders the breadcrumb class through the denylist-safe single source', () => {
    const breadcrumb = sliceBetween(
      syncSource,
      'fn runner_stderr_breadcrumb(',
      'fn update_runner_stderr_totals(',
      'runner_stderr_breadcrumb',
    );
    expect(breadcrumb).toContain('classify_runner_error_class(line).breadcrumb_token()');
    // The renderer must not re-introduce a literal denylist-colliding class token.
    for (const denied of DENYLIST) {
      expect(breadcrumb).not.toMatch(new RegExp(`=>\\s*"[^"]*${denied}[^"]*"`));
    }
  });
});

describe('manual runner-exit attribution — breadcrumb token single source (hq-desktop-core)', () => {
  const breadcrumbToken = sliceBetween(
    coreSource,
    'pub fn breadcrumb_token(self) -> &\'static str {',
    'pub fn classify_runner_error_class(',
    'RunnerErrorClass::breadcrumb_token',
  );

  it('spells the auth class `identity`, never `auth`', () => {
    expect(breadcrumbToken).toContain('Self::Auth => "identity"');
    expect(breadcrumbToken).not.toContain('Self::Auth => "auth"');
  });

  it('emits no token containing a Sentry denylist substring', () => {
    for (const denied of DENYLIST) {
      expect(breadcrumbToken).not.toMatch(new RegExp(`=>\\s*"[^"]*${denied}[^"]*"`));
    }
  });

  it('keeps tag_name/fingerprint_token unchanged so grouping and history survive', () => {
    // Grouping tokens keep their pre-fix spelling — attribution only ADDS info.
    expect(coreSource).toContain('Self::Auth => "AUTH"');
    expect(coreSource).toMatch(/fn fingerprint_token\(self\)[\s\S]*?Self::Auth => "auth"/);
  });
});

describe('manual runner-exit attribution — content-safe allowlist (hq-telemetry)', () => {
  const allowlist = sliceBetween(
    telemetrySource,
    'fn is_content_safe_runner_stderr_message(',
    'fn scrub_sensitive_in_value(',
    'is_content_safe_runner_stderr_message',
  );

  it('accepts the renamed identity token and the missing node_check_abort fatal token', () => {
    expect(allowlist).toContain('"identity"');
    expect(allowlist).toContain('"node_check_abort"');
    // Legacy `auth` stays accepted so in-flight older clients remain sendable.
    expect(allowlist).toContain('"auth"');
  });

  it('guards all four runner-error rollup axes at egress', () => {
    // The two new axes AND the pre-existing shape/path-root axes (which shipped
    // with no egress guard) are validated in before_send, so a producer bug in
    // any of them degrades to [Filtered] instead of shipping a raw fragment.
    expect(telemetrySource).toContain('"runner_error_http" => Some(is_closed_vocab_count_rollup(');
    expect(telemetrySource).toContain(
      '"runner_error_causes" => Some(is_closed_vocab_count_rollup(',
    );
    expect(telemetrySource).toContain('RUNNER_ERROR_SHAPE_TOKENS');
    expect(telemetrySource).toContain('RUNNER_ERROR_PATH_ROOT_TOKENS');
    // The cause-signature axis has its own egress arm: only a bare hex12:count
    // entry survives, so a producer bug degrades to [Filtered].
    expect(telemetrySource).toContain(
      '"runner_error_cause_signature" => Some(is_runner_error_cause_signature_rollup(',
    );
  });
});

describe('manual runner-exit attribution — watcher capture seam parity (commands::daemon)', () => {
  it('reads the SAME shared rollups as the manual seam in its capture context', () => {
    const captureContext = sliceBetween(
      daemonSource,
      'fn watcher_exit_capture_context(',
      'saw_alertable_error: totals.saw_alertable_error,',
      'watcher_exit_capture_context',
    );
    expect(captureContext).toContain('totals.runner_error_shapes.tag_value()');
    expect(captureContext).toContain('totals.runner_error_path_roots.tag_value()');
    expect(captureContext).toContain('totals.runner_error_http.tag_value()');
    expect(captureContext).toContain('totals.runner_error_causes.tag_value()');
    expect(captureContext).toContain('totals.runner_error_cause_signature.tag_value()');
    expect(captureContext).toContain('totals.runner_error_scope()');
    expect(captureContext).toContain('classify_runner_stack_input(stderr_tail)');
  });

  it('emits the shape, path-root, HTTP, cause, and cause-signature tags alongside class/op', () => {
    const tagAssembly = sliceBetween(
      daemonSource,
      'if let Some(rollup) = &context.runner_error_rollup {',
      'if code == Some(WINDOWS_SESSION_TERMINATE_EXIT)',
      'watcher tag assembly',
    );
    expect(tagAssembly).toContain('"runner_error_shapes"');
    expect(tagAssembly).toContain('"runner_error_path_roots"');
    expect(tagAssembly).toContain('"runner_error_http"');
    expect(tagAssembly).toContain('"runner_error_causes"');
    expect(tagAssembly).toContain('"runner_error_cause_signature"');
  });

  it('emits the stack-input and scope extras', () => {
    const extras = sliceBetween(
      daemonSource,
      'fn watcher_exit_context_extras(',
      'fn runner_exec_provenance_extras(',
      'watcher_exit_context_extras',
    );
    expect(extras).toContain('"runner_stack_input"');
    expect(extras).toContain('"runner_error_scope"');
  });

  it('records and attaches the SAME unmatched-stderr axis, so both seams carry it', () => {
    // Both-seams invariant for the unmatched-stderr axis (HQ-DESKTOP-5H): the
    // watcher route feeds the same shared recorder and pushes the same tag, so an
    // unrecognised-line exit is attributed identically on both seams. This is the
    // axis the manual seam was missing; pinning it here proves the parity holds
    // from the one shared hq-desktop-core source, not two hand-rolled copies.
    expect(daemonSource).toContain('.record_if_unmatched(&line)');
    expect(daemonSource).toContain(
      'exit_context.runner_unmatched_stderr_shapes = process_unmatched_stderr',
    );
    const watcherUnmatchedPush = sliceBetween(
      daemonSource,
      'if let Some(shapes) = &context.runner_unmatched_stderr_shapes {',
      'if let (Some(code), Some(termination))',
      'watcher unmatched-stderr push',
    );
    expect(watcherUnmatchedPush).toContain(
      'tags.push(("runner_unmatched_stderr_shapes", shapes.clone()))',
    );
  });
});
