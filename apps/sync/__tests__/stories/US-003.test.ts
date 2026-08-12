import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import type { Workspace } from '../../src/lib/workspaces';
import {
  getDesktopCompanies,
  getDesktopActiveCompany,
  getDesktopHotkeyRoute,
  getDesktopLandingRoute,
  getDesktopRouteKey,
  isDesktopRouteActive,
  type DesktopRoute,
} from '../../src/desktop-alt/route';
import { sortV4CompaniesConnectedFirst, V4_CHROME_LAYOUT } from '../../src/desktop-alt/v4/model';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const desktopApp = readFileSync(root('src/desktop-alt/DesktopApp.svelte'), 'utf8');

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: 'personal',
    displayName: 'Personal',
    kind: 'personal',
    state: 'personal',
    cloudUid: null,
    bucketName: null,
    hasLocalFolder: true,
    localPath: '/Users/test/HQ',
    membershipStatus: null,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

const workspaces: Workspace[] = [
  workspace({ slug: 'personal', displayName: 'Personal', kind: 'personal' }),
  workspace({
    slug: 'acme',
    displayName: 'Acme Corp',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cloud-acme',
    bucketName: 'hq-acme',
    membershipStatus: 'active',
  }),
  workspace({
    slug: 'globex',
    displayName: 'Globex',
    kind: 'company',
    state: 'cloud-only',
    cloudUid: 'cloud-globex',
    bucketName: 'hq-globex',
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: 'active',
  }),
];

describe('US-003: Desktop-alt app shell — chat sidebar, route state, ⌘ hotkeys (US-018 retired V4 nav)', () => {
  it('keeps V4 chrome metrics and mounts ChatSidebar (legacy V4Sidebar retired)', () => {
    // The V4 window redesign (US-001/US-002) established the 220px raised
    // sidebar + 40px title bar + 200px contextual secondary sidebar. US-018
    // retired V4Sidebar / getV4SidebarModel; ChatSidebar is the live primary.
    expect(V4_CHROME_LAYOUT).toEqual({
      titleBarHeightPx: 40,
      primarySidebarWidthPx: 220,
      secondarySidebarWidthPx: 200,
    });
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(existsSync(root('src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
    expect(desktopApp).toContain("import ChatSidebar from './chat/ChatSidebar.svelte'");
    expect(desktopApp).toContain('<ChatSidebar');
    expect(desktopApp).not.toMatch(/import\s+V4Sidebar\b/);
    expect(desktopApp).not.toMatch(/<V4Sidebar\b/);
  });

  it('lands on the first connected company and sorts companies connected-first', () => {
    const landing = getDesktopLandingRoute(workspaces, null);
    expect(landing).toEqual({ kind: 'company', slug: 'acme' });

    // Connected-first sort (US-007): personal (always live), acme (synced) and
    // globex (cloud-only) are all connected, so they list alphabetically by
    // display name within the single connected group.
    const companies = sortV4CompaniesConnectedFirst(workspaces, landing.kind === 'company' ? landing.slug : null);
    expect(companies.filter((row) => row.active).map((row) => row.slug)).toEqual(['acme']);
    expect(companies.map((row) => row.label)).toEqual([
      'Acme Corp',
      'Globex',
      'Personal',
    ]);
    // The landing route resolves its company.
    expect(
      getDesktopActiveCompany(landing, getDesktopCompanies(workspaces)),
    ).toMatchObject({ slug: 'acme' });
  });

  it('switches the main pane to Meetings when the user presses ⌘2 (US-008 renumber)', () => {
    const companies = getDesktopCompanies(workspaces);
    const nextRoute = getDesktopHotkeyRoute(
      { key: '2', metaKey: true, ctrlKey: false },
      companies,
    );

    expect(nextRoute).toEqual({ kind: 'meetings' });
    expect(getDesktopRouteKey(nextRoute as DesktopRoute)).toBe('meetings');
    // Meetings is a non-company route — no active company resolves.
    expect(getDesktopActiveCompany(nextRoute as DesktopRoute, companies)).toBeNull();
  });

  it('gives personal a navigable page and marks a clicked company row active', () => {
    const companies = getDesktopCompanies(workspaces);

    // Company hotkeys start at ⌘5 (US-008 renumber) and follow the rendered
    // sidebar order (connected-first + alphabetical): Acme Corp, Globex, Personal.
    expect(
      getDesktopHotkeyRoute({ key: '5', metaKey: true, ctrlKey: false }, companies),
    ).toEqual({ kind: 'company', slug: 'acme' });
    expect(
      getDesktopHotkeyRoute({ key: '7', metaKey: true, ctrlKey: false }, companies),
    ).toEqual({ kind: 'company', slug: 'personal' });

    const nextRoute: DesktopRoute = { kind: 'company', slug: 'acme' };
    expect(getDesktopRouteKey(nextRoute)).toBe('company:acme');
    expect(getDesktopActiveCompany(nextRoute, companies)).toMatchObject({ slug: 'acme' });
    expect(isDesktopRouteActive(nextRoute, { kind: 'company', slug: 'acme' })).toBe(true);

    // The company model highlights the clicked company row — and nothing else.
    const model = sortV4CompaniesConnectedFirst(workspaces, 'acme');
    expect(model.filter((row) => row.active).map((row) => row.slug)).toEqual(['acme']);
    expect(model.filter((row) => row.slug !== 'acme').every((row) => !row.active)).toBe(true);

    // Globex is cloud-only (no synced local vault) but still gets a desktop
    // page so the user can see and act on the membership instead of losing it.
    expect(companies.find((company) => company.slug === 'globex')).toMatchObject({
      slug: 'globex',
      state: 'cloud-only',
    });
    expect(
      getDesktopActiveCompany({ kind: 'company', slug: 'globex' }, companies),
    ).toMatchObject({ slug: 'globex' });
  });
});
