import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract assertions for the master "Automatic updates" switch
// (`autoUpdate` pref, default ON): one Settings toggle that silently installs
// the menubar app, the hq CLI, and hq-core without asking. These lock the
// wiring so a dropped gate fails fast without a macOS Tauri build.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const app = read('src/App.svelte');
const settings = read('src/components/Settings.svelte');
const cliUpdate = read('src-tauri/src/commands/hq_cli_update.rs');
const settingsRs = read('src-tauri/src/commands/settings.rs');

describe('master automatic-updates switch', () => {
  it('Settings exposes a single "Automatic updates" toggle and drops the CLI-only one', () => {
    const s = normalize(settings);
    expect(s).toContain('id="toggle-auto-update"');
    expect(s).toContain('Automatic updates');
    expect(s).toContain('class:active={autoUpdate}');
    expect(s).toContain('onclick={handleToggleAutoUpdate}');
    // The standalone per-CLI toggle is folded into the master.
    expect(settings).not.toContain('id="toggle-cli-auto-update"');
    expect(settings).not.toContain('handleToggleCliAutoUpdate');
    // The pref round-trips through get/save_settings.
    expect(s).toContain('autoUpdate = settings.autoUpdate ?? true');
    expect(s).toContain('autoUpdate,');
  });

  it('App silently installs app + core updates when autoUpdate is on, guarded', () => {
    const a = normalize(app);
    // Reads the pref (default on) + refreshes it on focus.
    expect(a).toContain('async function loadAutoUpdatePref()');
    expect(a).toContain('autoUpdate = s?.autoUpdate ?? true');
    // App self-update effect: gated on autoUpdate, deferred while syncing,
    // deduped by version, reuses the guarded install path.
    expect(a).toContain('if (!autoUpdate) return; const info = updateAvailable;');
    expect(a).toContain('if (autoAppUpdatedVersion === info.version) return;');
    expect(a).toContain('void handleInstallUpdate();');
    // Core update effect: only on a genuine version bump for eligible users,
    // deduped by target version, deferred while syncing.
    expect(a).toContain('if (!s || !s.isEligible || !s.versionBehind) return;');
    expect(a).toContain('if (autoCoreUpdatedVersion === s.targetVersion) return;');
    expect(a).toContain('void handleInstallCore();');
    // Both effects hold off mid-sync so the app never restarts under a sync.
    expect(app.match(/if \(syncState === 'syncing'\) return;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('the CLI background auto-installer gates on the master switch', () => {
    // The Rust CLI checker now installs when the master `autoUpdate` is on
    // (default), superseding the old `cliAutoUpdate`-only gate.
    expect(cliUpdate).toContain('if auto_update_enabled() {');
    expect(cliUpdate).toContain('auto_update_enabled');
    // The pref defaults ON in both get_settings branches.
    expect(settingsRs).toContain('auto_update: Some(true)');
    expect(settingsRs).toContain('auto_update: Some(prefs.auto_update.unwrap_or(true))');
  });
});
