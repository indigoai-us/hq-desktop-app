import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-006 — Menubar opens desktop view (US-005 launcher surface).
 *
 * Source-contract coverage for the menubar-click → desktop window path:
 *  1. tray_helper "show" command marshals to toggle_desktop_window on main.
 *  2. toggle_desktop_window opens via open_desktop_alt_window_inner, with a
 *     popover fallback when the GA gate rejects (signed-out).
 *  3. Popover no longer carries the desktop-alt toggle chrome.
 */

describe('US-006: menubar launcher opens desktop view', () => {
  const trayHelper = readRepoFile('src-tauri/src/tray_helper.rs');
  const tray = readRepoFile('src-tauri/src/tray.rs');
  const popover = readRepoFile('src/components/Popover.svelte');

  it('menu-bar click "show" routes to toggle_desktop_window on the main thread', () => {
    expect(trayHelper).toContain('if let Some(rest) = cmd.strip_prefix("show")');
    expect(trayHelper).toContain(
      'app.run_on_main_thread(move || crate::tray::toggle_desktop_window(&app_main))',
    );
  });

  it('toggle_desktop_window opens desktop-alt and falls back to popover when signed-out', () => {
    expect(tray).toContain('pub fn toggle_desktop_window(app: &AppHandle)');
    expect(tray).toContain(
      'crate::commands::desktop_alt::open_desktop_alt_window_inner(app_clone.clone(), None)',
    );
    // GA gate rejects signed-out users → classic popover + SignInPrompt.
    expect(tray).toContain('GA gate rejects signed-out users');
    expect(tray).toContain('show_popover_window(&app_main)');
  });

  it('popover no longer carries the desktop-alt toggle chrome', () => {
    expect(popover).not.toContain('data-testid="desktop-alt-toggle"');
  });
});
