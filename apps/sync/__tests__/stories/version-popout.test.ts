import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// US-017 — Version pop-out in the desktop status bar (source-contract).
// Locks the three PRD e2e scenarios so a dropped command, testid, or settings
// wiring fails fast without a macOS Tauri build.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const statusBar = read('src/desktop-alt/DesktopStatusBar.svelte');
const popout = read('src/desktop-alt/components/VersionPopout.svelte');
const desktopApp = read('src/desktop-alt/DesktopApp.svelte');
const harness = read('dev-harness/mocks/core.ts');

describe('US-017: version pop-out in desktop status bar', () => {
  it('version label opens an upward-anchored pop-out with a11y + close affordances', () => {
    const s = normalize(statusBar);
    const p = normalize(popout);

    expect(statusBar).toContain('data-testid="version-label"');
    expect(statusBar).toContain("import VersionPopout from './components/VersionPopout.svelte'");
    expect(statusBar).toContain('<VersionPopout');
    expect(statusBar).toContain('aria-expanded={versionOpen}');
    expect(s).toContain('position: relative');
    expect(p).toContain('bottom: calc(100% + 8px)');
    expect(p).toContain('right: 0');
    expect(popout).toContain('role="dialog"');
    expect(popout).toContain('aria-label="Version and updates"');
    // Click-away + Escape live on the status bar while the pop-out is open.
    expect(statusBar).toContain("window.addEventListener('mousedown'");
    expect(statusBar).toContain("event.key === 'Escape'");
    // DESKTOP-001: status bar unmounted; account/settings live on the titlebar.
    expect(desktopApp).not.toContain('<DesktopStatusBar');
    expect(desktopApp).toContain('onaccount={handleAccountMenu}');
  });

  it('Check for updates / Restart to update invoke Tauri commands and surface status', () => {
    expect(popout).toContain("'check_for_updates'");
    expect(popout).toContain("'install_update'");
    expect(popout).toContain('data-testid="version-popout-status"');
    expect(popout).toContain('data-testid="version-popout-check"');
    expect(popout).toContain('data-testid="version-popout-restart"');
    expect(popout).toContain('Up to date');
    expect(popout).toContain('Update available');
    expect(popout).toContain('Downloading…');
    expect(popout).toContain('Restart to apply');
    // Background checker event without a manual check.
    expect(popout).toContain("listen<UpdateInfo>('update:available'");
    // Hydrates an update the background checker already found (get_pending_update),
    // and the Rust command is registered.
    expect(popout).toContain("'get_pending_update'");
    expect(harness).toContain('check_for_updates: () => null');
    expect(harness).toContain('install_update: () => null');
  });

  it('Automatic updates toggle persists full prefs and settings link calls onOpenSettings', () => {
    const p = normalize(popout);

    expect(popout).toContain('data-testid="version-popout-auto-toggle"');
    expect(popout).toContain('data-testid="version-popout-settings-link"');
    expect(popout).toContain("'get_settings'");
    expect(popout).toContain("'save_settings'");
    expect(popout).toContain('autoUpdate');
    // Read FULL settings, flip autoUpdate, pass the full prefs object back.
    expect(p).toContain("invoke<Record<string, unknown>>('get_settings')");
    expect(p).toContain("invoke('save_settings', { prefs: { ...prefs, autoUpdate: next } })");
    expect(popout).toContain('onOpenSettings');
    expect(popout).toContain('All update settings');
  });
});
