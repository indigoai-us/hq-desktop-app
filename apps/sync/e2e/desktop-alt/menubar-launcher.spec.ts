import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-006 — Menubar opens the desktop workspace.
 *
 * Source-contract coverage for the menubar-click → desktop window path:
 *  1. tray_helper "show" command reports the icon anchor (left-click opens
 *     the menu now, not the app directly — see hq-tray-helper.swift); the
 *     menu's "desktop" command ("Open desktop view") routes to the frontend,
 *     which opens the desktop workspace via `open_desktop_alt_window`.
 *  2. activate_primary_surface (still used by Dock click / second launch)
 *     opens desktop-alt (onboarding still uses main).
 *
 * The third leg — "the popover no longer carries desktop-alt chrome" — went
 * away with the popover itself in PL-07.
 */

describe('US-006: menubar launcher opens desktop view', () => {
  const trayHelper = readRepoFile('src-tauri/src/tray_helper.rs');
  const tray = readRepoFile('src-tauri/src/tray.rs');
  const compat = readRepoFile('src-tauri/src/commands/compat.rs');
  const banner = readRepoFile('src-tauri/src/commands/banner.rs');
  const history = readRepoFile('src-tauri/src/commands/notification_history.rs');
  const appCmds = readRepoFile('src-tauri/src/commands/app.rs');

  it('menu-bar click "show" reports the icon anchor; "desktop" opens the workspace', () => {
    expect(trayHelper).toContain('if let Some(rest) = cmd.strip_prefix("show")');
    expect(trayHelper).toContain('set_tray_anchor_x');
    expect(trayHelper).toContain('"desktop" =>');
    expect(trayHelper).toMatch(/"desktop"\s*=>\s*\{[\s\S]*?tray:open-desktop/);
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
});
