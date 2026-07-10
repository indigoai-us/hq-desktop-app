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
import { getV4SidebarModel, V4_CHROME_LAYOUT } from '../../src/desktop-alt/v4/model';

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

describe('US-003: Desktop-alt app shell — sidebar, route state, ⌘ hotkeys (V4 IA since US-002)', () => {
  it('shows the V4 sidebar with the five nav destinations and the COMPANIES section on mount', () => {
    // The V4 window redesign (US-001/US-002) replaced the 216px rail + 42px
    // titlebar with the 220px raised sidebar + 40px title bar + 200px
    // contextual secondary sidebar. hq-desktop-widget US-007 later removed the
    // Home / Mission Control / Companies rows (palette-only routes now),
    // promoted Marketplace top-level, and lands on the first company row.
    expect(V4_CHROME_LAYOUT).toEqual({
      titleBarHeightPx: 40,
      primarySidebarWidthPx: 220,
      secondarySidebarWidthPx: 200,
    });
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);

    const landing = getDesktopLandingRoute(workspaces, null);
    expect(landing).toEqual({ kind: 'company', slug: 'acme' });
    const model = getV4SidebarModel(landing, workspaces);
    // hq-desktop-widget US-008 merged Messages + Notifications into Inbox.
    expect(model.nav.map((row) => row.label)).toEqual([
      'Inbox',
      'Meetings',
      'Marketplace',
      'Library',
      'Files',
    ]);
    // The landing company row is the only active row — no nav item lights.
    expect(model.nav.every((row) => !row.active)).toBe(true);
    expect(model.companies.filter((row) => row.active).map((row) => row.slug)).toEqual(['acme']);
    // Connected-first sort (US-007): personal (always live), acme (synced) and
    // globex (cloud-only) are all connected, so they list alphabetically by
    // display name within the single connected group.
    expect(model.companies.map((row) => row.label)).toEqual([
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

    // Company hotkeys start at ⌘5 (US-008 renumber after the Inbox merge) and
    // follow the rendered sidebar order (connected-first + alphabetical):
    // Acme Corp, Globex, Personal.
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

    // The sidebar highlights the clicked company row — and nothing else.
    const model = getV4SidebarModel(nextRoute, workspaces);
    expect(model.companies.filter((row) => row.active).map((row) => row.slug)).toEqual(['acme']);
    expect(model.nav.every((row) => !row.active)).toBe(true);

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
