import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-016 — Core popover (salvage) source contracts.
 *
 * Locks wiring for the titlebar Core pill popover (conflicts, core drift,
 * app update, Library stub, PACKS, cloud-paused) and the Rust/frontend
 * cloud-pause gates so a dropped wire fails without a macOS Tauri build.
 */

const normalize = (s: string) => s.replace(/\s+/g, ' ');

describe('US-016: Core popover in V4 titlebar', () => {
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const popover = readRepoFile('src/desktop-alt/v4/CorePopover.svelte');
  const model = readRepoFile('src/desktop-alt/v4/core-popover-model.ts');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');

  it('titlebar Core pill opens CorePopover with outside-click + Escape', () => {
    expect(titleBar).toContain("import CorePopover from './CorePopover.svelte'");
    expect(titleBar).toContain('data-testid="titlebar-core-pill"');
    expect(titleBar).toContain('aria-expanded={coreOpen}');
    expect(titleBar).toContain('<CorePopover');
    expect(titleBar).toContain('●');
    expect(titleBar).toContain('⌄');
    // Same dismissal pattern as the version popout.
    expect(titleBar).toContain("window.addEventListener('mousedown'");
    expect(titleBar).toContain("event.key === 'Escape'");
    expect(titleBar).toContain('coreOpen = false');
  });

  it('conflict rescue card wires Keep local / Keep cloud / Open in editor', () => {
    expect(popover).toContain('data-testid="core-popover-rescue-card"');
    expect(popover).toContain('data-testid="core-popover-conflict-header"');
    expect(popover).toContain('Keep local');
    expect(popover).toContain('Keep cloud');
    expect(popover).toContain('Open in editor');
    expect(popover).toContain("'keep-local'");
    expect(popover).toContain("'keep-remote'");
    expect(desktopApp).toContain('onresolveconflict={handleResolveConflict}');
    expect(desktopApp).toContain("await invoke('resolve_conflict', { path, strategy })");
    expect(desktopApp).toContain("await invoke('open_in_editor', { path })");
    expect(model).toContain('conflictHeaderLabel');
    expect(model).toContain('conflictFileName');
    expect(model).toContain('conflictCompanyPath');
  });

  it('HQ core + desktop app rows: drift pill, Restore, Update', () => {
    expect(popover).toContain('data-testid="core-popover-core-row"');
    expect(popover).toContain('data-testid="core-popover-app-row"');
    expect(popover).toContain('data-testid="core-popover-drift-count"');
    expect(popover).toContain('data-testid="core-popover-no-drift"');
    expect(popover).toContain('data-testid="core-popover-core-restore"');
    expect(popover).toContain('data-testid="core-popover-app-update"');
    expect(popover).toContain("'get_hq_version'");
    expect(popover).toContain("'check_core_state'");
    expect(popover).toContain("'install_hq_core_update'");
    expect(popover).toContain("'run_replace_from_staging'");
    expect(popover).toContain("'install_update'");
    expect(popover).toContain("'open_drift_detail'");
    expect(model).toContain("driftPillLabel");
    expect(normalize(model)).toContain("n > 0 ? `${n} drifted` : 'NO DRIFT'");
  });

  it('Library stub + PACKS expandable + Open marketplace', () => {
    expect(popover).toContain('data-testid="core-popover-library-row"');
    expect(popover).toContain('data-testid="core-popover-packs"');
    expect(popover).toContain('data-testid="core-popover-packs-toggle"');
    expect(popover).toContain('data-testid="core-popover-open-marketplace"');
    expect(popover).toContain('Open marketplace');
    expect(popover).toContain("'list_packages'");
    // US-017: library opens via openLibrary (tracks previous route for Back).
    expect(desktopApp).toContain("onopenLibrary={() => openLibrary({ kind: 'library' })}");
    expect(desktopApp).toContain("onopenMarketplace={() => navigate({ kind: 'marketplace' })}");
  });

  it('cloud-paused notice lives in the Core popover model + UI', () => {
    expect(popover).toContain('data-testid="core-popover-paused"');
    expect(popover).toContain('data-kind="cloud-paused"');
    expect(model).toContain('CLOUD_PAUSED_NOTICE');
    expect(model).toContain('syncNowAllowed');
    expect(model).toContain('isSyncNowAllowed');
  });
});

describe('US-016: Cloud Off gates EVERY sync path (review-critical)', () => {
  const cloudConnection = readRepoFile('src/desktop-alt/lib/cloud-connection.ts');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const popoverApp = readRepoFile('src/App.svelte');
  const popover = readRepoFile('src/components/Popover.svelte');
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const syncRs = readRepoFile('src-tauri/src/commands/sync.rs');
  const daemonRs = readRepoFile('src-tauri/src/commands/daemon.rs');

  it('persists the paused flag in menubar.json (settings), not localStorage-only', () => {
    expect(cloudConnection).toContain('updateSettings({ cloudPaused: paused })');
    expect(cloudConnection).toContain('resolveCloudPaused');
    expect(cloudConnection).toContain('migrateLegacy');
    expect(desktopApp).toContain('setCloudPaused(paused)');
    expect(desktopApp).toContain('loadCloudPaused()');
    // Cloud toggle lives in Core popover / settings (D-04 removed titlebar switch).
    expect(titleBar).not.toContain('data-testid="cloud-connected-switch"');
    // Paused state surfaces in the v4 Core popover (D-08).
    expect(readRepoFile('src/desktop-alt/v4/CorePopover.svelte')).toContain(
      'data-testid="core-popover-paused"',
    );
  });

  it('Rust refuses start_sync and every watch-daemon origin while paused', () => {
    expect(syncRs).toContain('start_sync_cloud_gate()?;');
    expect(syncRs).toContain('ensure_cloud_sync_allowed()');
    expect(daemonRs).toContain('hq_desktop_core::daemon::ensure_cloud_sync_allowed()?;');
    expect(daemonRs).toContain('should_respawn_daemon_gated(');
    expect(daemonRs).toContain('hq_desktop_core::daemon::is_cloud_paused()');
  });

  it('popover manual sync is gated and shows the paused state', () => {
    expect(popoverApp).toContain('if (await refreshCloudPaused()) return;');
    expect(popoverApp).toContain(
      "import { loadCloudPaused } from './desktop-alt/lib/cloud-connection'",
    );
    expect(popover).toContain('data-kind="cloud-paused"');
    expect(popover).toContain('Sync is paused on this device');
    expect(popover).toMatch(/\(cloudPaused \? 1 : 0\) \+/);
  });

  it('toggling Cloud back on restores sync (stop/start reconciliation)', () => {
    expect(desktopApp).toContain("await invoke('stop_daemon')");
    expect(desktopApp).toContain("await invoke('start_daemon')");
    expect(desktopApp).toContain('if (cloudPaused)');
  });
});
