import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

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
    const idx = rust.indexOf('pub async fn open_desktop_alt_window_inner');
    expect(idx).toBeGreaterThan(-1);
    const body = rust.slice(idx, idx + 2500);
    expect(rust).not.toContain('desktop-alt requires a signed-in user');
    expect(body).not.toContain('if !desktop_alt_enabled().await');
    expect(body).toContain('WINDOW_LABEL');
    expect(body).toContain('tauri::WebviewWindowBuilder::new');
    expect(rust).toContain('const WINDOW_LABEL: &str = "desktop-alt"');
  });

  it('hosts SignInPrompt in the workspace signed-out branch', () => {
    const idx = shell.indexOf('lifecycle === \'signed-out\'');
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
    expect(auth).not.toContain('show_popover_window');
  });
});
