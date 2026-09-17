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
  const compat = readRepoFile('src-tauri/src/commands/compat.rs');
  const banner = readRepoFile('src-tauri/src/commands/banner.rs');
  const history = readRepoFile('src-tauri/src/commands/notification_history.rs');
  const appCmds = readRepoFile('src-tauri/src/commands/app.rs');

  it('menu-bar click "show" routes to the desktop workspace on the main thread', () => {
    expect(trayHelper).toContain('if let Some(rest) = cmd.strip_prefix("show")');
    expect(trayHelper).toContain('app.run_on_main_thread(move ||');
    expect(trayHelper).toContain('activate_primary_surface');
  });

  it('activate_primary_surface opens desktop-alt except during onboarding', () => {
    expect(tray).toContain('pub fn activate_primary_surface(app: &AppHandle)');
    expect(tray).toContain('pub fn show_desktop_window(app: &AppHandle)');
    expect(tray).toContain('open_desktop_alt_window_inner');
    expect(tray).toContain('onboarding_window_requires_blur_suppression');
  });

  it('show_desktop_window_at carries a route to the desktop window', () => {
    expect(tray).toContain('pub fn show_desktop_window_at(app: &AppHandle, route: Option<&str>)');
    expect(tray).toMatch(
      /pub fn show_desktop_window_at[\s\S]*?open_desktop_alt_window_inner\([\s\S]*?route\.as_deref\(\)/,
    );
    // The tray-anchored popover show path is no longer a retarget destination.
    expect(tray).not.toContain('pub fn show_window_at_tray');
  });

  it('the legacy launcher and banner commands open the desktop window', () => {
    // PL-05: every "show the popover" caller lands in the desktop window.
    expect(compat).toMatch(
      /pub async fn launch_menubar_app[\s\S]*?crate::tray::show_desktop_window\(&app\)/,
    );
    expect(compat).not.toContain('show_window_at_tray');
    expect(banner).toMatch(
      /pub async fn show_main_window[\s\S]*?crate::tray::show_desktop_window\(&app\)/,
    );
    expect(banner).not.toContain('show_window_at_tray');
  });

  it('notification history and Settings open their desktop surface', () => {
    expect(history).toMatch(
      /pub async fn open_notification_history[\s\S]*?show_desktop_window_at\(&app, Some\("notifications"\)\)/,
    );
    expect(appCmds).toMatch(
      /pub fn open_settings_window[\s\S]*?show_desktop_window_at\(&app, Some\("settings"\)\)/,
    );
    // Settings no longer round-trips through the hidden `main` controller.
    expect(appCmds).not.toContain("emit_to(\"main\", \"tray:open-settings\"");
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
