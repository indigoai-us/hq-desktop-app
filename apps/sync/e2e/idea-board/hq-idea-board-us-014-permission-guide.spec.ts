// hq-idea-board US-014 — guided screen-recording permission onboarding.
//
// SOURCE-CONTRACT SPEC. macOS TCC state cannot be automated: the Screen
// Recording grant is a SIP-protected system security setting and the consent
// dialog is owned by the OS, so none of these three acceptance tests can be
// driven end to end in CI. What IS assertable — and what actually decides
// whether the feature works — is the seam:
//
//   chord + denied      -> permission_guide_shown, panel window, no capture
//   panel open + grant  -> poller resumes show_overlay with no second chord
//   panel dismissed     -> next chord falls back to the existing banner,
//                          and every exit path hides the window
//
// The truth tables themselves live in the Rust unit tests
// `hq_idea_board_denial_response_truth_table` and
// `hq_idea_board_guide_poll_truth_table`; the rendered panel is covered by
// src/components/capture/hq-idea-board-us-014-permission-guide.test.ts.
//
// Per repo policy hq-desktop-app-source-contract-specs-retarget-with-edits,
// these assertions are structural (identifier + shape) rather than whole-line
// literals — but if the seam moves, retarget this spec in the same commit.
//
// NEEDS A LIVE DRIVE (blocked, same blocker as US-004): confirming that the
// dragged .app actually lands in the Screen Recording list and that the
// resumed overlay appears without a second chord requires a human to grant
// the permission on a real machine. See the US-004 spec header.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const captureRs = read('src-tauri/src/commands/capture.rs');
const mainRs = read('src-tauri/src/main.rs');
const mainTs = read('src/main.ts');
const guide = read('src/components/capture/PermissionGuide.svelte');
const capability = JSON.parse(read('src-tauri/capabilities/permission-guide.json'));

/** Body of a Rust fn, from its signature to the next top-level `fn`. */
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end < 0 ? rest.length : end);
}

describe('US-014 e2e-1: denied chord opens the guided panel, writes nothing', () => {
  it('routes the denial through the guided panel before any capture can start', () => {
    const body = fnBody(captureRs, 'pub fn on_capture_chord');
    const gate = body.indexOf('screen_capture_allowed()');
    const show = body.indexOf('show_overlay(');
    expect(gate).toBeGreaterThanOrEqual(0);
    // Still gated before the show hop (US-004's contract holds): the denied
    // branch returns, so no overlay, no release, no record.
    expect(gate).toBeLessThan(show);
    const denied = body.slice(gate, show);
    expect(denied).toContain('MARK_PERMISSION_DENIED');
    expect(denied).toContain('denial_response(');
    expect(denied).toContain('DenialResponse::Guide => show_permission_guide(app)');
    expect(denied).toContain('DenialResponse::Banner => prompt_for_screen_recording(app)');
    expect(denied).toContain('return;');
  });

  it('opens a real always-on-top panel window and the pane it guides to', () => {
    const setup = fnBody(captureRs, 'pub fn setup_permission_guide_window');
    expect(setup).toContain('.always_on_top(true)');
    expect(setup).toContain('.visible(false)');
    expect(setup).toContain('.focusable(false)');
    expect(captureRs).toMatch(/GUIDE_WINDOW_LABEL: &str = "permission-guide"/);
    expect(mainRs).toContain('commands::capture::setup_permission_guide_window(app)');
    expect(mainTs).toContain("windowLabel === 'permission-guide'");
    // The panel opens the Screen Recording pane itself (AC2) and also keeps
    // an explicit button, using the same deep link US-004's banner uses.
    const show = fnBody(captureRs, 'fn show_permission_guide');
    expect(show).toContain('permissions_open_settings("screen-capture".to_string())');
    expect(show).toContain('tauri::async_runtime::spawn');
    expect(guide).toMatch(
      /invoke\('permissions_open_settings',\s*\{\s*permission:\s*'screen-capture'\s*\}\)/,
    );
    // ...and it parks beside that centred window rather than in a corner.
    expect(captureRs).toContain('SETTINGS_WINDOW_W');
  });

  it('hands the user a drag source and a copy-path fallback', () => {
    expect(guide).toContain('draggable="true"');
    expect(guide).toContain("setData('text/uri-list'");
    expect(guide).toContain('data-testid="copy-path"');
    // The panel is re-armed for the keyboard on every show, not only on its
    // first mount — the window is pre-rendered once and Rust drops
    // focusability on each hide.
    const stateListener = guide.slice(guide.indexOf('listen<unknown>(EVENT_STATE'));
    expect(stateListener.slice(0, 600)).toContain('enableKeyboard()');
    // The drag target is the .app bundle, not the raw binary inside it.
    expect(captureRs).toContain('hq_platform::permissions::screen_capture_grant_path()');
  });
});

describe('US-014 e2e-2: a grant while the panel is open resumes the capture', () => {
  it('polls the preflight and resumes show_overlay with no second chord', () => {
    const poller = fnBody(captureRs, 'fn start_guide_poller');
    expect(poller).toContain('GUIDE_POLL_INTERVAL_MS');
    expect(poller).toContain('screen_capture_preflight()');
    expect(poller).toContain('guide_poll(open, granted)');
    // Resume arm: mark, tear the panel down, then re-enter the same overlay
    // path the chord would have taken.
    const resume = poller.slice(poller.indexOf('GuidePoll::Resume'));
    expect(resume).toContain('MARK_GUIDE_GRANTED');
    expect(resume).toContain('hide_permission_guide(&app)');
    expect(resume).toContain('MARK_GUIDE_RESUMED');
    expect(resume).toContain('show_overlay(&app_main)');
    // The resume claims the panel atomically, so a dismiss that landed during
    // the preflight syscall wins and no abandoned capture is resurrected.
    expect(resume.indexOf('GUIDE_OPEN.swap(false, Ordering::SeqCst)')).toBeGreaterThanOrEqual(0);
    expect(resume.indexOf('GUIDE_OPEN.swap(false, Ordering::SeqCst)')).toBeLessThan(
      resume.indexOf('show_overlay(&app_main)'),
    );
    expect(captureRs).toMatch(
      /MARK_GUIDE_RESUMED: &str = "idea\.capture\.permission_guide_resumed"/,
    );
  });

  it('keeps the permission check off the release->PNG critical path', () => {
    // US-001/US-002 latency guards: the only permission work sits in the
    // chord gate and the panel's own poller — never between MARK_RELEASE and
    // MARK_PNG_WRITTEN.
    const store = fnBody(captureRs, 'fn capture_and_store(');
    for (const forbidden of [
      'screen_capture_preflight',
      'request_screen_capture_access',
      'denial_response',
      'show_permission_guide',
      'permission_guide_state_inner',
    ]) {
      expect(store, `${forbidden} must not run on the capture path`).not.toContain(forbidden);
    }
    const release = fnBody(captureRs, 'pub async fn capture_region_release');
    expect(release).not.toContain('screen_capture_preflight');
    expect(release).not.toContain('show_permission_guide');
  });
});

describe('US-014 e2e-3: dismiss falls back to the banner and leaves nothing stuck', () => {
  it('arms the banner fallback on dismissal', () => {
    const dismiss = fnBody(captureRs, 'pub fn dismiss_permission_guide');
    expect(dismiss).toContain('GUIDE_DISMISSED.store(true');
    expect(dismiss).toContain('MARK_GUIDE_DISMISSED');
    expect(dismiss).toContain('hide_permission_guide(&app)');
    // ...and the chord reads that flag to choose the banner next time.
    const chord = fnBody(captureRs, 'pub fn on_capture_chord');
    expect(chord).toContain('GUIDE_DISMISSED.load(');
    expect(chord).toContain('DenialResponse::Banner');
    expect(chord).toContain('prompt_for_screen_recording(app)');
  });

  it('tears the window down on dismissal, on panel failure, and on app quit', () => {
    const hide = fnBody(captureRs, 'fn hide_permission_guide');
    expect(hide).toContain('GUIDE_OPEN.store(false');
    expect(hide).toContain('window.hide()');
    expect(captureRs).toContain('pub fn shutdown_permission_guide');
    expect(mainRs).toContain('commands::capture::shutdown_permission_guide(&_app_handle)');
    // A rejected main-thread hop is the one way a visible panel could outlive
    // its flag, so neither show nor hide may swallow it.
    expect(fnBody(captureRs, 'fn hide_permission_guide')).toContain('if let Err(e) = hop');
    // A panel that cannot be shown must not leave the flag set, and must
    // still give the user the banner.
    const show = fnBody(captureRs, 'fn show_permission_guide');
    expect(show).toContain('GUIDE_OPEN.store(false, Ordering::SeqCst)');
    expect(show).toContain('prompt_for_screen_recording(&app_main)');
  });

  it('never asks for the permission at launch', () => {
    // The one-shot macOS prompt is spent only on genuine capture intent.
    expect(mainRs).not.toContain('request_screen_capture_access');
    const setup = fnBody(captureRs, 'pub fn setup_permission_guide_window');
    expect(setup).not.toContain('request_screen_capture_access');
    expect(setup).not.toContain('screen_capture_preflight');
  });

  it('grants the panel window a capability covering the events it receives', () => {
    expect(capability.identifier).toBe('permission-guide');
    expect(capability.windows).toEqual(['permission-guide']);
    expect(capability.permissions).toContain('core:default');
    expect(capability.permissions).toContain('core:event:default');
    // Every command the panel invokes must actually be registered, or the
    // user is stuck in a window whose buttons reject at runtime.
    for (const cmd of [
      'commands::capture::permission_guide_ready',
      'commands::capture::set_permission_guide_focusable',
      'commands::capture::dismiss_permission_guide',
    ]) {
      expect(mainRs, `${cmd} is not in generate_handler!`).toContain(cmd);
    }
  });
});
