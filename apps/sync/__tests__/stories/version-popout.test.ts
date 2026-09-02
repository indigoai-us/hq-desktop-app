import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// US-017 — Version pop-out in the desktop status bar (source-contract).
// Locks the three PRD e2e scenarios so a dropped command, testid, or settings
// wiring fails fast without a macOS Tauri build.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const titleBar = read('src/desktop-alt/v4/V4TitleBar.svelte');
const popout = read('src/desktop-alt/components/VersionPopout.svelte');
const desktopApp = read('src/desktop-alt/DesktopApp.svelte');
const harness = read('dev-harness/mocks/core.ts');

describe('US-017: version pop-out in desktop status bar', () => {
  it('version label opens a viewport-fixed pop-out with a11y + close affordances', () => {
    const p = normalize(popout);

    expect(titleBar).toContain('data-testid="version-label"');
    expect(titleBar).toContain("import VersionPopout from '../components/VersionPopout.svelte'");
    expect(titleBar).toContain('<VersionPopout');
    expect(titleBar).toContain('aria-expanded={versionOpen}');
    expect(p).toContain('position: fixed');
    expect(popout).toContain('role="dialog"');
    expect(popout).toContain('aria-label="Version and updates"');
    expect(titleBar).toContain("window.addEventListener('mousedown'");
    expect(titleBar).toContain("event.key === 'Escape'");
    // DESKTOP-001: status bar unmounted; account/settings live on the titlebar.
    expect(desktopApp).not.toContain('<DesktopStatusBar');
    expect(desktopApp).toContain('onaccount={handleAccountMenu}');
  });

  it('Check for updates / Restart to update invoke Tauri commands and surface status', () => {
    // The manual check now routes through the shared three-target
    // orchestration (src/lib/update-check.ts), which owns the
    // 'check_for_updates' invoke; the popout imports it instead of
    // invoking the command inline.
    expect(popout).toContain("import { checkAllUpdates } from '../../lib/update-check'");
    expect(popout).toContain('checkAllUpdates(');
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
    expect(harness).toContain('check_for_updates: () =>');
    expect(harness).toContain('function hasSettingsUpdates(');
    expect(harness).toContain("scenario === 'update-available'");
    expect(harness).toContain(
      'hasSettingsUpdates() && !harnessAppUpdateInstalled ? HARNESS_UPDATE : null',
    );
    expect(harness).toContain('install_update: () => {');
  });

  it('Automatic updates toggle uses the shared serialized patch path and opens Settings', () => {
    const p = normalize(popout);

    expect(popout).toContain('data-testid="version-popout-auto-toggle"');
    expect(popout).toContain('data-testid="version-popout-settings-link"');
    expect(popout).toContain('autoUpdate');
    expect(popout).toContain(
      "import { updateSettings } from '../../lib/settings-mutations'",
    );
    expect(p).toContain('await updateSettings({ autoUpdate: next })');
    expect(popout).not.toMatch(/invoke\(['"]save_settings['"]/);
    expect(popout).toContain('onOpenSettings');
    expect(popout).toContain('All update settings');
  });
});
