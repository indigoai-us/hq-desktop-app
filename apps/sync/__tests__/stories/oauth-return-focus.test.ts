/**
 * After browser OAuth, HQ must raise itself above Safari/Chrome on both
 * macOS and Windows. JS setFocus alone is insufficient; Rust owns the raise.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(process.cwd());

function readRepo(...parts: string[]): string {
  const path = join(repoRoot, ...parts);
  expect(existsSync(path), `missing ${parts.join('/')}`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('OAuth return focus (macOS + Windows)', () => {
  it('exposes bring_main_window_to_front and registers it', () => {
    const app = readRepo('src-tauri/src/commands/app.rs');
    const main = readRepo('src-tauri/src/main.rs');
    expect(app).toContain('pub fn bring_main_window_to_front');
    expect(app).toContain('bring_webview_to_front_after_oauth');
    expect(main).toContain('commands::app::bring_main_window_to_front');
  });

  it('window_focus raises via AppKit on macOS and Win32 on Windows', () => {
    const focus = readRepo('src-tauri/src/util/window_focus.rs');
    expect(focus).toContain('pub fn bring_webview_to_front');
    expect(focus).toContain('pub fn bring_webview_to_front_after_oauth');
    expect(focus).toContain('pub fn clear_sticky_topmost');
    expect(focus).toMatch(/#\[cfg\(target_os = "macos"\)\][\s\S]*activateIgnoringOtherApps/);
    expect(focus).toMatch(/#\[cfg\(target_os = "macos"\)\][\s\S]*makeKeyAndOrderFront/);
    expect(focus).toMatch(/#\[cfg\(target_os = "windows"\)\][\s\S]*SetForegroundWindow/);
    // Generic raise must not sticky-topmost (covers first-run before OAuth).
    const generic = focus.slice(
      focus.indexOf('pub fn bring_webview_to_front'),
      focus.indexOf('pub fn bring_webview_to_front_after_oauth'),
    );
    expect(generic).toContain('keep_on_top=*/ false');
    expect(generic).not.toContain('set_always_on_top(true)');
  });

  it('oauth_listen_for_code raises main after a successful callback', () => {
    const oauth = readRepo('src-tauri/src/commands/oauth.rs');
    expect(oauth).toContain('oauth_flow_keeps_window_visible');
    expect(oauth).toContain('clear_sticky_topmost');
    const startIdx = oauth.indexOf('pub async fn start_oauth_login');
    expect(startIdx).toBeGreaterThan(-1);
    const startBody = oauth.slice(startIdx, startIdx + 2000);
    expect(startBody).toContain('clear_sticky_topmost');
    const idx = oauth.indexOf('pub async fn oauth_listen_for_code');
    expect(idx).toBeGreaterThan(-1);
    const body = oauth.slice(idx, idx + 3500);
    expect(body).toContain('AppHandle');
    expect(body).toContain('bring_webview_to_front_after_oauth');
    expect(body).toContain('run_on_main_thread');
  });

  it('show_window_centered uses non-sticky raise (first-run before OAuth)', () => {
    const tray = readRepo('src-tauri/src/tray.rs');
    const idx = tray.indexOf('pub fn show_window_centered');
    expect(idx).toBeGreaterThan(-1);
    const body = tray.slice(idx, idx + 500);
    expect(body).toContain('bring_webview_to_front');
    expect(body).not.toContain('bring_webview_to_front_after_oauth');
    expect(body).not.toContain('set_always_on_top(true)');
  });

  it('blur-hide stays suppressed while OAuth is in flight', () => {
    const tray = readRepo('src-tauri/src/tray.rs');
    expect(tray).toContain('oauth_flow_keeps_window_visible');
    expect(tray).toMatch(
      /onboarding_window_requires_blur_suppression[\s\S]*oauth_in_flight/,
    );
  });

  it('tray toggle raises a visible but unfocused window instead of hiding it', () => {
    const tray = readRepo('src-tauri/src/tray.rs');
    const idx = tray.indexOf('pub fn toggle_popover_window');
    expect(idx).toBeGreaterThan(-1);
    const body = tray.slice(idx, idx + 900);
    expect(body).toContain('is_focused');
    expect(body).toContain('bring_webview_to_front');
  });

  it('SignInPrompt and OnboardingWizard invoke bring_main_window_to_front', () => {
    const signIn = readRepo('src/components/SignInPrompt.svelte');
    const onboarding = readRepo('src/components/onboarding/OnboardingWizard.svelte');
    expect(signIn).toContain("invoke('bring_main_window_to_front')");
    expect(signIn).not.toContain('getCurrentWindow');
    expect(onboarding).toContain("invokeCommand('bring_main_window_to_front')");
    expect(onboarding).not.toContain('getCurrentWindow');
  });
});
