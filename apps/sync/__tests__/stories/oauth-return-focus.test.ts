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

  it('oauth_listen_for_code raises the workspace window after a successful callback', () => {
    const oauth = readRepo('src-tauri/src/commands/oauth.rs');
    expect(oauth).toContain('oauth_flow_keeps_window_visible');
    expect(oauth).toContain('clear_sticky_topmost');
    const armIdx = oauth.indexOf('pub(crate) fn arm_oauth_flow');
    expect(armIdx).toBeGreaterThan(-1);
    const armBody = oauth.slice(armIdx, armIdx + 2000);
    expect(armBody).toContain('clear_sticky_topmost');
    const idx = oauth.indexOf('pub async fn oauth_listen_for_code');
    expect(idx).toBeGreaterThan(-1);
    const body = oauth.slice(idx, idx + 3500);
    expect(body).toContain('AppHandle');
    expect(body).toContain('desktop-alt');
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

  it('showing the onboarding card raises it rather than leaving it buried', () => {
    // PL-05 retired `toggle_popover_window` (the Opt+Shift+H toggle); the
    // surviving show path must still raise `main` after browser OAuth, where
    // the window is visible but buried behind the browser.
    const tray = readRepo('src-tauri/src/tray.rs');
    expect(tray).not.toContain('pub fn toggle_popover_window');
    const idx = tray.indexOf('pub fn show_onboarding_window');
    expect(idx).toBeGreaterThan(-1);
    const body = tray.slice(idx, idx + 4200);
    expect(body).toContain('bring_webview_to_front');
    expect(body).toContain('suppress_blur_hide_briefly');
  });

  it('the post-OAuth raise is transiently topmost on Windows, never sticky', () => {
    // Windows bug: after signing in, HQ stayed above every other app and
    // Alt+Tab could not bring anything in front of it until HQ was minimised.
    // `bring_webview_to_front_after_oauth` set `always_on_top(true)` and
    // nothing ever cleared it. The post-OAuth raise must now go through one
    // shared helper that drops the flag on the first focus change or after a
    // bounded timeout.
    const focus = readRepo('src-tauri/src/util/window_focus.rs');
    expect(focus).toContain('pub fn raise_transiently_topmost');
    expect(focus).toContain('pub const TRANSIENT_TOPMOST_TIMEOUT');
    const afterOauth = focus.slice(
      focus.indexOf('pub fn bring_webview_to_front_after_oauth'),
      focus.indexOf('pub fn raise_transiently_topmost'),
    );
    expect(afterOauth).toContain('raise_transiently_topmost(window)');
    expect(afterOauth).not.toContain('set_always_on_top(true)');
    // The Windows plumbing releases on focus-in, focus-out and the timer.
    const plumbing = focus.slice(focus.indexOf('mod transient_topmost'));
    expect(plumbing).toMatch(/WindowEvent::Focused\(true\)\s*=>\s*TopmostRelease::Focused/);
    expect(plumbing).toMatch(/WindowEvent::Focused\(false\)\s*=>\s*TopmostRelease::Blurred/);
    expect(plumbing).toContain('TopmostRelease::Timeout { generation }');
    expect(plumbing).toContain('set_always_on_top(false)');

    // Every remaining `set_always_on_top(true)` in window_focus.rs must sit in
    // the keep_on_top branch that only the transient helper reaches.
    const stickyCalls = focus.split('set_always_on_top(true)').length - 1;
    expect(stickyCalls).toBe(1);
    expect(focus).toMatch(/if keep_on_top \{\s*let _ = window\.set_always_on_top\(true\);/);

    // The onboarding card show path and the renderer command share the helper.
    // Comments in these files legitimately name the call they avoid, so only
    // code lines are checked.
    const codeOnly = (src: string) =>
      src
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
    const tray = readRepo('src-tauri/src/tray.rs');
    const onboardingIdx = tray.indexOf('pub fn show_onboarding_window');
    const onboarding = tray.slice(onboardingIdx, onboardingIdx + 4800);
    expect(onboarding).toContain('raise_transiently_topmost');
    expect(codeOnly(onboarding)).not.toContain('set_always_on_top(true)');
    // Nowhere in tray.rs, app.rs or oauth.rs may a window be left sticky topmost.
    expect(codeOnly(tray)).not.toContain('set_always_on_top(true)');
    const app = readRepo('src-tauri/src/commands/app.rs');
    expect(codeOnly(app)).not.toContain('set_always_on_top(true)');
    const oauth = readRepo('src-tauri/src/commands/oauth.rs');
    expect(codeOnly(oauth)).not.toContain('set_always_on_top(true)');
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
