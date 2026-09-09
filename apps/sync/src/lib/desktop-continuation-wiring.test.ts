/**
 * Source-contract guard for the native half of browser session continuation.
 *
 * `apps/sync/src-tauri` cannot be compiled on a machine without a
 * GTK/JavaScriptCore toolchain, so the Rust in `commands/desktop_auth.rs` gets
 * its first real compile in CI's macOS job and its first behavioural test
 * never — there is no harness that can drive a Tauri command here. Everything
 * decidable was pushed into `hq-desktop-core` and into
 * `desktop-session-continuation.ts`, both of which are unit-tested. What is
 * left is wiring, and wiring is exactly what a compiler will happily accept
 * while it does the wrong thing.
 *
 * Each case below corresponds to a way this feature can be wrong while every
 * other test in the repository stays green. They are string assertions, which
 * is a weak instrument; they are here because the alternative for this file is
 * no instrument.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const desktopAuth = read('src-tauri/src/commands/desktop_auth.rs');
const oauth = read('src-tauri/src/commands/oauth.rs');
const main = read('src-tauri/src/main.rs');
const adapter = read('src/lib/desktop-continuation-tauri.ts');
const signInPrompt = read('src/components/SignInPrompt.svelte');
const desktopAltCapability = read('src-tauri/capabilities/desktop-alt.json');

/** The body of a `fn`/`async fn` named `name`, up to its closing brace. */
function rustFunction(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start, `fn ${name} is not declared`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  expect(end, `fn ${name} has no closing brace`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('an attempt cannot start on a machine that must not have one', () => {
  const start = rustFunction(desktopAuth, 'desktop_continuation_start');

  it('consults the launch context before it arms anything', () => {
    // Without this, an enrolled installation opens a browser after an explicit
    // sign-out, mid-update, or on an ordinary launch that is not a first run —
    // all of which `may_start` already refuses, and none of which it was ever
    // asked about.
    expect(start).toContain('may_start(');
    expect(start.indexOf('may_start(')).toBeLessThan(start.indexOf('arm_oauth_flow('));
  });

  it('assembles every fact may_start refuses on', () => {
    const context = rustFunction(desktopAuth, 'launch_context');
    expect(context).toContain('has_valid_session');
    expect(context).toContain('signed_out_explicitly: SIGNED_OUT_THIS_SESSION');
    expect(context).toContain('attempt_in_flight');
    expect(context).toContain('update_in_progress: crate::updater::update_install_in_progress()');
    expect(context).toContain('is_first_launch');
  });

  it('treats an unreadable session as a session, not as permission', () => {
    // `get_auth_state` failing is not evidence that nobody is signed in.
    // Defaulting to false would open a browser over a live session.
    const context = rustFunction(desktopAuth, 'launch_context');
    expect(context).toMatch(/\.unwrap_or\(true\)/);
  });

  it('treats a missing launch verdict as not-a-first-launch', () => {
    const context = rustFunction(desktopAuth, 'launch_context');
    expect(context).toMatch(/LaunchKind::FirstRun[\s\S]*\.unwrap_or\(false\)/);
  });

  it('offers the same verdict before anything is written down', () => {
    // The renderer asks this before the `started` receipt. Without it, every
    // ineligible app open would emit a started/failed pair and the funnel this
    // work exists to repair would read as a flood of failures.
    const may = rustFunction(desktopAuth, 'desktop_continuation_may_start');
    expect(may).toContain('may_start(launch_context(&app).await');
    expect(main).toContain('commands::desktop_auth::desktop_continuation_may_start,');
    expect(adapter).toContain("call('desktop_continuation_may_start')");
  });

  it('latches an explicit sign-out for the life of the process', () => {
    const note = rustFunction(desktopAuth, 'note_auth_transition');
    expect(note).toContain('AttemptEnd::SignedOut');
    expect(note).toContain('SIGNED_OUT_THIS_SESSION.store(true');
  });
});

describe('a manual sign-in invalidates anything continuation is holding', () => {
  it('bumps the generation when the provider-button path completes', () => {
    // The provider buttons stay available while a "Continue as …" card is on
    // screen. Without this, a stale confirmation could land after the person
    // picked a different account and persist the browser's account over it.
    const exchange = rustFunction(oauth, 'oauth_exchange_code');
    expect(exchange).toContain('note_auth_transition(');
    expect(exchange).toContain('AttemptEnd::Superseded');
  });

  it('does it only after the exchange succeeds', () => {
    // A failed exchange is not a sign-in and must not discard a pending
    // attempt that is still perfectly valid.
    const exchange = rustFunction(oauth, 'oauth_exchange_code');
    expect(exchange.indexOf('exchange_code_for_tokens')).toBeLessThan(
      exchange.indexOf('note_auth_transition('),
    );
  });

  it('does not start a continuation once a provider button has been pressed', () => {
    expect(signInPrompt).toContain('manualSignInStarted = true;');
    const prepare = signInPrompt.slice(
      signInPrompt.indexOf('async function prepareContinuation()'),
      signInPrompt.indexOf('async function handleContinuationConfirm'),
    );
    // Checked on both sides of the config round trip: the click can land
    // during it, and arming a second flow would cancel the listener the manual
    // attempt is waiting on.
    expect(prepare.match(/manualSignInStarted/g) ?? []).toHaveLength(2);
  });
});

describe('cancelling actually cancels', () => {
  const cancel = rustFunction(desktopAuth, 'desktop_continuation_cancel');

  it('tears down the loopback listener, not just the custody entry', () => {
    // Dropping the entry alone leaves the listener holding both sockets and
    // OAUTH_FLOW_ACTIVE until a callback or the five-minute timeout, so
    // blur-hide stays suppressed and Cancel cancels nothing visible.
    expect(cancel).toContain('release_listener(');
    expect(rustFunction(desktopAuth, 'release_listener')).toContain('oauth_cancel_listen(');
  });

  it('reads the state before cancelling, because cancelling destroys it', () => {
    expect(cancel.indexOf('active_state_for(')).toBeLessThan(cancel.indexOf('custody.cancel('));
  });

  it('scopes the teardown to this attempt id', () => {
    // A late Cancel for a superseded attempt must not tear down the listener
    // the current attempt is waiting on.
    expect(cancel).toContain('active_state_for(&attempt_id)');
  });

  it('also releases the listener when the browser fails to open', () => {
    const start = rustFunction(desktopAuth, 'desktop_continuation_start');
    expect(start).toContain('release_listener(&armed.state)');
  });
});

describe('the anonymous HTTP runs natively, so it works in both windows', () => {
  it('leaves the renderer with no HTTP client at all', () => {
    // SignInPrompt is mounted in the `desktop-alt` window too, and that
    // window's capability grants no http permission. A fetch from the renderer
    // is denied there, resolves to unavailable, and continuation silently
    // never runs on the surface `hq-desktop://signin` opens.
    expect(adapter).not.toContain('@tauri-apps/plugin-http');
    expect(adapter).not.toMatch(/\bfetch\s*\(/);
  });

  it('routes both calls over the bridge', () => {
    expect(adapter).toContain("call('desktop_continuation_config')");
    expect(adapter).toContain("call('desktop_continuation_deliver'");
  });

  it('registers both commands, or the bridge answers "not found"', () => {
    expect(main).toContain('commands::desktop_auth::desktop_continuation_config,');
    expect(main).toContain('commands::desktop_auth::desktop_continuation_deliver,');
  });

  it('resolves the receipt path against an allowlist rather than concatenating it', () => {
    // The renderer chooses when a receipt is sent. It must not be able to
    // choose where: a path is enough to reach any route on that host,
    // including the authenticated ones it is deliberately kept away from.
    const deliver = rustFunction(desktopAuth, 'desktop_continuation_deliver');
    expect(deliver).toContain('receipt_url(&path)');
    expect(deliver).not.toMatch(/format!\("\{\}\{\}"/);
  });

  it('does not widen the expanded window’s capability to compensate', () => {
    const permissions = JSON.parse(desktopAltCapability).permissions as unknown[];
    expect(permissions).not.toContain('http:default');
  });
});
