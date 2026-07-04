import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// Locks the staged first-run contract: the rebuilt onboarding wizard owns
// completion, while sync-on-launch remains default-on for normal launches.
describe('first-run routes through onboarding before completion', () => {
  const app = readRepoFile('src/App.svelte');
  const lifecycle = readRepoFile('src/lib/lifecycle.ts');
  const onboarding = readRepoFile('src/components/Onboarding.svelte');
  const settings = readRepoFile('src/components/Settings.svelte');
  const settingsPage = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');
  const settingsRust = readRepoFile('src-tauri/src/commands/settings.rs');

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

  it('sync-on-launch defaults ON in both Settings surfaces', () => {
    expect(settings).toContain('settings.syncOnLaunch ?? true');
    expect(settingsPage).toContain('settings.syncOnLaunch ?? true');
    // And no surface silently falls back to OFF.
    expect(settings).not.toContain('settings.syncOnLaunch ?? false');
    expect(settingsPage).not.toContain('settings.syncOnLaunch ?? false');
  });

  it('sync-on-launch defaults ON in the Rust get_settings defaults', () => {
    // Fresh-install (no file) branch and the per-field default both resolve ON.
    expect(settingsRust).toContain('sync_on_launch: Some(true)');
    expect(settingsRust).toContain('prefs.sync_on_launch.unwrap_or(true)');
    expect(settingsRust).not.toContain('prefs.sync_on_launch.unwrap_or(false)');
  });
});
