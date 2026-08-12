import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-017 — Version pop-out in the desktop status bar.
 *
 * Source-contract harness (same style as v4-chrome.spec.ts): lock the wiring
 * so a dropped import, command, or testid fails fast without a macOS Tauri build.
 */

describe('desktop-alt version pop-out (US-017)', () => {
  it('compact titlebar hosts the version pop-out without restoring the bottom status bar', () => {
    const statusBar = readRepoFile('src/desktop-alt/DesktopStatusBar.svelte');
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');

    // The retired footer keeps its implementation for older entry points, but
    // the mounted titlebar must expose the same updater in the redesign.
    expect(statusBar).toContain("import VersionPopout from './components/VersionPopout.svelte'");
    expect(desktopApp).not.toContain('<DesktopStatusBar');
    expect(titleBar).toContain("import VersionPopout from '../components/VersionPopout.svelte'");
    expect(titleBar).toContain('data-testid="version-label"');
    expect(titleBar).toContain('data-testid="core-version-label"');
    expect(titleBar).toContain("'get_hq_version'");
    expect(titleBar).toContain('aria-expanded={versionOpen}');
    expect(titleBar).toContain('<VersionPopout');
    expect(titleBar).toContain("onOpenSettings?: (tab?: SettingsTab) => void");
    expect(titleBar).toContain('placement="below"');
    expect(titleBar).toContain("window.addEventListener('mousedown'");
    expect(titleBar).toContain("event.key === 'Escape'");
    expect(desktopApp).toContain('version={__APP_VERSION__}');
    expect(desktopApp).toContain('onaccount={handleAccountMenu}');
  });

  it('pop-out shows app + Core versions and Check all updates invokes both checks', () => {
    const popout = readRepoFile('src/desktop-alt/components/VersionPopout.svelte');

    expect(popout).toContain('data-testid="version-popout"');
    expect(popout).toContain('data-testid="version-popout-current"');
    expect(popout).toContain('data-testid="version-popout-latest"');
    expect(popout).toContain('data-testid="version-popout-status"');
    expect(popout).toContain('data-testid="version-popout-core-current"');
    expect(popout).toContain('data-testid="version-popout-core-status"');
    expect(popout).toContain('data-testid="version-popout-check"');
    expect(popout).toContain("role=\"dialog\"");
    expect(popout).toContain('aria-label="Version and updates"');
    expect(popout).toContain('position: fixed');
    expect(popout).toContain('z-index: 10000');
    expect(popout).toContain('top: 48px');
    expect(popout).toContain('--v4-popover-strong');
    expect(popout).toContain("'check_for_updates'");
    expect(popout).toContain("'check_core_state'");
    expect(popout).toContain("'get_hq_version'");
    expect(popout).toContain('Up to date');
    expect(popout).toContain('Check all updates');
    // Background-detected updates without a manual check.
    expect(popout).toContain("listen<UpdateInfo>('update:available'");
    // Hydrates an update the background checker already found (get_pending_update),
    // and the Rust command is registered.
    expect(popout).toContain("'get_pending_update'");
  });

  it('Restart to update invokes install_update when an update is available', () => {
    const popout = readRepoFile('src/desktop-alt/components/VersionPopout.svelte');

    expect(popout).toContain("'install_update'");
    expect(popout).toContain('data-testid="version-popout-restart"');
    expect(popout).toContain('Restart to update');
    expect(popout).toContain('Downloading…');
    expect(popout).toContain('Restart to apply');

    const harness = readRepoFile('dev-harness/mocks/core.ts');
    expect(harness).toContain('install_update: () => {');
    expect(harness).toContain("harnessScenario() === 'settings-errors'");
  });

  it('Automatic updates persists via the shared serialized patch queue and opens Updates', () => {
    const popout = readRepoFile('src/desktop-alt/components/VersionPopout.svelte');
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');

    expect(popout).toContain('data-testid="version-popout-auto-toggle"');
    expect(popout).toContain('data-testid="version-popout-settings-link"');
    expect(popout).toContain('autoUpdate');
    expect(popout).toContain(
      "import { updateSettings } from '../../lib/settings-mutations'",
    );
    expect(popout).toContain('await updateSettings({ autoUpdate: next })');
    expect(popout).not.toMatch(/invoke\(['"]save_settings['"]/);
    expect(popout).toContain("onOpenSettings('updates')");
    expect(desktopApp).toContain('function handleOpenSettings(tab?: SettingsTab)');
    expect(popout).toContain('All update settings');
  });

  it('Settings can install and restart when its app update check finds a newer version', () => {
    const settings = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');

    expect(settings).toContain("let appUpdate = $state<UpdateInfo | null>(null)");
    expect(settings).toContain("await invoke('install_update')");
    expect(settings).toContain('data-testid="settings-install-app-update"');
    expect(settings).toContain("appUpdate ? `v${appUpdate.version} ready` : 'Background checks run every 6 hours'");
    expect(settings).toContain("appUpdateInstalling ? 'Installing…' : 'Restart to Update'");
  });

  it('the preview harness exposes a deterministic update-available scenario', () => {
    const harness = readRepoFile('dev-harness/mocks/core.ts');

    expect(harness).toContain('const HARNESS_UPDATE');
    expect(harness).toContain('function hasSettingsUpdates(');
    expect(harness).toContain("scenario === 'update-available'");
    expect(harness).toContain('check_for_updates: () =>');
    expect(harness).toContain('get_pending_update: () =>');
    // US-019: chat shell may swap the update body via currentHarnessAppUpdate().
    expect(harness).toContain(
      'hasSettingsUpdates() && !harnessAppUpdateInstalled ? currentHarnessAppUpdate() : null',
    );
    expect(harness).toContain('function currentHarnessAppUpdate(');
  });
});
