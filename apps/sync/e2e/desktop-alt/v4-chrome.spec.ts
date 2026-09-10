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
      'Skills',
      'Workers',
      'Knowledge',
      'Clients',
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
    expect(desktopApp).toContain('const nextCompanies = getDesktopCompanies(nextWorkspaces)');
    expect(desktopApp).toContain('companies = nextCompanies');
    expect(desktopApp).toContain('const shellCompanies = $derived');
    expect(desktopApp).toContain(
      'const watchedWorkspaceCount = $derived(watchedCompanies.length)',
    );
    expect(desktopApp).toContain(
      'let renderCompanies = $state<Workspace[]>(cachedCompanies)',
    );
    expect(desktopApp).toContain('let renderWorkspaceCount = $state(cachedCompanies.length)');
    expect(desktopApp).toContain('renderCompanies = nextCompanies');
    expect(desktopApp).toContain('renderWorkspaceCount = nextCompanies.length');
    expect(desktopApp).toContain('writeCachedWorkspaces(nextWorkspaces)');
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

  it('renders the title-bar model error sentence and detail without misleading recovery copy', () => {
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');

    expect(titleBar).toContain('{model.sentence}');
    expect(titleBar).toContain('{model.meta}');
    expect(titleBar).toContain('catch (err)');
    expect(titleBar).toContain('class="v4-action-error" role="alert"');
    expect(titleBar).toContain("syncState === 'auth-error'");
    expect(titleBar).toContain("'Couldn’t start sign-in'");
    expect(titleBar).not.toContain('Sync initialized');
    expect(titleBar).not.toContain('finish sync in Claude Code');
  });

  it('exposes optional back/forward history controls without changing unsupported hosts', () => {
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');

    expect(titleBar).toContain('canGoBack?: boolean');
    expect(titleBar).toContain('canGoForward?: boolean');
    expect(titleBar).toContain('backLabel?: string');
    expect(titleBar).toContain('forwardLabel?: string');
    expect(titleBar).toContain('onback?: () => void');
    expect(titleBar).toContain('onforward?: () => void');
    expect(titleBar).toContain('data-testid="titlebar-back"');
    expect(titleBar).toContain('data-testid="titlebar-forward"');
    expect(titleBar).toContain('data-testid="titlebar-history"');
    expect(titleBar).toContain('data-tauri-drag-region="false"');
    expect(titleBar).toContain('{#if showHistoryControls}');
    expect(titleBar).toContain("aria-label=\"Back\"");
    expect(titleBar).toContain("aria-label=\"Forward\"");
    // Legacy desktop-alt DesktopApp does not wire history — chrome stays unchanged.
    expect(desktopApp).not.toContain('onback=');
    expect(desktopApp).not.toContain('onforward=');
    expect(desktopApp).not.toContain('canGoBack=');
  });

  it('shared-shell title bar places Back/Forward immediately after the day-date', () => {
    const sharedTitleBar = readRepoFile('../../packages/ui/src/home/V4TitleBar.svelte');
    const sharedShell = readRepoFile('../../packages/ui/src/shell/DesktopApp.svelte');
    const dateNeedle = 'data-testid="titlebar-day-date"';
    const historyNeedle = 'data-testid="titlebar-history"';
    const date = sharedTitleBar.indexOf(dateNeedle);
    const history = sharedTitleBar.indexOf(historyNeedle);
    expect(date).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(date);
    expect(sharedTitleBar.slice(date + dateNeedle.length, history)).not.toMatch(
      /data-testid="titlebar-/,
    );
    expect(sharedTitleBar).toContain('data-tauri-drag-region="false"');
    expect(sharedTitleBar).toContain('data-testid="titlebar-back"');
    expect(sharedTitleBar).toContain('data-testid="titlebar-forward"');
    expect(sharedShell).toContain('canGoBack={navigationCanGoBack}');
    expect(sharedShell).toContain('canGoForward={navigationCanGoForward}');
    expect(sharedShell).toContain('onback={() => void goBack()}');
    expect(sharedShell).toContain('onforward={() => void goForward()}');
    expect(sharedShell).toContain('consumeNavigationShortcut(event, {');
  });

  it('the sidebar renders all companies directly instead of using an overflow row', () => {
    const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');
    const harnessMocks = readRepoFile('dev-harness/mocks/core.ts');

    expect(sidebar).toContain('class="v4-nav v4-company-nav"');
    expect(sidebar).toContain('flex: 1 1 auto');
    expect(sidebar).toContain('overflow-y: auto');
    expect(sidebar).toContain('companies,');
    expect(sidebar).toContain('companies ?? fetched');
    expect(sidebar).toContain('if (companies != null) return');
    expect(sidebar).not.toContain('companies && companies.length > 0 ? companies : fetched');
    expect(sidebar).not.toContain('companies = null');
    expect(sidebar).not.toContain('data-testid="v4-more-companies"');
    expect(sidebar).not.toContain('model.overflowCount');
    expect(sidebar).not.toContain('View {model.overflowCount} more companies');
    expect(harnessMocks).toContain('const HARNESS_WORKSPACES');
    expect(harnessMocks).toContain("slug: 'sender-agency'");
    expect(harnessMocks).toContain("slug: 'archive-labs'");
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
