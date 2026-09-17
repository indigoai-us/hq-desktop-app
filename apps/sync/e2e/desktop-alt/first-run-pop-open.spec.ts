import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// Locks the staged first-run contract: the rebuilt onboarding wizard owns
// completion, while sync-on-launch remains default-on for normal launches.
describe('first-run routes through onboarding before completion', () => {
  const app = readRepoFile('src/App.svelte');
  const lifecycle = readRepoFile('src/lib/lifecycle.ts');
  const onboarding = readRepoFile('src/components/Onboarding.svelte');
  // US-005: single settings surface (desktop SettingsPage; classic popover Settings gone).
  const settingsPage = readRepoFile('../../packages/ui/src/settings/SettingsPage.svelte');
  const settingsRust = readRepoFile('src-tauri/src/commands/settings.rs');
  const firstRunRust = readRepoFile('src-tauri/src/commands/first_run.rs');
  const tray = readRepoFile('src-tauri/src/tray.rs');

  it('has no onboarding components left in the tree', () => {
    expect(() => readRepoFile('src/components/FirstRunWelcome.svelte')).toThrow();
    expect(() => readRepoFile('src/components/AutoSyncNotice.svelte')).toThrow();
  });

  it('App.svelte does not import or render the legacy onboarding overlays', () => {
    expect(app).not.toContain('FirstRunWelcome');
    expect(app).not.toContain('AutoSyncNotice');
    expect(app).not.toContain('showWelcome');
    expect(app).not.toContain('showAutoSyncNotice');
  });

  it('first run renders onboarding and completion only happens from finish', () => {
    expect(lifecycle).toContain("state === 'InstalledFirstRun'");
    expect(app).not.toContain("invoke<boolean>('is_first_run')");
    expect(app).not.toContain("invoke('mark_first_run_complete')");
    expect(onboarding).toContain("invoke('mark_first_run_complete')");
  });

  it('finishing onboarding hands off to the desktop window, not the popover', () => {
    // PL-05: the wizard still calls the same command, but it now hides `main`
    // (back to hidden controller) and opens the desktop workspace.
    expect(onboarding).toContain("invoke('show_main_window_at_tray')");
    // Open the desktop window first, dismiss the card only once it opened —
    // a failed open must not leave the user with no window at all.
    expect(firstRunRust).toMatch(
      /pub async fn show_main_window_at_tray[\s\S]*?open_desktop_alt_window_inner\(app\.clone\(\), None\)\.await\?;[\s\S]*?crate::tray::hide_onboarding_window\(&app\);/,
    );
    expect(firstRunRust).not.toContain('crate::tray::show_onboarding_window(&app)');
    // The renderer no longer opens the desktop window itself and then hides
    // the card behind its back.
    expect(onboarding).not.toContain("invoke('open_desktop_alt_window')");
  });

  it('hiding the onboarding card records the dismissal', () => {
    // Otherwise the launch-time onboarding pin keeps suppressing click-away
    // for the rest of the process after the handoff.
    expect(tray).toMatch(
      /pub fn hide_onboarding_window[\s\S]*?note_onboarding_card_dismissed\(\)[\s\S]*?get_webview_window\("main"\)/,
    );
  });

  it('sync-on-launch defaults ON in the Settings surface', () => {
    expect(settingsPage).toContain('settings.syncOnLaunch ?? true');
    // And the surface does not silently fall back to OFF.
    expect(settingsPage).not.toContain('settings.syncOnLaunch ?? false');
  });

  it('sync-on-launch defaults ON in the Rust get_settings defaults', () => {
    // Fresh-install (no file) branch and the per-field default both resolve ON.
    expect(settingsRust).toContain('sync_on_launch: Some(true)');
    expect(settingsRust).toContain('prefs.sync_on_launch.unwrap_or(true)');
    expect(settingsRust).not.toContain('prefs.sync_on_launch.unwrap_or(false)');
  });
});
