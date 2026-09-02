import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-006 — Menubar opens the desktop workspace.
 *
 * Source-contract coverage for the menubar-click → desktop window path:
 *  1. tray_helper "show" command marshals to activate_primary_surface.
 *  2. activate_primary_surface opens desktop-alt (onboarding still uses main).
 *  3. Popover no longer carries the desktop-alt toggle chrome.
 */

describe('US-006: menubar launcher opens desktop view', () => {
  const trayHelper = readRepoFile('src-tauri/src/tray_helper.rs');
  const tray = readRepoFile('src-tauri/src/tray.rs');
  const popover = readRepoFile('src/components/Popover.svelte');

  it('menu-bar click "show" routes to the desktop workspace on the main thread', () => {
    expect(trayHelper).toContain('if let Some(rest) = cmd.strip_prefix("show")');
    expect(trayHelper).toContain('activate_primary_surface');
  });

  it('activate_primary_surface opens desktop-alt except during onboarding', () => {
    expect(tray).toContain('pub fn activate_primary_surface(app: &AppHandle)');
    expect(tray).toContain('pub fn show_desktop_window(app: &AppHandle)');
    expect(tray).toContain(
      'crate::commands::desktop_alt::open_desktop_alt_window_inner(app_clone.clone(), None)',
    );
    expect(tray).toContain('onboarding_window_requires_blur_suppression');
  });

  it('popover no longer carries the desktop-alt toggle chrome', () => {
    expect(popover).not.toContain('data-testid="desktop-alt-toggle"');
  });

  it('keeps compact sync status without a live progress bar', () => {
    expect(popover).toContain('data-testid="popover-status-row"');
    expect(popover).toContain('data-testid="popover-sync-sublabel"');
    expect(popover).not.toContain('mbp-progress-track');
    expect(popover).not.toContain('const barPct');
    expect(popover).not.toContain('role="progressbar"');
  });
});
