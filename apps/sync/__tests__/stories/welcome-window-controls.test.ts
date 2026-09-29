// The welcome window can be minimized and closed with the standard window
// controls, so a stuck install never traps the screen.
//
// Owner request (2026-09-27): "the installer needs to be minimizable or
// closable with buttons so it doesn't just take up the screen if it gets
// stuck". The welcome flow fills the work area; while it owns `main` the window
// carries close + minimize (macOS traffic lights over an overlay title bar,
// Windows caption buttons), zoom stays off. Close only hides the window: the
// renderer, and the install running in it, keep going, and the menu-bar item or
// the Dock bring the flow back at the same screen.
//
// The pure decisions (which controls, which style mask, the blur veto) are Rust
// unit tests in welcome_window.rs and tray.rs. This file pins the wiring those
// tests cannot see.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const mainRs = read('src-tauri/src/main.rs');
const trayRs = read('src-tauri/src/tray.rs');
const trayHelper = read('src-tauri/src/tray_helper.rs');
const welcomeRs = read('src-tauri/src/welcome_window.rs');
const windowFocus = read('src-tauri/src/util/window_focus.rs');

function body(source: string, signature: string, length = 1600): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  return source.slice(start, start + length);
}

describe('welcome window: close and minimize controls', () => {
  it('puts the controls on when the welcome flow takes the window, and takes them off after', () => {
    const command = body(welcomeRs, 'pub fn set_welcome_window(');
    expect(command).toContain('apply_window_controls(&handle, enabled)');
    // First run applies them before the window is first shown.
    const firstRun = body(mainRs, 'welcome_window::set_welcome_window_active(true);', 400);
    expect(firstRun).toContain('welcome_window::apply_window_controls(&window, true)');
  });

  it('closes by hiding `main`: the close is prevented and nothing quits', () => {
    const handler = body(mainRs, 'if let tauri::WindowEvent::CloseRequested { api, .. } = event {', 900);
    const mainBranch = handler.slice(0, handler.indexOf('WINDOW_LABEL'));
    expect(mainBranch).toContain('window.label() == "main"');
    expect(mainBranch).toContain('api.prevent_close()');
    expect(mainBranch).toContain('window.hide()');
    expect(mainBranch).not.toMatch(/\.exit\(|quit_app|process::exit|request_exit/);
  });

  it('never hides the welcome window on blur, so Minimize stays a minimize', () => {
    const blur = body(trayRs, 'should_hide_onboarding_card_on_blur(BlurHideInputs {', 700);
    expect(blur).toContain('welcome_window: crate::welcome_window::welcome_window_active()');
  });
});

describe('welcome window: reopening from the menu bar and the Dock', () => {
  it('routes the Dock and the menu-bar item to the setup surface while setup owns `main`', () => {
    const reopen = body(mainRs, 'if let tauri::RunEvent::Reopen { .. } = event {', 800);
    expect(reopen).toContain('tray::activate_primary_surface(_app_handle)');
    expect(trayHelper).toContain('crate::tray::activate_primary_surface(&app_main)');
    const activate = body(trayRs, 'pub fn activate_primary_surface(app: &AppHandle) {', 400);
    expect(activate.indexOf('onboarding_window_requires_blur_suppression(app)')).toBeLessThan(
      activate.indexOf('show_onboarding_window(app)'),
    );
  });

  it('brings the welcome window back full size, restoring it from the Dock if minimized', () => {
    const show = body(trayRs, 'pub fn show_onboarding_window(app: &AppHandle) {', 1400);
    const branchStart = show.indexOf('if crate::welcome_window::welcome_window_active() {');
    expect(branchStart).toBeGreaterThan(-1);
    const welcomeBranch = show.slice(branchStart, show.indexOf('return;', branchStart));
    expect(welcomeBranch).toContain('crate::welcome_window::fit_to_work_area(&window)');
    expect(welcomeBranch).toContain('bring_webview_to_front(&window)');
    expect(welcomeBranch).toContain('raise_transiently_topmost(&window)');
    // Both raise paths go through `raise_webview`, which un-minimizes first.
    const raise = body(windowFocus, 'fn raise_webview(window: &WebviewWindow, keep_on_top: bool) {', 200);
    expect(raise.indexOf('window.unminimize()')).toBeGreaterThan(-1);
    expect(raise.indexOf('window.unminimize()')).toBeLessThan(raise.indexOf('window.show()'));
  });
});
