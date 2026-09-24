import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readIfExists(p: string): string {
  try {
    return readFileSync(resolve(process.cwd(), p), 'utf8');
  } catch {
    return '';
  }
}

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (rel: string) => readFileSync(root(rel), 'utf8');
const appShell = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');
const cognitoCommands =
  readIfExists('src-tauri/src/commands/cognito.rs') +
  '\n' +
  readIfExists('../../crates/hq-desktop-core/src/cognito.rs');
const featureGate = readIfExists('../../crates/hq-desktop-core/src/feature_gate.rs');

const trayHelper = read('src-tauri/src/tray_helper.rs');
const trayRs = read('src-tauri/src/tray.rs');

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-005: Alt Home surface wires to real sync state and events', () => {

  it('keeps auth success wired and token writes connected to the desktop feature gate cache clear', () => {
    const app = normalize(appShell);
    const cognito = normalize(cognitoCommands);
    const gate = normalize(featureGate);

    // Menubar no longer polls desktop_alt_enabled for a popover toggle (US-001
    // chrome strip). Auth still sets authenticated state; onboarding remains
    // lifecycle-driven. Desktop open paths use tray + NotificationFeed.
    expect(app).toContain('function handleAuthSuccess(auth: { authenticated: boolean; expiresAt: string })');
    expect(app).toContain('authenticated = auth.authenticated');
    expect(app).toContain("invoke('open_desktop_alt_window')");
    expect(app).not.toContain('refreshDesktopAltEnabled');
    expect(app).not.toContain('{desktopAltEnabled}');

    expect(cognito).toMatch(/pub async fn set_tokens[\s\S]*clear_cached_gate\(\);/);
    expect(gate).toContain('pub fn clear_cached_gate()');
    expect(gate).toMatch(/pub fn clear_cached_gate\(\) \{[\s\S]*\*guard = None;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 e2e acceptance: menubar → desktop view, no control popover, settings
// relocated to SettingsPage (popover Settings.svelte retired).
// ─────────────────────────────────────────────────────────────────────────────

// Retargeted by hq-desktop-windows-reliability US-004: tray/menubar left-click
// toggles the compact popover; full desktop is explicit Open HQ / shortcut only.
describe('US-005 acceptance: menubar icon click opens the desktop workspace', () => {
  it("tray_helper 'show' path is anchor-only; activation goes through the menu instead", () => {
    // "show <x>" used to both record the anchor AND activate the app on a
    // left-click. Left-click now opens the menu (see the left-click test
    // below), so "show" only records the anchor — the menu's "Open desktop
    // view" item owns activation via `tray:open-desktop` -> `open_desktop_alt_window`,
    // which runs the same setup-guard/onboarding-card fallback
    // `activate_primary_surface` used to.
    expect(trayHelper).toContain('strip_prefix("show")');
    expect(trayHelper).toContain('set_tray_anchor_x');
    expect(trayHelper).not.toContain('crate::tray::activate_primary_surface');
    expect(trayHelper).not.toMatch(
      /strip_prefix\("show"\)[\s\S]*?toggle_desktop_window/,
    );
  });

  it('tray.rs toggle_desktop_window remains for explicit Open HQ / shortcut', () => {
    expect(trayRs).toContain('pub fn toggle_desktop_window');
    const fnIdx = trayRs.indexOf('pub fn toggle_desktop_window');
    expect(fnIdx).toBeGreaterThan(-1);
    // Slice the function body (through show_onboarding_window fallback).
    const body = trayRs.slice(fnIdx, fnIdx + 1200);
    // Hide when already visible.
    expect(body).toMatch(/get_webview_window\("desktop-alt"\)/);
    expect(body).toMatch(/is_visible\(\)\.unwrap_or\(false\)/);
    expect(body).toMatch(/\.hide\(\)/);
    // Open via open_desktop_alt_window_inner when not visible.
    expect(body).toContain('open_desktop_alt_window_inner');
    // Signed-out / GA-gate Err → classic popover so SignInPrompt remains reachable.
    expect(body).toMatch(/if let Err[\s\S]*?show_onboarding_window/);
  });

  it('non-macOS tray shows the menu on left-click too (not just right-click)', () => {
    // Left-click opening the app window directly was removed — "Open desktop
    // view" in the menu is now the only way to open the app window, and a
    // left-click surfaces the same menu a right-click does. `on_tray_icon_event`
    // stays wired, but only to record the native-panic-seam diagnostic marker
    // for the left-click gesture — it no longer activates anything.
    expect(trayRs).toContain('show_menu_on_left_click(true)');
    const clickIdx = trayRs.indexOf('if let TrayIconEvent::Click {');
    expect(clickIdx).toBeGreaterThan(-1);
    const endIdx = trayRs.indexOf('.build(app)?;', clickIdx);
    const clickBody = trayRs.slice(clickIdx, endIdx);
    expect(clickBody).toContain('MouseButton::Left');
    expect(clickBody).toContain('record_native_panic_seam');
    expect(clickBody).not.toContain('activate_primary_surface');
  });
});

describe('US-005 acceptance: no control popover', () => {

  it("tray:open-settings opens the desktop Settings route", () => {
    expect(appShell).toContain("listen('tray:open-settings'");
    expect(appShell).toMatch(
      /tray:open-settings[\s\S]*?open_desktop_alt_window[\s\S]*?route:\s*['"]settings['"]/,
    );
  });
});
