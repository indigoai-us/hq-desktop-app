// US-009: Per-company Shared/All hover control in the V4 sidebar + rehome
// orphaned Connect/sync-mode controls after US-007 deleted CompaniesPage.
// Pure-model tests drive v4CompanyCloudActivated + cloudActivated row flags;
// source contracts lock sidebar reveal, SidebarSyncMode invoke contracts, and
// CompanyPage Connect/invite rehome. Leave __tests__/stories/US-009.test.ts
// alone — legacy suite from an older project.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/lib/workspaces';
import {
  sortV4CompaniesConnectedFirst,
  v4CompanyCloudActivated,
} from '../../src/desktop-alt/v4/model';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const sidebarSrc = readFileSync(root('src/desktop-alt/v4/V4Sidebar.svelte'), 'utf8');
const syncModeSrc = readFileSync(root('src/desktop-alt/v4/SidebarSyncMode.svelte'), 'utf8');
const companyPageSrc = readFileSync(root('src/desktop-alt/pages/CompanyPage.svelte'), 'utf8');
const routeSrc = readFileSync(root('src/desktop-alt/route.ts'), 'utf8');

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

describe('US-009: V4Sidebar source contracts', () => {
  it('gates the control on row.cloudActivated and mounts SidebarSyncMode', () => {
    expect(sidebarSrc).toContain('{#if row.cloudActivated');
    expect(sidebarSrc).toContain('<SidebarSyncMode');
    expect(sidebarSrc).toContain("import SidebarSyncMode from './SidebarSyncMode.svelte'");
  });

  it('reveals on hover/focus and keeps the nav button un-nested', () => {
    expect(sidebarSrc).toContain(':hover .v4-syncmode-slot');
    expect(sidebarSrc).toContain(':focus-within .v4-syncmode-slot');
    // Pointer reveal goes through a hover-intent delay (cancelled on
    // pointerleave) so a mouse sweep down the list doesn't mount every
    // control and fan out one vault round-trip per row; keyboard focus
    // reveals immediately.
    expect(sidebarSrc).toContain('onpointerenter={() => row.cloudActivated && queueReveal(row.slug)}');
    expect(sidebarSrc).toContain('onpointerleave={cancelPendingReveal}');
    expect(sidebarSrc).toContain('REVEAL_INTENT_MS');
    expect(sidebarSrc).toContain('onfocusin={() => row.cloudActivated && reveal(row.slug)}');
    // Wrapper is a div — buttons must not nest.
    expect(sidebarSrc).toMatch(/<div\s+class="v4-company-item"/);
    expect(sidebarSrc).toContain('class="v4-row v4-company-row"');
  });

  it('widens the company-name fade mask while the control is visible so text never doubles under the pill', () => {
    expect(sidebarSrc).toContain('.v4-company-item.has-syncmode:hover .v4-company-name');
    expect(sidebarSrc).toContain('.v4-company-item.has-syncmode:focus-within .v4-company-name');
  });
});

describe('US-009: SidebarSyncMode source contracts', () => {
  it('reads get_sync_mode and writes set_sync_mode with per-company slug', () => {
    expect(syncModeSrc).toContain("invoke<MembershipSyncConfig>('get_sync_mode', {");
    expect(syncModeSrc).toContain('companySlug: slug');
    expect(syncModeSrc).toContain("invoke<MembershipSyncConfig>('set_sync_mode', {");
    expect(syncModeSrc).toContain('mode: next');
  });

  it('optimistic-reverts on write failure, renders custom read-only, and stopPropagates clicks', () => {
    expect(syncModeSrc).toContain('mode = prev');
    expect(syncModeSrc).toContain("mode === 'custom'");
    expect(syncModeSrc).toContain('Custom paths — managed via `hq sync mode custom`');
    expect(syncModeSrc).toContain('event.stopPropagation()');
    expect(syncModeSrc).toContain('data-testid="sidebar-sync-mode"');
  });

  it('a failed read is retryable — the error state is a button that re-arms the lazy load', () => {
    expect(syncModeSrc).toContain('function retryLoad');
    expect(syncModeSrc).toContain('onclick={retryLoad}');
    expect(syncModeSrc).toContain('click to retry');
  });

  it('stays read-only while the cloud is unreachable (offline guard preserved from the classic toggle)', () => {
    expect(syncModeSrc).toContain('disabled = false');
    expect(syncModeSrc).toContain('disabled={disabled || saving}');
    expect(syncModeSrc).toContain('if (disabled || saving || mode === next) return;');
    expect(syncModeSrc).toContain('Cloud unreachable');
    // The sidebar wires the guard from list_syncable_workspaces.cloudReachable.
    expect(sidebarSrc).toContain('disabled={!effectiveCloudReachable}');
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
    expect(routeSrc).not.toMatch(/'companies'/);
    expect(syncModeSrc).toContain('set_sync_mode');
    expect(companyPageSrc).toContain('connect_workspace_to_cloud');
  });
});
