import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/** The source of one Rust fn, from its signature to its matching close brace. */
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${signature} has no closing brace`);
}

/**
 * Signed-out users must still be able to open the desktop workspace and
 * reach Google/Microsoft sign-in inside that window — not a deleted classic
 * popover-only path, and not a gate that refuses `open_desktop_alt_window`.
 */
describe('signed-out users open the desktop workspace for sign-in', () => {
  const rust = readRepoFile('src-tauri/src/commands/desktop_alt.rs');
  const tray = readRepoFile('src-tauri/src/tray.rs');
  const app = readRepoFile('src/App.svelte');
  const shell = readRepoFile('src/desktop-alt/HqWorkWorkShell.svelte');
  const signIn = readRepoFile('src/components/SignInPrompt.svelte');
  const auth = readRepoFile('src-tauri/src/commands/auth.rs');

  it('does not gate open_desktop_alt_window on a signed-in session', () => {
    // The open path ends in a fresh build of the desktop-alt window. The
    // builder lives in `build_desktop_alt_window` (shared with the first-run
    // handoff), so the open body must reach it with no signed-in gate on the
    // way, and the builder body must construct the window through the Tauri
    // builder with the desktop-alt label.
    const body = fnBody(rust, 'pub async fn open_desktop_alt_window_inner(');
    expect(rust).not.toContain('desktop-alt requires a signed-in user');
    expect(body).not.toContain('desktop_alt_enabled()');
    expect(body).toContain('app.get_webview_window(WINDOW_LABEL)');
    expect(body).toMatch(/\n {4}build_desktop_alt_window\(&app, route\)\n\}$/);

    const builder = fnBody(rust, 'fn build_desktop_alt_window(');
    expect(builder).not.toContain('desktop_alt_enabled()');
    expect(builder).toMatch(/tauri::WebviewWindowBuilder::new\(\s*app,\s*WINDOW_LABEL,/);
    expect(builder).toMatch(/\.build\(\)/);
    expect(rust).toContain('const WINDOW_LABEL: &str = "desktop-alt"');
  });

  it('hosts SignInPrompt in the workspace signed-out branch', () => {
    const idx = shell.indexOf('{:else if lifecycle === \'signed-out\'}');
    expect(idx).toBeGreaterThan(-1);
    const body = shell.slice(idx, idx + 1200);
    expect(shell).toContain("import SignInPrompt from '../components/SignInPrompt.svelte'");
    expect(body).toContain('data-testid="hq-work-signed-out"');
    expect(body).toContain('<SignInPrompt');
    expect(body).toContain('bringMainToFront={false}');
    expect(signIn).toContain('class="sign-in-card"');
    expect(signIn).toContain('Continue with {provider.label}');
    expect(signIn).toContain("'Google'");
    expect(signIn).toContain("'Microsoft'");
  });

  it('tray Open desktop view opens the workspace without a signed-in gate', () => {
    expect(tray).toContain('pub fn show_desktop_window(app: &AppHandle)');
    expect(tray).toContain(
      'crate::commands::desktop_alt::open_desktop_alt_window_inner(app_clone.clone(), None)',
    );
    expect(app).toContain("listen('tray:open-desktop'");
    expect(app).toContain("invoke('open_desktop_alt_window')");
    expect(auth).toContain('open_desktop_alt_window_inner(app, None)');
    expect(auth).not.toContain('show_onboarding_window');
  });
});
