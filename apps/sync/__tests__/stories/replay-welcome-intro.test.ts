// "Replay welcome intro" must actually play the film, from either entry point.
//
// Regression (reported on v0.10.289): clicking the menu-bar item did nothing.
// The film renders only in `main`, which is a hidden controller for a signed-in
// person (PL-06), and the frontend's reaction to `tray:replay-intro` was to
// invoke `show_main_window` — a command that, despite its name, opens the
// DESKTOP window. So the sheet mounted in a window nobody could see.
//
// The window work now lives in one Rust path, `tray::begin_replay_intro`, which
// every trigger calls: the native helper menu, the in-process tray menu, and the
// macOS application menu.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const app = read('src/App.svelte');
const trayRs = read('src-tauri/src/tray.rs');
const trayHelper = read('src-tauri/src/tray_helper.rs');
const updater = read('src-tauri/src/updater.rs');
const mainRs = read('src-tauri/src/main.rs');
const swiftHelper = read('src-tauri/helper/hq-tray-helper.swift');

describe('replay welcome intro: the film reaches a window the user can see', () => {
  it('brings `main` to the front before telling it to play', () => {
    const start = trayRs.indexOf('pub fn begin_replay_intro');
    expect(start).toBeGreaterThan(-1);
    const body = trayRs.slice(start, trayRs.indexOf('pub fn end_replay_intro'));
    // AppKit window ops from the helper poll thread / menu callbacks.
    expect(body).toContain('run_on_main_thread');
    // Front the onboarding window FIRST; the emit is useless on a hidden window.
    expect(body.indexOf('show_onboarding_window')).toBeGreaterThan(-1);
    expect(body.indexOf('show_onboarding_window')).toBeLessThan(
      body.indexOf('emit_to("main", "tray:replay-intro"'),
    );
    // Remember the surface to hand back to when the film ends.
    expect(body).toContain('get_webview_window("desktop-alt")');
    expect(body).toContain('REPLAY_RESTORE_DESKTOP.store');
  });

  it('restores the desktop window the replay covered', () => {
    const start = trayRs.indexOf('pub fn end_replay_intro');
    const body = trayRs.slice(start, start + 600);
    expect(body).toContain('REPLAY_RESTORE_DESKTOP.swap');
    expect(body).toContain('hide_onboarding_window');
    expect(body).toContain('show_desktop_window');
    expect(trayRs).toContain('pub fn finish_replay_intro(app: AppHandle)');
    expect(mainRs).toContain('tray::finish_replay_intro');
  });

  it('routes every entry point through the one code path', () => {
    // Native macOS helper menu → .tray-cmd → tray_helper relay.
    expect(swiftHelper).toContain('writeCommand("replay-intro")');
    expect(trayHelper).toMatch(
      /"replay-intro" => \{\s*crate::tray::begin_replay_intro\(&app\);/,
    );
    // The bare emit was the bug — it must not come back.
    expect(trayHelper).not.toContain('emit_to("main", "tray:replay-intro"');
    // In-process (non-macOS) tray menu.
    expect(trayRs).toMatch(
      /id == MENU_REPLAY_INTRO => \{\s*begin_replay_intro\(&app_handle\);/,
    );
    // macOS application menu.
    expect(updater).toMatch(
      /id == MENU_REPLAY_INTRO_ID \{\s*crate::tray::begin_replay_intro\(handle\);/,
    );
  });

  it('adds the item to the HQ application menu directly after Recovery…', () => {
    expect(updater).toContain('pub const MENU_REPLAY_INTRO_ID: &str = "app-menu:replay-intro";');
    expect(updater).toContain(
      'MenuItemBuilder::with_id(MENU_REPLAY_INTRO_ID, crate::tray::REPLAY_INTRO_LABEL)',
    );
    expect(updater).toMatch(/\.item\(&recovery_item\)\s*\.item\(&replay_intro_item\)\s*\.separator\(\)/);
    // One label for the menu-bar item and the app-menu item.
    expect(trayRs).toContain('pub const REPLAY_INTRO_LABEL: &str = "Replay welcome intro";');
    expect(trayRs).toContain('MenuItemBuilder::with_id(MENU_REPLAY_INTRO, REPLAY_INTRO_LABEL)');
  });

  it('leaves the frontend to render only — no window commands on the event', () => {
    const start = app.indexOf("listen('tray:replay-intro'");
    expect(start).toBeGreaterThan(-1);
    const handler = app.slice(start, start + 600);
    expect(handler).toContain('replayIntro = true');
    // The bug: this sent the film to the desktop window.
    expect(handler).not.toContain("invoke('show_main_window')");
  });

  it('renders the replay sheet ahead of the signed-in shell and hands back on finish', () => {
    const replayBranch = app.indexOf('{:else if replayIntro}');
    const signedInBranch = app.indexOf('{:else if authenticated}');
    expect(replayBranch).toBeGreaterThan(-1);
    // A signed-in person is the one who replays; the empty PL-06 shell must not
    // win the branch race.
    expect(replayBranch).toBeLessThan(signedInBranch);
    const branch = app.slice(replayBranch, signedInBranch);
    expect(branch).toContain('mode="replay"');
    expect(branch).toContain('replayIntro = false');
    expect(branch).toContain("invoke('finish_replay_intro')");
  });
});
