import { describe, expect, it } from 'vitest';
import {
  fromV4Route,
  getDesktopSecondarySidebar,
  type DesktopRoute,
} from '../../src/desktop-alt/route';
import { getV4SidebarModel } from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

/**
 * US-002 / DESKTOP-001 — V4 chrome composition.
 *
 * Source-contract + model harness. Company navigation expands inline in the
 * primary sidebar; the permanent company secondary column is gone.
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
    role: 'owner',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

describe('desktop-alt V4 chrome (US-002 / DESKTOP-001)', () => {
  it('a company row click opens the company page with primary children and Overview active', () => {
    const companies = [workspace({})];

    const clicked = fromV4Route({ kind: 'company', slug: 'indigo' });
    expect(clicked).toEqual({ kind: 'company', slug: 'indigo' } satisfies DesktopRoute);

    // DESKTOP-001: no permanent company secondary sidebar.
    expect(getDesktopSecondarySidebar(clicked, companies)).toBeNull();

    const sidebar = getV4SidebarModel(clicked, companies);
    const indigo = sidebar.companies.find((row) => row.slug === 'indigo');
    expect(indigo?.expanded).toBe(true);
    expect(indigo?.children.map((c) => c.label)).toEqual([
      'Overview',
      'Goals',
      'Projects',
      'Knowledge',
      'Team',
      'More',
    ]);
    expect(indigo?.children.find((c) => c.id === 'overview')?.active).toBe(true);
  });

  it('shows the secondary sidebar only on library / settings surfaces', () => {
    const companies = [workspace({})];
    for (const route of [
      { kind: 'home' },
      { kind: 'marketplace' },
      { kind: 'inbox' },
      { kind: 'meetings' },
      { kind: 'moderation' },
      { kind: 'company', slug: 'indigo' },
    ] satisfies DesktopRoute[]) {
      expect(getDesktopSecondarySidebar(route, companies)).toBeNull();
    }
    expect(getDesktopSecondarySidebar({ kind: 'library' }, companies)).not.toBeNull();
    expect(getDesktopSecondarySidebar({ kind: 'settings' }, companies)).not.toBeNull();
  });

  it('DesktopApp composes the V4 chrome (title bar + primary sidebar) and drops the old chrome', () => {
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');

    expect(desktopApp).toContain('<V4TitleBar');
    expect(desktopApp).toContain('<V4Sidebar');
    expect(desktopApp).toContain('let companies = $state<Workspace[]>(cachedCompanies)');
    expect(desktopApp).toContain('const nextCompanies = getDesktopCompanies(result.workspaces)');
    expect(desktopApp).toContain('companies = nextCompanies');
    expect(desktopApp).toContain('const shellCompanies = $derived');
    expect(desktopApp).toContain('const watchedWorkspaceCount = $derived(shellCompanies.length)');
    expect(desktopApp).toContain(
      'let renderCompanies = $state<Workspace[]>(cachedCompanies)',
    );
    expect(desktopApp).toContain('let renderWorkspaceCount = $state(cachedCompanies.length)');
    expect(desktopApp).toContain('renderCompanies = nextCompanies');
    expect(desktopApp).toContain('renderWorkspaceCount = nextCompanies.length');
    expect(desktopApp).toContain('writeCachedWorkspaces(result.workspaces)');
    expect(desktopApp).not.toContain('window.location.reload()');
    expect(desktopApp).toContain('companies={renderCompanies}');
    expect(desktopApp).not.toContain('{#key renderWorkspaceCount}');
    expect(desktopApp).not.toContain('chromeReady');
    expect(desktopApp).not.toContain('companies={workspaces}');
    // Secondary remains for library/settings; company secondary is gone.
    expect(desktopApp).toContain('{#if secondarySidebar');
    expect(desktopApp).toContain('<V4SecondarySidebar');
    expect(desktopApp).not.toContain('DesktopSidebar');
    // DESKTOP-001: bottom status bar removed from the shell.
    expect(desktopApp).not.toContain('<DesktopStatusBar');
  });

  it('the sidebar renders all companies directly instead of using an overflow row', () => {
    const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');
    const harnessMocks = readRepoFile('dev-harness/mocks/core.ts');

    expect(sidebar).toContain('class="v4-nav v4-company-nav"');
    expect(sidebar).toContain('flex: 1 1 auto');
    expect(sidebar).toContain('overflow-y: auto');
    expect(sidebar).toContain('companies,');
    expect(sidebar).toContain('companies && companies.length > 0 ? companies : fetched');
    expect(sidebar).toContain('if (companies && companies.length > 0) return');
    expect(sidebar).not.toContain('companies = null');
    expect(sidebar).not.toContain('data-testid="v4-more-companies"');
    expect(sidebar).not.toContain('model.overflowCount');
    expect(sidebar).not.toContain('View {model.overflowCount} more companies');
    expect(harnessMocks).toContain('const HARNESS_WORKSPACES');
    expect(harnessMocks).toContain("slug: 'sender-agency'");
    expect(harnessMocks).toContain("slug: 'archive-labs'");
  });

  it('DesktopStatusBar still exists as a component (version popout host) but is unmounted', () => {
    const statusBar = readRepoFile('src/desktop-alt/DesktopStatusBar.svelte');
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');

    expect(statusBar).toContain('workspaceCount,');
    expect(statusBar).toContain('const currentWorkspaceCount = $derived(workspaceCount ?? 0)');
    expect(desktopApp).not.toContain('workspaceCount={renderWorkspaceCount}');
  });

  it('the old segmented-control navigation is gone from company and library pages', () => {
    const company = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
    const library = readRepoFile('src/desktop-alt/pages/LibraryPage.svelte');

    expect(company).not.toContain('CompanyTabs');
    expect(company).not.toContain('role="tablist"');
    expect(library).toContain('forcedFilter={tab}');
  });

  it('settings uses the V4 secondary sidebar instead of rendering a second in-page index', () => {
    const settings = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');

    expect(settings).not.toContain('class="settings-index"');
    expect(settings).not.toContain('grid-template-columns: 180px minmax');
  });
});
