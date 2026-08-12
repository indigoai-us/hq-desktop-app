import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fromV4Route,
  getDesktopSecondarySidebar,
  type DesktopRoute,
} from '../../src/desktop-alt/route';
import { sortV4CompaniesConnectedFirst } from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

/**
 * US-002 / DESKTOP-001 / US-018 — V4 chrome composition.
 *
 * Source-contract + model harness. Company navigation expands via
 * sortV4CompaniesConnectedFirst; ChatSidebar is the primary chrome;
 * the permanent company secondary column is gone; V4Sidebar is retired.
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
    role: 'owner',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

describe('desktop-alt V4 chrome (US-002 / DESKTOP-001 / US-018)', () => {
  it('a company row click opens the company page with primary children and Overview active', () => {
    const companies = [workspace({})];

    const clicked = fromV4Route({ kind: 'company', slug: 'indigo' });
    expect(clicked).toEqual({ kind: 'company', slug: 'indigo' } satisfies DesktopRoute);

    // DESKTOP-001: no permanent company secondary sidebar.
    expect(getDesktopSecondarySidebar(clicked, companies)).toBeNull();

    const rows = sortV4CompaniesConnectedFirst(companies, 'indigo', 'overview');
    const indigo = rows.find((row) => row.slug === 'indigo');
    expect(indigo?.expanded).toBe(true);
    expect(indigo?.children.map((c) => c.label)).toEqual([
      'Overview',
      'Goals',
      'Projects',
      'Skills',
      'Workers',
      'Knowledge',
      'Team',
      'More',
    ]);
    expect(indigo?.children.find((c) => c.id === 'overview')?.active).toBe(true);
  });

  it('shows the secondary sidebar only on settings (library is US-017 overlay)', () => {
    const companies = [workspace({})];
    for (const route of [
      { kind: 'home' },
      { kind: 'marketplace' },
      { kind: 'notifications' },
      { kind: 'meetings' },
      { kind: 'moderation' },
      { kind: 'company', slug: 'indigo' },
      { kind: 'library' },
    ] satisfies DesktopRoute[]) {
      expect(getDesktopSecondarySidebar(route, companies)).toBeNull();
    }
    expect(getDesktopSecondarySidebar({ kind: 'settings' }, companies)).not.toBeNull();
  });

  it('DesktopApp composes the V4 chrome (title bar + ChatSidebar) and drops the old chrome', () => {
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');

    expect(desktopApp).toContain('<V4TitleBar');
    // US-003 / US-018: chat-first primary sidebar; V4Sidebar deleted.
    expect(desktopApp).toContain('<ChatSidebar');
    expect(desktopApp).toContain("import ChatSidebar from './chat/ChatSidebar.svelte'");
    expect(desktopApp).not.toContain('<V4Sidebar');
    expect(existsSync(join(root, 'src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
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
    // Secondary remains for settings; library is US-017 overlay; company secondary is gone.
    expect(desktopApp).toContain('{#if secondarySidebar');
    expect(desktopApp).toContain('<V4SecondarySidebar');
    expect(desktopApp).not.toContain('DesktopSidebar');
    // DESKTOP-001: bottom status bar removed from the shell.
    expect(desktopApp).not.toContain('<DesktopStatusBar');
  });

  it('renders a minimal title bar (D-04) without V1 chrome', () => {
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');

    expect(titleBar).toContain('data-testid="titlebar-wordmark"');
    expect(titleBar).toContain('data-testid="titlebar-day-date"');
    expect(titleBar).toContain('data-testid="titlebar-meetings"');
    expect(titleBar).toContain('data-testid="titlebar-notifications"');
    expect(titleBar).toContain('data-testid="titlebar-core-pill"');
    expect(titleBar).toContain('v4-notif-dot');
    // Removed V1 chrome.
    expect(titleBar).not.toContain('class="v4-status"');
    expect(titleBar).not.toContain('data-testid="cloud-connected-switch"');
    expect(titleBar).not.toContain('data-testid="version-label"');
    expect(titleBar).not.toContain('class="v4-account"');
    expect(titleBar).not.toContain('Sync Now');
    expect(titleBar).not.toContain('finish sync in Claude Code');
  });

  it('ChatSidebar owns conversation list scrolling; FilesModeSidebar lists all companies without overflow row', () => {
    const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
    const filesSidebar = readRepoFile('src/desktop-alt/v4/FilesModeSidebar.svelte');
    const harnessMocks = readRepoFile('dev-harness/mocks/core.ts');

    expect(chatSidebar).toContain('data-testid="chat-sidebar"');
    expect(chatSidebar).toContain('class="chat-list"');
    expect(chatSidebar).toContain('data-testid="chat-conversation-list"');
    expect(chatSidebar).toMatch(/\.chat-scroll\s*\{[\s\S]*?overflow-y:\s*auto/);

    // Files mode still lists every company (no "View N more companies" overflow).
    expect(filesSidebar).toContain('sortV4CompaniesConnectedFirst');
    expect(filesSidebar).not.toContain('data-testid="v4-more-companies"');
    expect(filesSidebar).not.toContain('View {model.overflowCount} more companies');
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
