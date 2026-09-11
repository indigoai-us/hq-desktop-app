// hq-idea-board US-004, acceptance test 2: Screen Recording denied -> no
// overlay, a prompt with a Settings link instead.
//
// SOURCE-CONTRACT SPEC. macOS TCC denial cannot be automated: granting or
// revoking Screen Recording is a system security setting, the TCC database is
// SIP-protected, and the consent dialog is owned by the OS. So this spec does
// not drive the app — it asserts the decision seam in source, end to end:
//
//   chord -> permission_gate() before show_overlay()
//         -> denied: idea.capture.permission_denied + a kind:"capture" banner
//            carrying the "open-settings" action
//         -> App.svelte routes that banner to permissions_open_settings
//            with 'screen-capture'
//         -> settings_url("screen-capture") deep-links Privacy_ScreenCapture
//
// The truth table of the gate itself is covered by the Rust unit test
// `hq_idea_board_permission_gate_truth_table` in commands/capture.rs.
//
// Per repo policy hq-desktop-app-source-contract-specs-retarget-with-edits,
// these assertions are deliberately structural (identifier + shape) rather
// than whole-line literals, so an unrelated reformat does not break them —
// but if the seam itself moves, retarget this spec in the same commit.
//
// NOT IN THIS FILE: acceptance tests 1 and 3 (drag -> 400x300 PNG + pending
// record; provenance.app / provenance.window_title populated). Those require a
// live-driven log fixture and a real record.json from the running app, and the
// drive is currently blocked — the debug binary at
// apps/sync/src-tauri/target/debug/hq-sync-menubar is not granted Screen
// Recording, so every chord logs `idea.capture.permission_denied` and no
// capture ever runs. Fixtures must be real app output, never synthesized.
// To unblock: grant that binary Screen Recording in System Settings ›
// Privacy & Security › Screen Recording, then re-drive (see the US-003 spec
// header for the procedure; for US-004 press the chord and drag with
// `cliclick dd:100,100 m:300,250 du:500,400`, 25 cycles, then 3 no-drag
// clicks and one Escape) and slice the new [idea] lines into
// fixtures/hq-idea-board-us-004-region-capture-live-macos.txt.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const captureRs = read('src-tauri/src/commands/capture.rs');
const permissionsRs = read('src-tauri/src/commands/permissions.rs');
const appSvelte = read('src/App.svelte');

describe('US-004 Screen Recording denied -> no overlay, Settings prompt (source contract)', () => {
  it('gates the chord on the permission decision BEFORE the overlay is shown', () => {
    const chordFn = captureRs.slice(captureRs.indexOf('pub fn on_capture_chord'));
    const body = chordFn.slice(0, chordFn.indexOf('\npub fn ', 1));

    const gateIdx = body.indexOf('screen_capture_allowed()');
    const showIdx = body.indexOf('show_overlay(');
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(showIdx).toBeGreaterThanOrEqual(0);
    // The gate is evaluated first, and the denied branch returns before the
    // show hop: an overlay you can drag on but that can never produce an
    // image is worse than no overlay at all.
    expect(gateIdx).toBeLessThan(showIdx);
    expect(body.slice(gateIdx, showIdx)).toContain('return;');

    // ...and screen_capture_allowed is the platform wiring of the pure gate.
    expect(captureRs).toMatch(/fn screen_capture_allowed\(\)[\s\S]{0,200}permission_gate\(/);
    expect(captureRs).toMatch(/pub fn permission_gate\(\s*preflight: bool/);
  });

  it('marks the denial and raises a capture banner with an open-settings action', () => {
    const chordFn = captureRs.slice(captureRs.indexOf('pub fn on_capture_chord'));
    const body = chordFn.slice(0, chordFn.indexOf('\npub fn ', 1));
    expect(body).toContain('MARK_PERMISSION_DENIED');
    expect(body).toContain('prompt_for_screen_recording(app)');
    expect(captureRs).toMatch(
      /MARK_PERMISSION_DENIED: &str = "idea\.capture\.permission_denied"/,
    );

    const prompt = captureRs.slice(captureRs.indexOf('fn prompt_for_screen_recording'));
    const promptBody = prompt.slice(0, prompt.indexOf('\nfn ', 1));
    expect(promptBody).toMatch(/kind:\s*BANNER_KIND\.to_string\(\)/);
    expect(captureRs).toMatch(/BANNER_KIND: &str = "capture"/);
    expect(promptBody).toMatch(/action_id:\s*Some\(BANNER_ACTION_OPEN_SETTINGS/);
    expect(promptBody).toMatch(/click_action_id:\s*BANNER_ACTION_OPEN_SETTINGS/);
    expect(captureRs).toMatch(/BANNER_ACTION_OPEN_SETTINGS: &str = "open-settings"/);
    // The banner carries the permission the frontend will open.
    expect(promptBody).toMatch(/"permission":\s*"screen-capture"/);
    // It is a prompt with a Settings link, not a silent failure.
    expect(promptBody).toMatch(/action_label:\s*Some\("Open Settings"/);
  });

  it("routes a 'capture' banner's open-settings action to the screen-capture pane", () => {
    const captureBranch = appSvelte.slice(appSvelte.indexOf("kind === 'capture'"));
    const branch = captureBranch.slice(0, 600);
    expect(branch).toContain("action === 'open-settings'");
    expect(branch).toMatch(
      /invoke\('permissions_open_settings',\s*\{\s*permission:\s*'screen-capture'\s*\}\)/,
    );
  });

  it('deep-links screen-capture to the Privacy_ScreenCapture settings pane', () => {
    const fn = permissionsRs.slice(permissionsRs.indexOf('fn settings_url('));
    const body = fn.slice(0, fn.indexOf('\nfn ', 1));
    const arm = body.slice(body.indexOf('"screen-capture" =>'));
    expect(arm).toMatch(
      /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_ScreenCapture/,
    );
  });
});
