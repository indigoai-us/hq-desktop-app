// US-009: Per-company Shared/All control (retired V4Sidebar hover slot) +
// rehome orphaned Connect/sync-mode controls after US-007 deleted CompaniesPage.
// Pure-model tests drive v4CompanyCloudActivated + cloudActivated row flags;
// source contracts lock SyncModeToggle invoke contracts (live surface after
// US-018 deleted SidebarSyncMode) and CompanyPage Connect/invite rehome.
// Leave __tests__/stories/US-009.test.ts alone — legacy suite from an older project.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/lib/workspaces';
import {
  sortV4CompaniesConnectedFirst,
  v4CompanyCloudActivated,
} from '../../src/desktop-alt/v4/model';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const syncModeSrc = readFileSync(root('src/components/SyncModeToggle.svelte'), 'utf8');
const companyPageSrc = readFileSync(root('src/desktop-alt/pages/CompanyPage.svelte'), 'utf8');
const routeSrc = readFileSync(root('src/desktop-alt/route.ts'), 'utf8');
const workspaceListSrc = readFileSync(root('src/components/WorkspaceList.svelte'), 'utf8');

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: 'indigo',
    displayName: 'Indigo',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cmp_1',
    bucketName: 'bucket',
    hasLocalFolder: true,
    localPath: '/tmp/HQ/companies/indigo',
    membershipStatus: 'active',
    role: 'member',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

describe('US-009: v4CompanyCloudActivated + cloudActivated row flag', () => {
  it('is true only for company rows with synced or cloud-only membership', () => {
    expect(v4CompanyCloudActivated(workspace({ state: 'synced' }))).toBe(true);
    expect(v4CompanyCloudActivated(workspace({ state: 'cloud-only' }))).toBe(true);
    expect(
      v4CompanyCloudActivated(
        workspace({ kind: 'personal', slug: 'personal', state: 'synced' }),
      ),
    ).toBe(false);
    expect(v4CompanyCloudActivated(workspace({ state: 'local-only', cloudUid: null }))).toBe(
      false,
    );
    expect(v4CompanyCloudActivated(workspace({ state: 'broken' }))).toBe(false);
  });

  it('is false for a pending (unaccepted) cloud-only invite — its affordance is Accept invite, not a sync-mode write', () => {
    expect(
      v4CompanyCloudActivated(
        workspace({ state: 'cloud-only', membershipStatus: 'pending' }),
      ),
    ).toBe(false);
    // Accepted cloud-only membership still gets the control.
    expect(
      v4CompanyCloudActivated(
        workspace({ state: 'cloud-only', membershipStatus: 'active' }),
      ),
    ).toBe(true);
  });

  it('sortV4CompaniesConnectedFirst rows carry cloudActivated matching the helper', () => {
    const rows = sortV4CompaniesConnectedFirst([
      workspace({ slug: 'indigo', displayName: 'Indigo', state: 'synced' }),
      workspace({
        slug: 'local-co',
        displayName: 'Local Co',
        state: 'local-only',
        cloudUid: null,
      }),
      workspace({
        kind: 'personal',
        slug: 'personal',
        displayName: 'Personal',
        state: 'synced',
      }),
      workspace({ slug: 'pending', displayName: 'Pending', state: 'cloud-only' }),
    ]);

    const bySlug = Object.fromEntries(rows.map((row) => [row.slug, row]));
    expect(bySlug.indigo.cloudActivated).toBe(true);
    expect(bySlug.pending.cloudActivated).toBe(true);
    expect(bySlug['local-co'].cloudActivated).toBe(false);
    expect(bySlug.personal.cloudActivated).toBe(false);
  });
});

describe('US-009: V4Sidebar + SidebarSyncMode retired (US-018)', () => {
  it('deleted the legacy sidebar hover surface; company rows still expose cloudActivated', () => {
    expect(existsSync(root('src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
    expect(existsSync(root('src/desktop-alt/v4/SidebarSyncMode.svelte'))).toBe(false);
    // cloudActivated remains on the pure company-row model for any surface that
    // gates Shared/All (FilesModeSidebar / future rehome still share this flag).
    const rows = sortV4CompaniesConnectedFirst([
      workspace({ slug: 'indigo', displayName: 'Indigo', state: 'synced' }),
    ]);
    expect(rows[0]?.cloudActivated).toBe(true);
  });
});

describe('US-009: SyncModeToggle source contracts (live Shared/All control)', () => {
  it('reads get_sync_mode and writes set_sync_mode with per-company slug', () => {
    expect(syncModeSrc).toContain("invoke<MembershipSyncConfig>('get_sync_mode', {");
    expect(syncModeSrc).toContain('companySlug: requestedSlug');
    expect(syncModeSrc).toContain("invoke<MembershipSyncConfig>('set_sync_mode', {");
    expect(syncModeSrc).toContain('mode: next');
    // Still mounted from WorkspaceList (popover / classic surfaces).
    expect(workspaceListSrc).toContain("import SyncModeToggle from './SyncModeToggle.svelte'");
    expect(workspaceListSrc).toContain('<SyncModeToggle');
  });

  it('optimistic-reverts on write failure, renders custom read-only, and keeps Shared/All labels', () => {
    expect(syncModeSrc).toContain('mode = trustedMode');
    expect(syncModeSrc).toContain("mode === 'custom'");
    expect(syncModeSrc).toContain('Custom paths');
    expect(syncModeSrc).toContain('hq sync mode custom');
    expect(syncModeSrc).toContain('data-testid="sync-mode-control"');
    expect(syncModeSrc).toContain('Shared');
    expect(syncModeSrc).toContain('All');
  });

  it('a failed read is retryable — the error state re-arms the lazy load', () => {
    expect(syncModeSrc).toContain('function retryLoad');
    expect(syncModeSrc).toContain('onclick={retryLoad}');
    expect(syncModeSrc).toContain('data-testid="sync-mode-retry"');
  });

  it('stays read-only while the cloud is unreachable (offline guard)', () => {
    expect(syncModeSrc).toContain('disabled={!cloudReachable || loading || savingMode !== null}');
    expect(syncModeSrc).toContain(
      'if (!cloudReachable || loading || savingMode !== null || mode === next) return;',
    );
  });

  it('documents the locally destructive All to Shared footprint reduction', () => {
    // Title/tooltip carries the destructive-footprint copy (confirm dialog
    // lived on the retired SidebarSyncMode; SyncModeToggle keeps the warning
    // in the control title so users still see it before switching).
    expect(syncModeSrc).toContain('Switching to Shared removes the rest from this machine');
    expect(syncModeSrc).toContain('not yet synced are never removed');
  });
});

describe('US-009: CompanyPage Connect + invite rehome', () => {
  it('gates Connect on local-only/broken and invokes connect_workspace_to_cloud', () => {
    expect(companyPageSrc).toContain("company.state === 'local-only' || company.state === 'broken'");
    expect(companyPageSrc).toContain("invoke('connect_workspace_to_cloud', { slug: company.slug })");
    expect(companyPageSrc).toContain('data-testid="company-connect"');
    // Offline guard preserved from the old WorkspaceList/Companies-page control.
    expect(companyPageSrc).toContain('disabled={connectBusy || !cloudReachable}');
  });

  it('pending-invite flow claims via claim_pending_company_invite (tokenless Accept)', () => {
    expect(companyPageSrc).toContain("'claim_pending_company_invite'");
    expect(companyPageSrc).toContain('companySlug: company.slug');
    expect(companyPageSrc).toContain('data-testid="company-accept-invite"');
    expect(companyPageSrc).not.toContain("openAgentWorkflow(prompt, 'invite acceptance')");
  });
});

describe('US-009: orphan checks after Companies page removal', () => {
  it('deleted Companies surfaces stay gone; rehomed controls stay reachable', () => {
    expect(existsSync(root('src/desktop-alt/pages/CompaniesPage.svelte'))).toBe(false);
    expect(existsSync(root('src/desktop-alt/components/SyncModeControl.svelte'))).toBe(false);
    expect(existsSync(root('src/desktop-alt/v4/SidebarSyncMode.svelte'))).toBe(false);
    expect(routeSrc).not.toMatch(/'companies'/);
    expect(syncModeSrc).toContain('set_sync_mode');
    expect(companyPageSrc).toContain('connect_workspace_to_cloud');
  });
});
