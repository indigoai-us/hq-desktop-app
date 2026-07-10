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

// The V4 Home surface (HomePage + home-model + NeedsYouCard + ActivityDigest)
// superseded the SyncPage/HeroStatus/SourcesList sources-table in US-003 of
// the V4 redesign — same coverage (real sync state + events, no demo
// fixtures), new contracts.
const desktopApp = readFileSync(resolve(process.cwd(), 'src/desktop-alt/DesktopApp.svelte'), 'utf8');
const homePage = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/pages/HomePage.svelte'),
  'utf8',
);
const homeModel = readFileSync(resolve(process.cwd(), 'src/desktop-alt/v4/home-model.ts'), 'utf8');
const activityDigest = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/v4/ActivityDigest.svelte'),
  'utf8',
);
const syncModel = readFileSync(resolve(process.cwd(), 'src/desktop-alt/lib/sync-model.ts'), 'utf8');
const appShell = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');
const cognitoCommands =
  readIfExists('src-tauri/src/commands/cognito.rs') +
  '\n' +
  readIfExists('../../crates/hq-desktop-core/src/cognito.rs');
const featureGate = readIfExists('../../crates/hq-desktop-core/src/feature_gate.rs');

const trayHelper = read('src-tauri/src/tray_helper.rs');
const trayRs = read('src-tauri/src/tray.rs');
const settingsPage = read('src/desktop-alt/pages/SettingsPage.svelte');
const inboxPage = read('src/desktop-alt/pages/InboxPage.svelte');

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-005: Alt Home surface wires to real sync state and events', () => {
  it('subscribes DesktopApp to the sync events that drive the popover', () => {
    for (const eventName of [
      'sync:progress',
      'sync:complete',
      'sync:all-complete',
      'sync:plan',
      'sync:totals',
      'sync:fanout-plan',
      'sync:error',
      'sync:conflict',
      'sync:personal-first-push-progress',
      'sync:personal-first-push-complete',
    ]) {
      expect(desktopApp).toContain(`'${eventName}'`);
    }

    expect(desktopApp).toContain("invoke<WorkspacesResult>('list_syncable_workspaces')");
    expect(desktopApp).toContain("invoke<ActivityEntry[]>('get_activity_log')");
  });

  it('wires the Home inline actions to real Tauri commands', () => {
    const app = normalize(desktopApp);

    expect(app).toContain("await invoke('start_sync')");
    expect(app).toContain("await invoke('cancel_sync')");
    expect(app).toContain("function handleOpenSettings(tab?: SettingsTab) { navigate({ kind: 'settings', tab }); }");
    expect(app).toContain("await invoke('resolve_conflict', { path, strategy })");
    expect(app).toContain("invoke('open_in_editor', { path })");
    expect(app).toContain("await invoke('restore_from_upstream', {");
    expect(app).toContain("invoke('open_drift_detail', { report })");
    expect(app).toContain("await invoke('refresh_tokens')");
    expect(app).toContain("invoke('open_activity_log')");
  });

  it('renders health, needs-you, and digest from real state without demo fixtures', () => {
    const combined = normalize(`${homePage}\n${activityDigest}\n${homeModel}\n${syncModel}`);

    expect(combined).toContain('Needs you');
    expect(combined).toContain('Sync in progress');
    expect(combined).toContain('Today across your companies');
    expect(combined).toContain('Nothing yet today');
    expect(combined).toContain('Technical details');
    expect(combined).not.toMatch(/Acme|Volta|Globex|Indigo demo|prototype/i);
  });

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

  it('pins debugger event regressions in DesktopApp handlers', () => {
    const app = normalize(desktopApp);

    expect(app).toMatch(
      /sync:personal-first-push-progress[\s\S]*company: 'personal'[\s\S]*updateWorkspaceStats\('personal'/,
    );
    expect(app).toMatch(
      /sync:complete[\s\S]*aborted: stats\.aborted \|\| event\.payload\.aborted[\s\S]*syncState = 'conflict'/,
    );
    expect(app).toMatch(
      /sync:error[\s\S]*if \(event\.payload\.company\)[\s\S]*errorMessage: event\.payload\.message/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 e2e acceptance: menubar → desktop view, no control popover, settings
// relocated to SettingsPage (popover Settings.svelte retired).
// ─────────────────────────────────────────────────────────────────────────────

describe('US-005 acceptance: menubar icon click opens the desktop view', () => {
  it("tray_helper 'show' path marshals toggle_desktop_window (not toggle_popover_window)", () => {
    // "show" still parses the icon anchor for popover-fallback anchoring.
    expect(trayHelper).toContain('strip_prefix("show")');
    expect(trayHelper).toContain('set_tray_anchor_x');
    // Main-thread marshal → desktop toggle (no poll-thread AppKit deadlock).
    expect(trayHelper).toMatch(/run_on_main_thread\([\s\S]*?toggle_desktop_window/);
    expect(trayHelper).toContain('crate::tray::toggle_desktop_window');
    // Must not route menubar click through the classic popover toggle.
    expect(trayHelper).not.toContain('toggle_popover_window');
  });

  it('tray.rs toggle_desktop_window hides visible desktop-alt, opens otherwise, falls back to popover on Err', () => {
    expect(trayRs).toContain('pub fn toggle_desktop_window');
    const fnIdx = trayRs.indexOf('pub fn toggle_desktop_window');
    expect(fnIdx).toBeGreaterThan(-1);
    // Slice the function body (through show_popover_window fallback).
    const body = trayRs.slice(fnIdx, fnIdx + 1200);
    // Hide when already visible.
    expect(body).toMatch(/get_webview_window\("desktop-alt"\)/);
    expect(body).toMatch(/is_visible\(\)\.unwrap_or\(false\)/);
    expect(body).toMatch(/\.hide\(\)/);
    // Open via open_desktop_alt_window_inner when not visible.
    expect(body).toContain('open_desktop_alt_window_inner');
    // Signed-out / GA-gate Err → classic popover so SignInPrompt remains reachable.
    expect(body).toMatch(/if let Err[\s\S]*?show_popover_window/);
  });

  it('non-macOS on_tray_icon_event left-click calls toggle_desktop_window', () => {
    // Tao tray is the menubar surface on non-macOS; left-click must open desktop.
    expect(trayRs).toContain('on_tray_icon_event');
    expect(trayRs).toMatch(
      /TrayIconEvent::Click\s*\{[\s\S]*?MouseButton::Left[\s\S]*?toggle_desktop_window/,
    );
  });
});

describe('US-005 acceptance: no control popover', () => {
  it('App.svelte does not host the retired popover Settings surface', () => {
    expect(appShell).not.toContain('showSettings');
    expect(appShell).not.toContain('handleBackFromSettings');
    expect(appShell).not.toContain("from './components/Settings.svelte'");
    expect(appShell).not.toContain('components/Settings.svelte');
    // Classic file is gone.
    expect(() => read('src/components/Settings.svelte')).toThrow();
  });

  it("tray:open-settings opens the desktop Settings route", () => {
    expect(appShell).toContain("listen('tray:open-settings'");
    expect(appShell).toMatch(
      /tray:open-settings[\s\S]*?open_desktop_alt_window[\s\S]*?route:\s*['"]settings['"]/,
    );
  });
});

describe('US-005 acceptance: all previous popover settings and company controls present in desktop view', () => {
  it('SettingsPage hosts every control relocated from the classic popover Settings', () => {
    for (const needle of [
      'check_for_updates',
      'notification_permission_state',
      'notification_request_permission',
      'check_hq_cli_update',
      'install_hq_cli_update',
      'set_hq_cli_update_dismissed',
      'HQ_CLI_UPGRADE_CMD',
      'check_pack_update',
      'update_packs',
      'check_core_state',
      'open_drift_detail',
      'install_hq_core_update',
      'run_replace_from_staging',
      'quit_app',
      'show_main_window',
    ]) {
      expect(settingsPage).toContain(needle);
    }
    // Sign out goes through the same App-owned tray:sign-out listener.
    expect(settingsPage).toContain("emit('tray:sign-out')");
    // Pack update card title helper (relocated with the pack card).
    expect(settingsPage).toContain('packUpdateTitle');
  });

  // The Companies page (cloud connect + SyncModeControl) was removed as a
  // destination by hq-desktop-widget US-007 — companies are reached via their
  // first-class sidebar rows; cloud-only rows pull via Sync.

  it('InboxPage still mounts NotificationFeed (notifications not orphaned — merged into Inbox by US-008)', () => {
    expect(inboxPage).toContain('NotificationFeed');
    expect(inboxPage).toMatch(/import NotificationFeed from ['"].*NotificationFeed\.svelte['"]/);
  });
});
