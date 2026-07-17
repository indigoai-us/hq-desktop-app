import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-017 — Version pop-out in the desktop status bar.
 *
 * Source-contract harness (same style as v4-chrome.spec.ts): lock the wiring
 * so a dropped import, command, or testid fails fast without a macOS Tauri build.
 */

describe('desktop-alt version pop-out (US-017)', () => {
  it('status bar renders the version label as a button wired to open the pop-out', () => {
    const statusBar = readRepoFile('src/desktop-alt/DesktopStatusBar.svelte');
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');

    expect(statusBar).toContain("import VersionPopout from './components/VersionPopout.svelte'");
    expect(statusBar).toContain('data-testid="version-label"');
    expect(statusBar).toContain('aria-expanded={versionOpen}');
    expect(statusBar).toContain('<VersionPopout');
    expect(statusBar).toContain('onOpenSettings?: () => void');
    // Anchored upward above the bottom footer, right-aligned.
    expect(statusBar).toContain('position: relative');
    // Click-away + Escape while open.
    expect(statusBar).toContain("window.addEventListener('mousedown'");
    expect(statusBar).toContain("event.key === 'Escape'");

    expect(desktopApp).toContain("onOpenSettings={() => navigate({ kind: 'settings' })}");
  });

  it('pop-out shows current version + status and Check for updates invokes check_for_updates', () => {
    const popout = readRepoFile('src/desktop-alt/components/VersionPopout.svelte');

    expect(popout).toContain('data-testid="version-popout"');
    expect(popout).toContain('data-testid="version-popout-current"');
    expect(popout).toContain('data-testid="version-popout-latest"');
    expect(popout).toContain('data-testid="version-popout-status"');
    expect(popout).toContain('data-testid="version-popout-check"');
    expect(popout).toContain("role=\"dialog\"");
    expect(popout).toContain('aria-label="Version and updates"');
    expect(popout).toContain("'check_for_updates'");
    expect(popout).toContain('Up to date');
    expect(popout).toContain('Check for updates');
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
    expect(harness).toContain('install_update: () => null');
  });

  it('Automatic updates toggle persists via full-prefs save_settings and settings link calls onOpenSettings', () => {
    const popout = readRepoFile('src/desktop-alt/components/VersionPopout.svelte');

    expect(popout).toContain('data-testid="version-popout-auto-toggle"');
    expect(popout).toContain('data-testid="version-popout-settings-link"');
    expect(popout).toContain("'get_settings'");
    expect(popout).toContain("'save_settings'");
    expect(popout).toContain('autoUpdate');
    // Full prefs object — never a partial save.
    expect(popout).toContain('prefs: { ...prefs, autoUpdate: next }');
    expect(popout).toContain('onOpenSettings');
    expect(popout).toContain('All update settings');
  });
});
