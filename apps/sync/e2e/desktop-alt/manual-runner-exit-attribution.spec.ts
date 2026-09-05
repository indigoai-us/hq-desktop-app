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
      // Errnos the crate already handles on other axes (ENETDOWN via the
      // transient-network class, EINVAL in the runner-error tests) — named on the
      // cause axis so it is not blank for inputs the app explicitly handles.
      ['ENETDOWN', 'enetdown'],
      ['EINVAL', 'einval'],
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
    expect(shapeSource).toContain('CAUSE_VOCABULARY_SOURCE_VERSION: &str = "~6.16.11"');
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

describe('runner-termination cause fingerprint — both-seams parity + enum-derived validators (HQ-DESKTOP-4T r3)', () => {
  it('bridges a named cause to the error class before the keyword fallback', () => {
    // The reopen mechanism: the keyword class matcher is blind to the cause
    // vocabulary, so a VaultPermissionDeniedError the cause axis named still
    // classed OTHER and reopened the exit-2 catch-all. The class matcher now
    // consults an EXHAUSTIVE cause→class bridge FIRST, with no wildcard arm.
    expect(coreSource).toContain(
      'fn class_for_named_cause(cause: RunnerErrorCause) -> Option<RunnerErrorClass>',
    );
    expect(coreSource).toContain(
      'if let Some(class) = class_for_named_cause(classify_runner_error_cause(message))',
    );
    // The recurrence family maps to AUTH; a DNS/transport errno the keyword matcher
    // omits maps to NETWORK; the residual keeps the keyword fallback (None).
    expect(coreSource).toContain('RunnerErrorCause::VaultPermissionDenied');
    expect(coreSource).toMatch(
      /RunnerErrorCause::AccessDenied\s*=>\s*Some\(RunnerErrorClass::Auth\)/,
    );
    expect(coreSource).toContain('RunnerErrorCause::Enotfound => Some(RunnerErrorClass::Network)');
    expect(coreSource).toContain('| RunnerErrorCause::UnknownUnnamed => None,');
  });

  it('adds a cause-rollup fingerprint token that is enum-owned', () => {
    // The fifth fingerprint element's source: the dominant cause's as_str, never a
    // runner byte, with a "none" empty sentinel mirroring the class rollup.
    expect(shapeSource).toContain('dominant.map(RunnerErrorCause::as_str).unwrap_or("none")');
  });

  it('appends the dominant cause as the fifth fingerprint element at BOTH seams', () => {
    // Manual seam (commands::sync).
    expect(syncSource).toContain(
      'let error_cause = totals.runner_error_causes.fingerprint_token();',
    );
    const manualFp = sliceBetween(
      syncSource,
      'let error_cause = totals.runner_error_causes.fingerprint_token();',
      '];',
      'manual runner-termination fingerprint',
    );
    expect(manualFp).toContain('"runner-termination"');
    expect(manualFp).toContain('error_class,');
    expect(manualFp).toContain('error_cause,');
    // Watcher seam (commands::daemon): the token is carried on the context from the
    // SAME shared rollup and validated before it enters the fingerprint.
    expect(daemonSource).toContain(
      'runner_error_cause: totals.runner_error_causes.fingerprint_token()',
    );
    expect(daemonSource).toContain(
      'let runner_error_cause = safe_runner_error_cause_fingerprint_token(context.runner_error_cause);',
    );
    const watcherFp = sliceBetween(
      daemonSource,
      'let runner_error_cause = safe_runner_error_cause_fingerprint_token(context.runner_error_cause);',
      '];',
      'watcher runner-termination fingerprint',
    );
    expect(watcherFp).toContain('"auto-sync-watcher-termination"');
    expect(watcherFp).toContain('runner_error_class,');
    expect(watcherFp).toContain('runner_error_cause,');
  });

  it('derives BOTH watcher validators from the enums, not a hand-written allow-list', () => {
    // The r2 regression: the hand-written class allow-list did not gain the four new
    // errno tokens, so they degraded to "none". Both validators now enumerate the
    // enum, so a new class or cause token can never silently degrade.
    const classValidator = sliceBetween(
      daemonSource,
      "fn safe_runner_error_fingerprint_token(candidate: &'static str) -> &'static str {",
      '}',
      'class validator',
    );
    expect(classValidator).toContain('RunnerErrorClass::ALL');
    expect(classValidator).toContain('.fingerprint_token() == candidate');
    // The old hand-written literal list is gone from the class validator body.
    expect(classValidator).not.toContain('"eperm" | "eacces" | "enospc" | "ebusy"');
    const causeValidator = sliceBetween(
      daemonSource,
      "fn safe_runner_error_cause_fingerprint_token(candidate: &'static str) -> &'static str {",
      '}',
      'cause validator',
    );
    expect(causeValidator).toContain('RunnerErrorCause::ALL');
    expect(causeValidator).toContain('cause.as_str() == candidate');
  });

  it('leaves the class token spellings and the denylist-safe breadcrumb untouched', () => {
    // Attribution only ADDS a fifth token; the four class token spellings are
    // byte-identical, so the grouping/history the first four tokens carry survive.
    expect(coreSource).toContain('Self::Auth => "AUTH"');
    expect(coreSource).toMatch(/fn fingerprint_token\(self\)[\s\S]*?Self::Auth => "auth"/);
    expect(coreSource).toContain('Self::Auth => "identity"');
  });
});

describe('runner-error SITE attribution — sixth axis + both-seams parity (HQ-DESKTOP-5M)', () => {
  it('declares the full six-sentinel vocabulary against hq-cloud’s emitter set', () => {
    // hq-cloud’s runner emits six error-event `path` sentinels; the desktop knew
    // only the first two. All six are now named constants + a closed RunnerErrorSite
    // enum, so an unknown sentinel is no longer misrouted through the per-file arm.
    for (const sentinel of ['(company)', '(discovery)', '(local-state)', '(runner)', '(scope)', '(auth)']) {
      expect(shapeSource).toContain(`= "${sentinel}";`);
    }
    expect(shapeSource).toContain('pub enum RunnerErrorSite');
    expect(shapeSource).toContain('pub fn classify_runner_error_site(');
    // The site tokens (as_str) are underscore-normalised, never the raw sentinel. The
    // (auth) site is spelled `identity`, never `auth`, so Sentry's @password:filter
    // cannot eat the tag (the same reason the class breadcrumb uses `identity`).
    for (const token of ['"company"', '"discovery"', '"local_state"', '"runner"', '"scope"', '"identity"', '"file"']) {
      expect(shapeSource).toContain(token);
    }
    // No site token carries a Sentry denylist substring, or its attribution would be
    // silently scrubbed in production — the failure this whole change fights.
    const siteTokens = sliceBetween(
      shapeSource,
      'Self::Company => "company",',
      'Self::File => "file",',
      'RunnerErrorSite tokens',
    );
    for (const denied of DENYLIST) {
      expect(siteTokens).not.toMatch(new RegExp(`"[^"]*${denied}[^"]*"`));
    }
    // The enum→sentinel map is EXHAUSTIVE with no wildcard arm, so a future site is
    // a compile error until wired — the discipline class_for_named_cause established.
    expect(shapeSource).toMatch(/fn sentinel\(self\)[\s\S]*?Self::File => None,/);
  });

  it('routes each sentinel away from the per-file arm and adds the site rollup', () => {
    // record_error switches on the site: only File feeds the path-root rollup; every
    // sentinel is counted by the site rollup, and a (runner) record’s embedded stack
    // is shaped. No sentinel is fed to classify_runner_path_root any more.
    const recordError = sliceBetween(
      coreSource,
      'pub fn record_error(',
      'pub fn runner_error_company_count(',
      'record_error',
    );
    expect(recordError).toContain('classify_runner_error_site(&err.path)');
    expect(recordError).toContain('RunnerErrorSite::File => self.runner_error_path_roots.record(&err.path)');
    expect(recordError).toContain('RunnerErrorSite::Runner => self.record_runner_embedded_stack(&err.message)');
    expect(recordError).toContain('self.runner_error_sites.record(&err.path)');
    // The scope split keeps its company/file prefix and appends per-site segments.
    const scope = sliceBetween(
      coreSource,
      'pub fn runner_error_scope(',
      'fn record_runner_embedded_stack(',
      'runner_error_scope',
    );
    expect(scope).toContain('format!("company:{company},file:{file}")');
    for (const label of ['"discovery"', '"local_state"', '"runner"', '"scope"', '"identity"']) {
      expect(scope).toContain(label);
    }
    // The site rollup owns a fingerprint token (enum as_str or the "none" sentinel).
    expect(shapeSource).toContain('impl RunnerErrorSiteRollup');
    expect(shapeSource).toMatch(/pub fn fingerprint_token\(&self\)[\s\S]*?dominant/);
  });

  it('fixes the leading-identity gate to trim one trailing colon ONLY for real err.stacks', () => {
    // The exit-1 gap: an err.stack first line `<Name>: <msg>` carries a trailing
    // colon the describeError rendering does not; trimming one restores the signature.
    const identity = sliceBetween(
      shapeSource,
      'fn leading_error_identity(',
      'pub fn runner_error_cause_signature(',
      'leading_error_identity',
    );
    expect(identity).toContain("first.strip_suffix(':').unwrap_or(first)");
    // The trim is GATED on the message actually being a stack (a `    at …` frame
    // line), so colon-terminated free prose (`AcmeCorp: …`) is never signed — the
    // privacy gate the helper's docstring protects, since it runs for every message.
    expect(identity).toContain('message_has_stack_frame(message)');
    expect(shapeSource).toContain('fn message_has_stack_frame(');
    // Every other rule is preserved: the literal Error, the uppercase-initial gate,
    // the all-alphanumeric-rest gate, and the multi-hump requirement all remain.
    expect(identity).toContain('if first == "Error"');
    expect(identity).toContain('is_ascii_uppercase()');
    expect(identity).toContain('has_inner_upper');
  });

  it('emits the site tag and the sixth fingerprint element at the manual seam', () => {
    const telemetryContext = sliceBetween(
      syncSource,
      'fn runner_exit_telemetry_context(',
      'fn capture_runner_exit_error(',
      'runner_exit_telemetry_context',
    );
    expect(telemetryContext).toContain('totals.runner_error_sites.tag_value()');
    expect(telemetryContext).toContain('"runner_error_sites"');
    // The sixth fingerprint element is the dominant site token, appended after cause.
    expect(syncSource).toContain('let error_site = totals.runner_error_sites.fingerprint_token();');
    const manualFp = sliceBetween(
      syncSource,
      'let error_site = totals.runner_error_sites.fingerprint_token();',
      '];',
      'manual runner-termination fingerprint',
    );
    expect(manualFp).toContain('error_cause,');
    expect(manualFp).toContain('error_site,');
  });

  it('emits the site tag and the sixth fingerprint element at the watcher seam, enum-validated', () => {
    const captureContext = sliceBetween(
      daemonSource,
      'fn watcher_exit_capture_context(',
      'saw_alertable_error: totals.saw_alertable_error,',
      'watcher_exit_capture_context',
    );
    expect(captureContext).toContain('runner_error_site: totals.runner_error_sites.fingerprint_token()');
    expect(captureContext).toContain('runner_error_sites: totals.runner_error_sites.tag_value()');
    // The watcher validator is DERIVED from RunnerErrorSite::ALL (not a hand list),
    // exactly the drift class PR #544 closed for the class/cause validators.
    const siteValidator = sliceBetween(
      daemonSource,
      "fn safe_runner_error_site_fingerprint_token(candidate: &'static str) -> &'static str {",
      '}',
      'site validator',
    );
    expect(siteValidator).toContain('RunnerErrorSite::ALL');
    expect(siteValidator).toContain('.as_str() == candidate');
    expect(daemonSource).toContain(
      'let runner_error_site = safe_runner_error_site_fingerprint_token(context.runner_error_site);',
    );
    const watcherFp = sliceBetween(
      daemonSource,
      'let runner_error_site = safe_runner_error_site_fingerprint_token(context.runner_error_site);',
      '];',
      'watcher runner-termination fingerprint',
    );
    expect(watcherFp).toContain('runner_error_cause,');
    expect(watcherFp).toContain('runner_error_site,');
    // The tag is pushed on the watcher route too, from the same shared rollup.
    expect(daemonSource).toContain('tags.push(("runner_error_sites", sites.clone()))');
  });

  it('guards the site axis at egress (hq-telemetry)', () => {
    // A `site:count` rollup over the closed vocabulary; an off-vocabulary token or
    // the raw sentinel string degrades to [Filtered] instead of shipping a byte.
    expect(telemetrySource).toContain('"runner_error_sites" => Some(is_closed_vocab_count_rollup(');
    expect(telemetrySource).toContain('RUNNER_ERROR_SITE_TOKENS');
  });
});

// ---------------------------------------------------------------------------
// Windows session-end terminator axis (HQ-DESKTOP-5X) — manual seam parity
// ---------------------------------------------------------------------------
//
// A manual `Sync Now` runner torn down by the Windows session manager exited
// 0x40010004 (DBG_TERMINATE_PROCESS) with windows_exit_class=session_terminate,
// yet the manual seam read NEITHER Windows attribution channel, so the alert had
// no windows_terminator and no session_end_latch at all — while the identical
// shape on the watcher route (HQ-DESKTOP-5J) names windows_terminator=
// unattributed_no_signal. This lane gives the manual seam the SAME two shared
// readers so a manual runner is nameable exactly as the watcher route is.

describe('manual runner-exit attribution — Windows session-end terminator axis (HQ-DESKTOP-5X)', () => {
  const attributionSource = readRepoFile('src-tauri/src/commands/session_end_attribution.rs');

  it('extracts the two readers into a shared module BOTH seams call', () => {
    // The readers were private to the daemon/watcher route; they now live in one
    // shared module, unchanged bodies + cfg gates, so both seams read one source.
    expect(attributionSource).toContain(
      'pub(crate) fn current_windows_terminator_attribution<R: tauri::Runtime>(',
    );
    expect(attributionSource).toContain(
      'pub(crate) fn current_session_end_latch_reading_for_exit(',
    );
    // The deferral re-read probe (the deferral LIFECYCLE) stays with the readers.
    expect(attributionSource).toContain('SESSION_END_ATTRIBUTION_PROBE');
    expect(attributionSource).toContain('pub(crate) fn current_session_end_reading(');
    // The watcher route still calls the shared readers from the same module.
    expect(daemonSource).toContain('use crate::commands::session_end_attribution::');
    expect(daemonSource).toContain('current_windows_terminator_attribution(&app, code, signal)');
    expect(daemonSource).toContain('current_session_end_latch_reading_for_exit(code, signal)');
  });

  it('the manual seam reads BOTH shared channels and creates NO deferral', () => {
    // The manual capture seam imports and calls the SAME two readers, self-gated to
    // the DBG_TERMINATE_PROCESS/no-signal shape, right after building the context.
    expect(syncSource).toContain('use crate::commands::session_end_attribution::');
    expect(syncSource).toContain(
      'exit_context.windows_terminator =\n                            current_windows_terminator_attribution(&app_bg, code, signal);',
    );
    expect(syncSource).toContain(
      'exit_context.session_end_latch =\n                            current_session_end_latch_reading_for_exit(code, signal);',
    );
    // ATTRIBUTION ONLY: the manual seam is a pure reader. It never re-reads the
    // deferral probe (that is the watcher route's deferral-resolution path), so the
    // watcher route stays the sole owner of the deferral lifecycle.
    expect(syncSource).not.toContain('current_session_end_reading');
  });

  it('the manual capture builder emits the terminator tag + latch extra, gated to the shape', () => {
    const telemetryContext = sliceBetween(
      syncSource,
      'fn runner_exit_telemetry_context(',
      'fn capture_runner_exit_error(',
      'runner_exit_telemetry_context',
    );
    // windows_terminator is a TAG, from the same fixed vocabulary the watcher route
    // emits, pushed only when the reader returned Some (the session-terminate shape).
    expect(telemetryContext).toContain('if let Some(attribution) = context.windows_terminator {');
    expect(telemetryContext).toContain(
      'tags.push(("windows_terminator", attribution.class_name().to_string()));',
    );
    // session_end_latch is an EXTRA (parity with the watcher route's deferred
    // payload), gated on the same shape so it appears exactly when the terminator does.
    expect(telemetryContext).toContain('if context.windows_terminator.is_some() {');
    expect(telemetryContext).toContain('"session_end_latch"');
    expect(telemetryContext).toContain('context.session_end_latch.class_name()');
  });
});

interface ManualEnvelope {
  message: string;
  fingerprint: string[];
  tags: Record<string, string>;
  extras: Record<string, string>;
}

const MANUAL_CONTENT_SAFE = /^[a-z0-9_./]+$/;

/**
 * Model the reported HQ-DESKTOP-5X manual session-terminate envelope under each
 * policy. The ONLY difference is the two ADDED attribution axes; the fingerprint,
 * message and every pre-existing tag are byte-identical.
 */
function manualSessionTerminateEnvelope(policy: 'pre-fix' | 'post-fix'): ManualEnvelope {
  const env: ManualEnvelope = {
    message: 'manual sync runner exited unexpectedly',
    fingerprint: ['sync', 'runner-termination', 'exit:0x40010004', 'none', 'none', 'none'],
    tags: {
      sync_route: 'manual',
      runner_phase: 'push',
      windows_exit_class: 'session_terminate',
      windows_exit_status: '0x40010004',
      sync_termination_reason: 'uncancelled',
      runner_fatal_class: 'none',
    },
    extras: {},
  };
  if (policy === 'post-fix') {
    // Named exactly as the watcher route's shipped HQ-DESKTOP-5J shape.
    env.tags.windows_terminator = 'unattributed_no_signal';
    env.extras.session_end_latch = 'absent';
  }
  return env;
}

/** A non-session-terminate manual exit-1 — the readers self-gate away from it. */
function manualOtherExitEnvelope(policy: 'pre-fix' | 'post-fix'): ManualEnvelope {
  const env: ManualEnvelope = {
    message: 'manual sync runner exited unexpectedly',
    fingerprint: ['sync', 'runner-termination', 'exit:1', 'none', 'none', 'none'],
    tags: {
      sync_route: 'manual',
      runner_phase: 'push',
      sync_termination_reason: 'uncancelled',
      runner_fatal_class: 'none',
    },
    extras: {},
  };
  // Even post-fix, a non-DBG_TERMINATE_PROCESS exit gets NEITHER axis: the shared
  // readers return None / Unavailable off the one shape they consult. `policy` is
  // intentionally inert here — that inertness is exactly the property under test.
  void policy;
  return env;
}

describe('manual runner-exit attribution — session-terminate envelope (both directions)', () => {
  it('pre-fix reproduces the observed HQ-DESKTOP-5X 0.10.169 envelope verbatim', () => {
    const env = manualSessionTerminateEnvelope('pre-fix');
    expect(env.tags.sync_route).toBe('manual');
    expect(env.tags.runner_phase).toBe('push');
    expect(env.tags.windows_exit_class).toBe('session_terminate');
    expect(env.tags.sync_termination_reason).toBe('uncancelled');
    // The exact honesty gap: NO terminator and NO latch axis at all.
    expect(env.tags.windows_terminator).toBeUndefined();
    expect(env.extras.session_end_latch).toBeUndefined();
  });

  it('post-fix carries windows_terminator + session_end_latch, matching the watcher HQ-DESKTOP-5J shape', () => {
    const env = manualSessionTerminateEnvelope('post-fix');
    expect(env.tags.windows_terminator).toBe('unattributed_no_signal');
    expect(env.extras.session_end_latch).toBe('absent');
  });

  it('emits NEITHER axis on any other exit shape, both directions', () => {
    for (const policy of ['pre-fix', 'post-fix'] as const) {
      const env = manualOtherExitEnvelope(policy);
      expect(env.tags.windows_terminator).toBeUndefined();
      expect(env.extras.session_end_latch).toBeUndefined();
    }
  });

  it('grouping continuity: the fingerprint and every pre-existing field are byte-identical', () => {
    const pre = manualSessionTerminateEnvelope('pre-fix');
    const post = manualSessionTerminateEnvelope('post-fix');
    expect(post.message).toBe(pre.message);
    expect(post.fingerprint).toEqual(pre.fingerprint);
    for (const key of Object.keys(pre.tags)) {
      expect(post.tags[key]).toBe(pre.tags[key]);
    }
  });

  it('the added attribution axes are content-safe fixed vocabulary', () => {
    const env = manualSessionTerminateEnvelope('post-fix');
    for (const value of [env.tags.windows_terminator, env.extras.session_end_latch]) {
      expect(value).toMatch(MANUAL_CONTENT_SAFE);
    }
  });
});

/**
 * Pre-runner (first-push phase) attribution (HQ-DESKTOP-64).
 *
 * A manual-sync runner exit that a FIRST-PUSH fault preceded — most importantly a
 * `/sts/vend-child` HTTP 403 — shipped unattributable: the fault was captured as a
 * separate event and never reached RunTotals, so the exit event carried no
 * pre-runner evidence. This fix records the fault into two DEDICATED rollups that
 * are NOT fingerprint inputs, plus the fingerprint-safe runner_error_http axis.
 * These source contracts pin that wiring at both capture seams and the egress
 * guard, following the same fixture-backed pattern as the block above.
 */
describe('pre-runner (first-push) attribution — HQ-DESKTOP-64', () => {
  it('records pre-runner failures on BOTH first-push legs before RunTotals exists', () => {
    // The whole first-push phase region of start_sync: the accumulator declaration
    // through the fold into RunTotals. Both failure arms must record into it.
    const firstPushPhase = sliceBetween(
      syncSource,
      'let mut pre_runner_failures: Vec<(PreRunnerSite',
      'initial.record_pre_runner_failure(*site, *status, *cause);',
      'first-push phase',
    );
    // Company leg records the typed failure...
    expect(firstPushPhase).toContain('pre_runner_failures.push((PreRunnerSite::FirstPush, failure.status, failure.cause));');
    // ...personal leg records site=first_push_personal with no typed detail.
    expect(firstPushPhase).toContain('PreRunnerSite::FirstPushPersonal,');
    // ...and the accumulated failures are folded into this run's RunTotals.
    expect(firstPushPhase).toContain('record_pre_runner_failure(*site, *status, *cause)');
  });

  it('routes the company first-push capture through the expected-ACL-scope predicate', () => {
    const companyArm = sliceBetween(
      syncSource,
      'if let Err(failure) = crate::commands::first_push::first_push_company(',
      'EVENT_SYNC_COMPANY_FIRST_PUSH_FAILED',
      'company first-push arm',
    );
    // Expected ACL-scope skips are suppressed (evidence rides the exit event); every
    // other failure keeps a content-safe capture on a fixed fingerprint + constant msg.
    expect(companyArm).toContain('is_expected_acl_scope_skip(&failure.message)');
    expect(companyArm).toContain('FIRST_PUSH_FAILED_CAPTURE_MESSAGE');
    expect(companyArm).toContain('"first-push-failed"');
    // The verbatim server body must NOT be captured — only the constant message is.
    expect(companyArm).not.toContain('format!("first-push failed: {e}")');
  });

  it('emits the two pre-runner axes only under Some-gating, beside the sibling axes', () => {
    const telemetryContext = sliceBetween(
      syncSource,
      'fn runner_exit_telemetry_context(',
      'fn capture_runner_exit_error(',
      'runner_exit_telemetry_context',
    );
    expect(telemetryContext).toContain('if let Some(failures) = totals.pre_runner_failures.tag_value() {');
    expect(telemetryContext).toContain('tags.push(("pre_runner_failures", failures));');
    expect(telemetryContext).toContain('if let Some(causes) = totals.pre_runner_causes.tag_value() {');
    expect(telemetryContext).toContain('tags.push(("pre_runner_causes", causes));');
  });

  it('record_pre_runner_failure touches NO fingerprint input and NO disposition flag', () => {
    // Slice the method BODY only (signature through its last statement), so the
    // doc comment above it — which necessarily NAMES the forbidden fields in prose —
    // is excluded and the assertions are about executable code, not comments.
    const recorder = sliceBetween(
      coreSource,
      'pub fn record_pre_runner_failure(',
      '.record_status(RunnerErrorHttpStatus::from_status(status));',
      'record_pre_runner_failure body',
    );
    // Writes the two dedicated rollups + the fingerprint-safe http axis.
    expect(recorder).toContain('self.pre_runner_failures.record(site);');
    expect(recorder).toContain('self.pre_runner_causes.record(cause);');
    expect(recorder).toContain('self.runner_error_http');
    // NEVER the three exit-fingerprint rollups (elements 4/5/6) — the review blocker.
    expect(recorder).not.toContain('runner_error_rollup');
    expect(recorder).not.toContain('runner_error_causes');
    expect(recorder).not.toContain('runner_error_sites');
    // NEVER a disposition flag.
    expect(recorder).not.toContain('saw_error');
    expect(recorder).not.toContain('saw_alertable_error');
    expect(recorder).not.toContain('saw_node_too_old');
  });

  it('defines the pre-runner vocabularies with denylist-safe tokens', () => {
    // Producer enums live in the shared classifier module.
    expect(shapeSource).toContain('pub enum PreRunnerSite');
    expect(shapeSource).toContain('pub enum PreRunnerCause');
    expect(shapeSource).toContain('"scope_exceeds_parent"');
    expect(shapeSource).toContain('"first_push"');
    // No emitted token may collide with a Sentry default-scrubber denylist substring.
    const siteTokens = sliceBetween(shapeSource, 'impl PreRunnerSite {', 'pub enum PreRunnerCause', 'PreRunnerSite tokens');
    const causeTokens = sliceBetween(shapeSource, 'impl PreRunnerCause {', 'PreRunnerSiteRollup', 'PreRunnerCause tokens');
    for (const denied of DENYLIST) {
      expect(siteTokens).not.toMatch(new RegExp(`"[^"]*${denied}[^"]*"`));
      expect(causeTokens).not.toMatch(new RegExp(`"[^"]*${denied}[^"]*"`));
    }
  });

  it('pins the two new tag keys to closed-vocabulary egress arms', () => {
    // Emitter (sync.rs) and egress guard (hq-telemetry) cannot drift: both keys are
    // registered as closed-vocab count rollups, so a producer bug fails CLOSED.
    expect(telemetrySource).toContain('const PRE_RUNNER_SITE_TOKENS');
    expect(telemetrySource).toContain('const PRE_RUNNER_CAUSE_TOKENS');
    expect(telemetrySource).toContain('"pre_runner_failures" =>');
    expect(telemetrySource).toContain('"pre_runner_causes" =>');
    expect(telemetrySource).toContain('is_closed_vocab_count_rollup(value, PRE_RUNNER_SITE_TOKENS)');
    expect(telemetrySource).toContain('is_closed_vocab_count_rollup(value, PRE_RUNNER_CAUSE_TOKENS)');
    // Neither key nor any of its tokens may carry a denylist substring.
    for (const denied of DENYLIST) {
      expect('pre_runner_failures').not.toContain(denied);
      expect('pre_runner_causes').not.toContain(denied);
    }
  });
});

/**
 * unknown_unnamed residual instrumentation (HQ-DESKTOP-61/62).
 *
 * A runner exit whose ndjson error records classified `unknown_unnamed` — no leading
 * identity to name, and so no `runner_error_cause_signature` — shipped a dead end:
 * `causes=unknown_unnamed:N` with zero correlatable identity, and because every
 * message byte is redacted before Sentry, no sample could ever ground new vocabulary.
 * This fix adds two DEDICATED, non-fingerprint axes fed ONLY from that residual: a
 * closed-vocabulary structural PROFILE census and an offline-decodable residual
 * SIGNATURE. These source contracts pin that wiring at both capture seams, the
 * record_error feed, and the egress guard, following the same fixture-backed pattern
 * as the blocks above.
 */
describe('unknown_unnamed residual instrumentation — HQ-DESKTOP-61/62', () => {
  it('feeds both residual rollups ONLY from the UnknownUnnamed branch, touching no fingerprint input or disposition flag', () => {
    // Slice the gated feed block only (the `if` through its second record call), so the
    // doc comment above it — which necessarily NAMES the forbidden fields in prose — is
    // excluded and the assertions are about executable code, not comments.
    const residualFeed = sliceBetween(
      coreSource,
      'if classify_runner_error_cause(&err.message) == RunnerErrorCause::UnknownUnnamed {',
      'self.runner_error_residual_signature.record(&err.message);',
      'record_error residual feed',
    );
    // Writes the two dedicated residual rollups …
    expect(residualFeed).toContain('self.runner_error_unknown_profiles.record(&err.message);');
    expect(residualFeed).toContain('self.runner_error_residual_signature.record(&err.message);');
    // … and NEVER the three exit-fingerprint rollups (elements 4/5/6) …
    expect(residualFeed).not.toContain('runner_error_rollup');
    expect(residualFeed).not.toContain('runner_error_causes');
    expect(residualFeed).not.toContain('runner_error_sites');
    // … and NEVER a disposition flag.
    expect(residualFeed).not.toContain('saw_error');
    expect(residualFeed).not.toContain('saw_alertable_error');
    expect(residualFeed).not.toContain('saw_node_too_old');
  });

  it('emits both residual axes Some-gated at the manual seam, beside the sibling axes', () => {
    const telemetryContext = sliceBetween(
      syncSource,
      'fn runner_exit_telemetry_context(',
      'fn capture_runner_exit_error(',
      'runner_exit_telemetry_context',
    );
    expect(telemetryContext).toContain(
      'if let Some(profiles) = totals.runner_error_unknown_profiles.tag_value() {',
    );
    expect(telemetryContext).toContain('tags.push(("runner_error_unknown_profiles", profiles));');
    expect(telemetryContext).toContain(
      'if let Some(signature) = totals.runner_error_residual_signature.tag_value() {',
    );
    expect(telemetryContext).toContain('tags.push(("runner_error_residual_signature", signature));');
  });

  it('emits both residual axes Some-gated at the watcher seam from the SAME shared totals', () => {
    // Assignment from the shared RunTotals (both seams read the same source) …
    expect(daemonSource).toContain(
      'runner_error_unknown_profiles: totals.runner_error_unknown_profiles.tag_value(),',
    );
    expect(daemonSource).toContain(
      'runner_error_residual_signature: totals.runner_error_residual_signature.tag_value(),',
    );
    // … and the Some-gated tag pushes on the watcher capture.
    expect(daemonSource).toContain('if let Some(profiles) = &context.runner_error_unknown_profiles {');
    expect(daemonSource).toContain('tags.push(("runner_error_unknown_profiles", profiles.clone()));');
    expect(daemonSource).toContain(
      'if let Some(signature) = &context.runner_error_residual_signature {',
    );
    expect(daemonSource).toContain('tags.push(("runner_error_residual_signature", signature.clone()));');
  });

  it('defines the profile classifier + residual signature in the shared classifier module', () => {
    expect(shapeSource).toContain('pub enum RunnerErrorUnknownProfile');
    expect(shapeSource).toContain('pub fn classify_runner_error_unknown_profile(');
    expect(shapeSource).toContain('pub fn runner_error_residual_signature(');
    expect(shapeSource).toContain('pub struct RunnerErrorUnknownProfileRollup');
    expect(shapeSource).toContain('pub struct RunnerErrorResidualSignatureRollup');
  });

  it('pins both new keys AND the first-push capture keys to egress arms (emitter<->guard binding)', () => {
    // The two residual axes are registered — the profile as a closed-vocab count
    // rollup, the signature reusing the hex12 validator — so a producer bug fails CLOSED.
    expect(telemetrySource).toContain('const RUNNER_ERROR_UNKNOWN_PROFILE_TOKENS');
    expect(telemetrySource).toContain(
      '"runner_error_unknown_profiles" => Some(is_closed_vocab_count_rollup(',
    );
    expect(telemetrySource).toContain(
      '"runner_error_residual_signature" => Some(is_runner_error_cause_signature_rollup(value)),',
    );
    // The first-push CAPTURE's two single-value keys (step 2) are registered too, so a
    // producer bug on that separate event degrades to [Filtered] like every sibling.
    expect(telemetrySource).toContain('"pre_runner_cause" => Some(PRE_RUNNER_CAUSE_TOKENS.contains(&value)),');
    expect(telemetrySource).toContain('"pre_runner_status" => Some(is_pre_runner_status(value)),');
  });

  it('keeps every residual profile token and new key name off the Sentry denylist', () => {
    const profileTokens = sliceBetween(
      telemetrySource,
      'const RUNNER_ERROR_UNKNOWN_PROFILE_TOKENS',
      '];',
      'RUNNER_ERROR_UNKNOWN_PROFILE_TOKENS',
    );
    for (const denied of DENYLIST) {
      expect(profileTokens).not.toMatch(new RegExp(`"[^"]*${denied}[^"]*"`));
      for (const key of [
        'runner_error_unknown_profiles',
        'runner_error_residual_signature',
        'pre_runner_cause',
        'pre_runner_status',
      ]) {
        expect(key).not.toContain(denied);
      }
    }
  });

  it('throws when an anchor is moved, so a relocated emission fails loudly', () => {
    expect(() =>
      sliceBetween(coreSource, 'a start anchor that does not exist anywhere', '};', 'guard'),
    ).toThrow();
  });
});
