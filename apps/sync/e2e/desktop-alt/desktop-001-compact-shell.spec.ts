import { describe, expect, it } from 'vitest';
import {
  COMPANY_PRIMARY_SECTIONS,
  COMPANY_SECTIONS,
  companyPrimarySectionForTab,
  companyTabForPrimarySection,
  fromV4Route,
  getDesktopSecondarySidebar,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import {
  getV4SidebarModel,
  V4_COMPANY_PRIMARY_ITEMS,
  V4_NAV_ITEMS,
  v4CompanyPrimaryForTab,
} from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

/**
 * DESKTOP-001 — Compact native shell source contracts.
 *
 * Locks: single global sidebar with inline company children, no permanent
 * company secondary sidebar, no bottom status bar, titlebar chrome controls,
 * safe drag regions only on padded noninteractive space, light-mode hierarchy.
 */

function workspace(overrides: Partial<Workspace> = {}): Workspace {
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
    role: 'owner',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

describe('DESKTOP-001: compact native shell', () => {
  const companies = [
    workspace({}),
    workspace({ slug: 'liverecover', displayName: 'LiveRecover' }),
  ];

  it('primary nav remains Inbox / Meetings / Marketplace / Library / Files', () => {
    expect(V4_NAV_ITEMS.map((item) => item.id)).toEqual([
      'inbox',
      'meetings',
      'marketplace',
      'library',
      'files',
    ]);
  });

  it('selected company expands Overview / Goals / Projects / Knowledge / Team / More', () => {
    expect(COMPANY_PRIMARY_SECTIONS.map((s) => s.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'knowledge',
      'team',
      'more',
    ]);
    expect(V4_COMPANY_PRIMARY_ITEMS.map((s) => s.id)).toEqual(
      COMPANY_PRIMARY_SECTIONS.map((s) => s.id),
    );

    const model = getV4SidebarModel({ kind: 'company', slug: 'indigo' }, companies);
    const active = model.companies.find((row) => row.slug === 'indigo');
    expect(active?.expanded).toBe(true);
    expect(active?.children.map((c) => c.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'knowledge',
      'team',
      'more',
    ]);
    expect(active?.children.find((c) => c.id === 'overview')?.active).toBe(true);

    const other = model.companies.find((row) => row.slug === 'liverecover');
    expect(other?.expanded).toBe(false);
    expect(other?.children).toEqual([]);
  });

  it('collapses company children on global destinations', () => {
    for (const kind of ['inbox', 'meetings', 'marketplace', 'library', 'files'] as const) {
      const model = getV4SidebarModel({ kind }, companies);
      expect(model.companies.every((row) => !row.expanded)).toBe(true);
      expect(model.companies.every((row) => row.children.length === 0)).toBe(true);
    }
  });

  it('operational tabs light More; skills/workers remain route-supported without a primary child', () => {
    expect(v4CompanyPrimaryForTab('activity')).toBe('more');
    expect(v4CompanyPrimaryForTab('deployments')).toBe('more');
    expect(v4CompanyPrimaryForTab('secrets')).toBe('more');
    expect(v4CompanyPrimaryForTab('settings')).toBe('more');
    expect(v4CompanyPrimaryForTab('skills')).toBeNull();
    expect(companyPrimarySectionForTab('secrets')).toBe('more');
    expect(companyPrimarySectionForTab('settings')).toBe('more');
    expect(companyTabForPrimarySection('more')).toBe('activity');

    const model = getV4SidebarModel(
      { kind: 'company', slug: 'indigo', tab: 'deployments' },
      companies,
    );
    expect(model.companies.find((r) => r.slug === 'indigo')?.children.find((c) => c.id === 'more')
      ?.active).toBe(true);

    // Full operational + skills/workers deep links still resolve.
    for (const tab of ['skills', 'workers', 'activity', 'deployments', 'secrets', 'settings'] as const) {
      expect(resolvePendingDesktopRoute(`company:indigo:${tab}`)).toEqual({
        kind: 'company',
        slug: 'indigo',
        tab,
      });
      expect(COMPANY_SECTIONS.some((s) => s.id === tab)).toBe(true);
    }
    expect(fromV4Route({ kind: 'company', slug: 'indigo', tab: 'more' })).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'activity',
    });
  });

  it('never mounts a permanent company secondary sidebar', () => {
    expect(getDesktopSecondarySidebar({ kind: 'company', slug: 'indigo' }, companies)).toBeNull();
    expect(getDesktopSecondarySidebar({ kind: 'library' }, companies)?.surface).toBe('library');
    expect(getDesktopSecondarySidebar({ kind: 'settings' }, companies)?.surface).toBe('settings');
  });

  it('DesktopApp composes compact shell: titlebar controls, no status bar, no company secondary', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const css = readRepoFile('src/desktop-alt/styles/desktop-alt.css');

    expect(app).toContain('<V4TitleBar');
    expect(app).toContain('ontogglesidebar={handleToggleSidebar}');
    expect(app).toContain('oncommand={handleOpenCommandPalette}');
    expect(app).toContain('onaccount={handleAccountMenu}');
    expect(app).toContain('let sidebarCollapsed = $state(false)');
    expect(app).toContain('class:sidebar-collapsed={sidebarCollapsed}');
    expect(app).toContain('<V4Sidebar');
    expect(app).not.toContain('<DesktopStatusBar');
    expect(app).not.toContain("import DesktopStatusBar");
    // Secondary remains for library/settings only.
    expect(app).toContain('{#if secondarySidebar}');
    expect(app).toContain('<V4SecondarySidebar');

    expect(css).toContain('/* DESKTOP-001: titlebar + body only — bottom status bar grid row removed. */');
    // Shell grid is titlebar + body only (no status-bar row).
    expect(css).toMatch(
      /\.desktop-shell\s*\{[\s\S]*?grid-template-rows:\s*var\(--desktop-titlebar-height[^)]*\)\s+minmax\(0,\s*1fr\);/,
    );
  });

  it('titlebar owns sidebar toggle, sync status, command search, sync, account; drag only on pads', () => {
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');

    expect(titleBar).toMatch(/Show sidebar|Hide sidebar/);
    expect(titleBar).toContain('aria-label="Open command palette"');
    expect(titleBar).toContain('aria-label="Account and settings"');
    expect(titleBar).toContain('class="v4-action"');
    expect(titleBar).toContain('class="v4-status"');
    // Drag region is on padded spacers only — not the whole header.
    expect(titleBar).not.toMatch(/<header class="v4-titlebar" data-tauri-drag-region/);
    expect(titleBar).toContain('data-tauri-drag-region');
    expect(titleBar).toContain('class="v4-drag-pad v4-drag-lights"');
    expect(titleBar).toContain('class="v4-drag-pad v4-drag-flex"');
    expect(titleBar).toMatch(/\.v4-status\s*\{[\s\S]*?pointer-events: none;/);
  });

  it('sidebar renders company children and collapses them for global routes (source)', () => {
    const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');
    expect(sidebar).toContain('v4-company-children');
    expect(sidebar).toContain('goCompanySection');
    expect(sidebar).toContain("data-testid={`company-children-${row.slug}`}");
    expect(sidebar).toContain("child.id === 'more'");
  });

  it('light-mode tokens keep chrome darker than canvas and raised lighter than canvas', () => {
    const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
    expect(tokens).toContain('--v4-ground: #f7f8fa');
    expect(tokens).toContain('--v4-chrome: rgba(222, 227, 233, 0.94)');
    expect(tokens).toContain('--v4-sidebar: rgba(222, 227, 233, 0.94)');
    expect(tokens).toContain('--v4-raised: #ffffff');
    expect(tokens).toContain('DESKTOP-001 light hierarchy');
  });
});
