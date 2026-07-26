import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/lib/workspaces';
import { buildSourceRows, emptyWorkspaceStats } from '../../src/desktop-alt/lib/sync-model';
import { sortV4CompaniesConnectedFirst } from '../../src/desktop-alt/v4/model';

const root = (path: string) => resolve(process.cwd(), path);
const read = (path: string) => readFileSync(root(path), 'utf8');

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: 'acme',
    displayName: 'Acme',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cmp_acme',
    bucketName: 'hq-vault-cmp-acme',
    hasLocalFolder: true,
    localPath: '/tmp/HQ/companies/acme',
    membershipStatus: 'active',
    role: 'admin',
    syncEnabled: true,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

describe('US-007: Per-workspace sync controls and Personal taxonomy', () => {
  it('separates Personal from Companies and keeps the owner name as secondary text', () => {
    const rows = sortV4CompaniesConnectedFirst([
      workspace({
        slug: 'personal',
        displayName: 'Corey Epstein',
        kind: 'personal',
        state: 'personal',
        cloudUid: 'prs_corey',
        bucketName: 'hq-vault-prs-corey',
        membershipStatus: null,
        role: null,
      }),
      workspace({ slug: 'zeta', displayName: 'Zeta', syncEnabled: false }),
      workspace({ slug: 'acme', displayName: 'Acme', syncEnabled: true }),
    ]);

    expect(rows.map((row) => row.slug)).toEqual(['acme', 'personal', 'zeta']);
    expect(rows.find((row) => row.slug === 'personal')).toMatchObject({
      label: 'Personal',
      ownerLabel: 'Corey Epstein',
      isPersonal: true,
      syncEnabled: true,
    });
    expect(rows.find((row) => row.slug === 'zeta')?.syncEnabled).toBe(false);
  });

  it('treats disabled sources as paused without overwriting the remembered company footprint', () => {
    const [row] = buildSourceRows({
      workspaces: [workspace({ slug: 'acme', syncEnabled: false })],
      syncState: 'idle',
      progress: null,
      statsBySlug: { acme: emptyWorkspaceStats() },
      cloudReachable: true,
    });

    expect(row.syncEnabled).toBe(false);
    expect(row.action).toBe('Paused');
    expect(row.detail).toBe('Sync disabled on this Mac');
    expect(row.showSyncMode).toBe(false);
  });

  it('wires the local enabled policy separately from shared/all/custom scope', () => {
    const workspaceTypes = read('src/lib/workspaces.ts');
    const coreWorkspaces = read('../../crates/hq-desktop-core/src/workspaces.rs');
    const tauriWorkspaces = read('src-tauri/src/commands/workspaces.rs');
    const tauriMain = read('src-tauri/src/main.rs');

    expect(workspaceTypes).toContain('syncEnabled?: boolean;');
    expect(workspaceTypes).toContain('export function isWorkspaceSyncEnabled');

    expect(coreWorkspaces).toContain('pub sync_enabled: bool,');
    expect(coreWorkspaces).toContain('WORKSPACE_SYNC_ENABLED_KEY');
    expect(coreWorkspaces).toContain('write_workspace_sync_enabled');
    expect(coreWorkspaces).toContain('disabled_workspace_sync_slugs');
    expect(coreWorkspaces).toContain('fn replace_file');

    const daemon = read('../../crates/hq-desktop-core/src/daemon.rs');
    expect(daemon).toContain('is_personal_sync_enabled');
    expect(daemon).toContain('--skip-personal');
    expect(daemon).toContain('HQ_SYNC_SKIP_PERSONAL');

    expect(tauriWorkspaces).toContain('pub fn set_workspace_sync_enabled');
    expect(tauriWorkspaces).toContain('personal_sync_enabled = crate::commands::settings::get_settings()');
    expect(tauriWorkspaces).toContain('workspace.sync_enabled = if workspace.kind == WorkspaceKind::Personal');
    expect(tauriMain).toContain('commands::workspaces::set_workspace_sync_enabled');
  });

  it('renders Personal under Workspaces and keeps the sidebar control split between enabled and scope', () => {
    const sidebar = read('src/desktop-alt/v4/V4Sidebar.svelte');
    const syncMode = read('src/desktop-alt/v4/SidebarSyncMode.svelte');
    const settings = read('src/desktop-alt/pages/SettingsPage.svelte');
    const desktop = read('src/desktop-alt/DesktopApp.svelte');
    const companyPage = read('src/desktop-alt/pages/CompanyPage.svelte');

    expect(sidebar).toContain('Workspaces');
    expect(sidebar).toContain('Companies');
    expect(sidebar).toContain('ownerLabel');
    expect(sidebar).toContain('isPersonal={true}');
    expect(sidebar).toContain('onworkspaceenabledchange');

    expect(syncMode).toContain('personalSyncEnabled');
    expect(syncMode).toContain('set_workspace_sync_enabled');
    expect(syncMode).toContain("invoke<MembershipSyncConfig>('get_sync_mode'");
    expect(syncMode).toContain("invoke<MembershipSyncConfig>('set_sync_mode'");
    expect(syncMode).toContain('Shared');
    expect(syncMode).toContain('All');

    expect(settings).toContain('Sync personal vault');
    expect(settings).toContain('hq:workspace-sync-enabled-changed');

    expect(desktop).toContain('hq:workspace-sync-enabled-changed');
    expect(desktop).toContain('watchedCount={watchedWorkspaceCount}');
    expect(desktop).toContain('isSyncEnabledSlug(company.slug)');
    expect(desktop).toContain('activeCompanySyncEnabled ? activeCompany?.slug ?? null : null');
    expect(desktop).toContain("invoke('stop_daemon')");
    expect(desktop).toContain("invoke('start_daemon')");

    expect(companyPage).toContain('company.syncEnabled !== false');
  });
});
