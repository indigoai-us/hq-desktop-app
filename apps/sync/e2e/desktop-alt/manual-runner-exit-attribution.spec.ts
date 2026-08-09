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
 * The Rust suites pin the seam from the inside (crates/hq-desktop-core,
 * crates/hq-telemetry, and a real-child artifact test in commands::sync that
 * drives the production capture path end to end). This spec pins the same
 * property at the *source-contract* level, following the fixture-backed pattern
 * of watcher-stall-teardown-attribution.spec.ts: the additive attribution must
 * be wired at BOTH capture seams from the one shared hq-desktop-core source, and
 * the breadcrumb renderer must not emit a denylist-colliding token. Every
 * assertion slices the exact function that ships, so deleting or relocating an
 * emission fails here — the guard is not vacuous.
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
    expect(captureContext).toContain('totals.runner_error_scope()');
    expect(captureContext).toContain('classify_runner_stack_input(stderr_tail)');
  });

  it('emits the shape and path-root tags alongside the class/op rollups', () => {
    const tagAssembly = sliceBetween(
      daemonSource,
      'if let Some(rollup) = &context.runner_error_rollup {',
      'if code == Some(WINDOWS_SESSION_TERMINATE_EXIT)',
      'watcher tag assembly',
    );
    expect(tagAssembly).toContain('"runner_error_shapes"');
    expect(tagAssembly).toContain('"runner_error_path_roots"');
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
});
