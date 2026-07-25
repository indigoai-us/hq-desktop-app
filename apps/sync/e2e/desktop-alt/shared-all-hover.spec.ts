import { describe, expect, it } from 'vitest';
import { v4CompanyCloudActivated } from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

/**
 * US-006 — US-009 per-company Shared/All hover control.
 *
 * Locks the cloud-activated gate + hover-intent mount path:
 *  - v4CompanyCloudActivated true only for accepted company memberships
 *    (synced / cloud-only, not pending).
 *  - V4Sidebar mounts SidebarSyncMode only for cloud-activated rows after
 *    hover/focus (hover-intent delay) with CSS reveal on the slot.
 *  - SidebarSyncMode lazily fetches get_sync_mode and writes set_sync_mode
 *    (server-persisted per company slug → restart + tenant isolation).
 */

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

describe('US-006 / US-009: V4Sidebar hover mount + CSS reveal', () => {
  const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');

  it('mounts SidebarSyncMode only for cloud-activated rows after hover/focus', () => {
    expect(sidebar).toContain("import SidebarSyncMode from './SidebarSyncMode.svelte'");
    expect(sidebar).toContain('const REVEAL_INTENT_MS = 140');
    expect(sidebar).toContain('hover-intent delay');
    // DESKTOP-001: hide Shared/All when the company row is expanded (children
    // occupy that vertical space); hover still reveals on collapsed rows.
    expect(sidebar).toContain(
      'onpointerenter={() => row.cloudActivated && !row.expanded && queueReveal(row.slug)}',
    );
    expect(sidebar).toContain(
      'onfocusin={() => row.cloudActivated && !row.expanded && reveal(row.slug)}',
    );
    expect(sidebar).toContain(
      '{#if row.cloudActivated && !row.expanded && revealedSlugs.has(row.slug)}',
    );
    expect(sidebar).toContain('<SidebarSyncMode');
    expect(sidebar).toContain('class:has-syncmode={row.cloudActivated && !row.expanded}');
  });

  it('CSS reveal uses company-item hover on the syncmode slot', () => {
    expect(sidebar).toContain('.v4-company-item:hover .v4-syncmode-slot');
    expect(sidebar).toContain('.v4-company-item:focus-within .v4-syncmode-slot');
    expect(sidebar).toContain('class="v4-syncmode-slot"');
  });
});

describe('US-006 / US-009: SidebarSyncMode get/set_sync_mode', () => {
  const control = readRepoFile('src/desktop-alt/v4/SidebarSyncMode.svelte');

  it('lazily fetches get_sync_mode on mount and writes set_sync_mode', () => {
    expect(control).toContain("invoke<MembershipSyncConfig>('get_sync_mode'");
    expect(control).toContain('companySlug: slug');
    expect(control).toContain("invoke<MembershipSyncConfig>('set_sync_mode'");
    expect(control).toContain('mode: next');
    // Lazy mount contract — parent only mounts after first hover/focus.
    expect(control).toContain(
      'lazily fetches `get_sync_mode` on mount (parent only mounts',
    );
    expect(control).toContain('after first hover/focus)');
    expect(control).toContain('writes via `set_sync_mode`');
  });
});
