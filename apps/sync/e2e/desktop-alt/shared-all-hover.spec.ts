import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { v4CompanyCloudActivated } from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

/**
 * US-006 — US-009 per-company Shared/All control (cloud-activated gate).
 *
 * US-018 retired V4Sidebar + SidebarSyncMode. The cloud-activated gate remains
 * in model.ts for company-row consumers; the live Shared/All control is
 * SyncModeToggle (WorkspaceList / popover path) with the same get/set_sync_mode
 * server-persisted contract.
 */

const root = process.cwd();

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

describe('US-006 / US-009: v4CompanyCloudActivated gate (behavioral)', () => {
  it('true for cloud-activated company (synced or cloud-only, accepted)', () => {
    expect(
      v4CompanyCloudActivated(workspace({ state: 'synced', membershipStatus: 'active' })),
    ).toBe(true);
    expect(
      v4CompanyCloudActivated(workspace({ state: 'cloud-only', membershipStatus: 'active' })),
    ).toBe(true);
  });

  it('false for local-only / personal / pending-invite', () => {
    expect(
      v4CompanyCloudActivated(workspace({ state: 'local-only', membershipStatus: null })),
    ).toBe(false);
    expect(
      v4CompanyCloudActivated(
        workspace({
          slug: 'personal',
          displayName: 'Personal',
          kind: 'personal',
          state: 'personal',
          membershipStatus: null,
        }),
      ),
    ).toBe(false);
    expect(
      v4CompanyCloudActivated(
        workspace({ state: 'cloud-only', membershipStatus: 'pending' }),
      ),
    ).toBe(false);
    expect(
      v4CompanyCloudActivated(workspace({ state: 'broken', membershipStatus: 'active' })),
    ).toBe(false);
  });
});

describe('US-006 / US-009 / US-018: legacy sidebar sync control retired', () => {
  it('V4Sidebar and SidebarSyncMode no longer exist', () => {
    expect(existsSync(join(root, 'src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
    expect(existsSync(join(root, 'src/desktop-alt/v4/SidebarSyncMode.svelte'))).toBe(false);
  });
});

describe('US-006 / US-009: SyncModeToggle get/set_sync_mode (live control)', () => {
  const control = readRepoFile('src/components/SyncModeToggle.svelte');
  const workspaceList = readRepoFile('src/components/WorkspaceList.svelte');

  it('lazily fetches get_sync_mode and writes set_sync_mode', () => {
    expect(control).toContain("invoke<MembershipSyncConfig>('get_sync_mode'");
    expect(control).toContain('companySlug: requestedSlug');
    expect(control).toContain("invoke<MembershipSyncConfig>('set_sync_mode'");
    expect(control).toContain('mode: next');
    expect(control).toContain('data-testid="sync-mode-control"');
    expect(control).toContain('data-testid="sync-mode-shared"');
    expect(control).toContain('data-testid="sync-mode-all"');
  });

  it('WorkspaceList mounts SyncModeToggle for company rows', () => {
    expect(workspaceList).toContain("import SyncModeToggle from './SyncModeToggle.svelte'");
    expect(workspaceList).toContain('<SyncModeToggle slug={w.slug}');
  });
});
