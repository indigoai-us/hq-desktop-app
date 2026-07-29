import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop-alt V4 settings and first-run (US-013 / US-005)', () => {
  // US-005: classic popover Settings.svelte is retired. SettingsPage is the
  // single settings surface — every assertion below targets that page only.
  const page = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');
  const harness = readRepoFile('dev-harness/mocks/core.ts');

  it('groups every menubar setting knob and persists through the serialized settings queue', () => {
    expect(page).toContain("invoke<SettingsWire>('get_settings')");
    expect(page).toContain(
      "import { updateSettings, type SettingsPatch } from '../../lib/settings-mutations'",
    );
    expect(page).toContain('await updateSettings(patch)');
    expect(page).not.toMatch(/invoke\(['"]save_settings['"]/);
    for (const key of [
      'hqPath',
      'syncOnLaunch',
      'notifications',
      'startAtLogin',
      'realtimeSync',
      'personalSyncEnabled',
      'instantSync',
      'shareNotifications',
      'dmNotifications',
      'cliAutoUpdate',
      'stagingChannel',
      'releaseChannel',
      'meetingDetectNotify',
      'defaultRecordingCompanyUid',
      // Usage telemetry is opt-in; the toggle must round-trip through
      // get_settings/save_settings so a save never drops it (and the data-loss
      // merge in save_settings preserves machineId/firstRunCompleted alongside it).
      'telemetryEnabled',
    ]) {
      expect(page).toContain(key);
    }
  });

  it('applies live backend side-effects, not just persistence, for daemon + autostart toggles', () => {
    // Persisting menubar.json is not enough — Auto-sync must start/stop the
    // daemon, Instant-sync must bounce it, and Start-at-login must reconcile the
    // macOS LaunchAgent. Without these the running process keeps its old
    // behavior until the next launch.
    expect(page).toContain("invoke('start_daemon')");
    expect(page).toContain("invoke('stop_daemon')");
    expect(page).toContain("invoke('set_autostart_enabled', { enabled: startAtLogin })");
    // The three toggles must route through their effect handlers, not the bare
    // saveSettings persistence path.
    expect(page).toContain('onchange={applyRealtimeSync}');
    expect(page).toContain('onchange={applyInstantSync}');
    expect(page).toContain('onchange={applyStartAtLogin}');
  });

  it('carries folder re-tether, memberships dropdown, permissions, and platform gating', () => {
    // (1) HQ folder re-tether — a "Change…" button calling pick_folder.
    expect(page).toContain("invoke<string | null>('pick_folder')");
    expect(page).toContain('Change…');
    // (2) Real membership dropdown for default-recording-company, not a free-text
    //     UID field that saved unvalidated input only on blur.
    expect(page).toContain("invoke<CompanyMembership[]>('meetings_list_memberships')");
    expect(page).toContain('<option value="">Personal</option>');
    expect(page).toContain('{m.companyName?.trim()');
    // No raw UID leaked as the option label.
    expect(page).not.toContain('{m.companyUid}</option>');
    // (3) Meeting permissions wizard reachable from the desktop window.
    expect(page).toContain("invoke('open_meeting_permissions_window')");
    expect(page).toContain('permissionState.meetingPermissions');
    // (4) Platform toggles only shown when detection is enabled (otherwise they
    //     looked actionable but changed nothing).
    expect(page).toContain('{#if meetingDetectEnabled}');
  });

  it('hosts controls relocated from the classic popover (updates, OS permission, sign-out, quit, version)', () => {
    // US-005 relocated every classic Settings control into SettingsPage.
    expect(page).toContain("'check_for_updates'");
    expect(page).toContain("'notification_permission_state'");
    expect(page).toContain("'notification_request_permission'");
    expect(page).toContain("'check_hq_cli_update'");
    expect(page).toContain("'install_hq_cli_update'");
    expect(page).toContain("'set_hq_cli_update_dismissed'");
    expect(page).toContain('HQ_CLI_UPGRADE_CMD');
    expect(page).toContain("'check_pack_update'");
    expect(page).toContain("'update_packs'");
    expect(page).toContain("'get_hq_version'");
    expect(page).toContain("'check_core_state'");
    expect(page).toContain("'open_drift_detail'");
    expect(page).toContain("'install_hq_core_update'");
    expect(page).toContain("'run_replace_from_staging'");
    expect(page).toContain("'quit_app'");
    expect(page).toContain("'show_main_window'");
    expect(page).toContain("emit('tray:sign-out')");
    expect(page).toContain('getVersion');
  });

  it('renders the section anchors, scroll behavior, and gated annotations', () => {
    // SettingsPage renders every section inline (one scroll) and scrolls the
    // active one into view; the secondary sidebar provides the section index.
    for (const [id, label] of [
      ['sync', 'Sync'],
      ['notifications', 'Notifications'],
      ['widget', 'Widget'],
      ['updates', 'Updates'],
      ['general', 'General'],
      ['meetings', 'Meetings'],
    ]) {
      expect(page).toContain(`id="${id}"`);
      expect(page).toContain(`<h2>${label}</h2>`);
    }
    expect(page).toContain("closest<HTMLElement>('.desktop-main-scroll')");
    expect(page).toContain("scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })");
    expect(page).toContain('class="setting-row gated-row"');
    expect(page).toContain('@getindigo.ai only');
    expect(page).toContain('<em>Gated</em>');
    expect(page).toContain('{#if !meetingsEnabled}<em>Unavailable</em>{/if}');
    expect(page).not.toMatch(
      /<strong>Meeting detection<\/strong>[\s\S]{0,400}<em>Gated<\/em>/,
    );
  });

  it('styles toggles as macOS green-fill pills (the one sanctioned control color)', () => {
    // SPEC §5/§6: setting toggles use a 26×16 pill, green when on — not the
    // default native checkbox. Locks the appearance:none pill + green fill.
    expect(page).toContain("input[type='checkbox']");
    expect(page).toContain('appearance: none');
    expect(page).toContain('var(--v4-ok)');
  });

  it('lets native selects follow the active system palette without a dark lock', () => {
    expect(page).toContain('color-scheme: light dark');
    expect(page).not.toMatch(/select\s*\{[^}]*color-scheme:\s*dark/);
    expect(page).not.toContain(":global(html[data-force-theme='dark']) select");
    expect(page).toContain(":global(html[data-force-theme='light']) select");
    expect(page).toContain('color-scheme: light');
  });

  it('lets the shell leaf scroller own section navigation', () => {
    const settingsMainCss = page.match(/\.settings-main\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(settingsMainCss).not.toContain('overflow: auto');
    expect(settingsMainCss).toContain('overflow: visible');
  });

  it('provides deterministic harness coverage for every high-risk settings edge state', () => {
    for (const scenario of [
      'settings-updates',
      'settings-errors',
      'settings-load-error',
      'permission-denied',
      'widget-disconnected',
    ]) {
      expect(harness).toContain(`'${scenario}'`);
    }

    for (const command of [
      'check_hq_cli_update',
      'install_hq_cli_update',
      'check_pack_update',
      'update_packs',
      'get_hq_version',
      'install_hq_core_update',
      'run_replace_from_staging',
      'list_displays',
      'apply_widget_settings',
    ]) {
      expect(harness).toContain(`${command}:`);
    }

    // Core rescue succeeds with the real result shape in the normal/update
    // scenario, while the explicit error scenario returns a nonzero rescue
    // result so the log-path recovery UI can be inspected without a null crash.
    expect(harness).toContain('exit_code: failed ? 1 : 0');
    expect(harness).toContain('harnessCliVersion = \'0.20.0\'');
    expect(harness).toContain('harnessPacksUpdated = true');
    expect(harness).toContain('harnessCoreVersion = HARNESS_DRIFT.targetVersion');
    expect(harness).toContain('harnessCoreUpdated = true');
    expect(harness).toContain('harnessAppUpdateInstalled = true');
    expect(harness).toContain('log_path: failed');
  });
});
