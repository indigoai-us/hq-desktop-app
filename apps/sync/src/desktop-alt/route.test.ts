import { describe, expect, it } from 'vitest';
import type { Workspace } from '../lib/workspaces';
import {
  COMPANY_PRIMARY_SECTIONS,
  COMPANY_SECTIONS,
  companyHotkey,
  companyPrimarySectionForTab,
  companyTabForPrimarySection,
  fromV4Route,
  getDesktopCompanies,
  getDesktopHotkeyRoute,
  getDesktopLandingRoute,
  getDesktopRouteKey,
  getDesktopSecondarySidebar,
  isDesktopRouteActive,
  LIBRARY_SECTIONS,
  resolvePendingDesktopRoute,
  SETTINGS_SECTIONS,
  type DesktopRoute,
} from './route';

const baseCompany: Workspace = {
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
};

function company(overrides: Partial<Workspace>): Workspace {
  return {
    ...baseCompany,
    ...overrides,
    kind: 'company',
  };
}

describe('US-002 V4 desktop routes', () => {
  it('lands on the last-visited company, falling back to the first sidebar company row (US-007)', () => {
    const workspaces = [
      company({ slug: 'zed', displayName: 'Zed', state: 'synced' }),
      company({ slug: 'acme', displayName: 'Acme', state: 'synced' }),
    ];
    // Sidebar order is connected-first + alphabetical — Acme is the first row.
    expect(getDesktopLandingRoute(workspaces, null)).toEqual({ kind: 'company', slug: 'acme' });
    // A persisted last-visited slug wins while it still exists…
    expect(getDesktopLandingRoute(workspaces, 'zed')).toEqual({ kind: 'company', slug: 'zed' });
    // …and is ignored once the workspace disappears.
    expect(getDesktopLandingRoute(workspaces, 'ghost')).toEqual({ kind: 'company', slug: 'acme' });
    // No companies at all → Home, the exception surface (palette-only).
    expect(getDesktopLandingRoute([], null)).toEqual({ kind: 'home' });
  });

  it('exposes local-first companies plus the personal page in desktop navigation', () => {
    const visible = getDesktopCompanies([
      company({
        slug: 'synced',
        displayName: 'Synced',
        state: 'synced',
        hasLocalFolder: false,
      }),
      company({
        slug: 'local',
        displayName: 'Local',
        state: 'local-only',
        cloudUid: null,
      }),
      company({ slug: 'cloud', displayName: 'Cloud', state: 'cloud-only', hasLocalFolder: false }),
      company({ slug: 'broken', displayName: 'Broken', state: 'broken' }),
      {
        ...baseCompany,
        slug: 'personal',
        displayName: 'Personal',
        kind: 'personal',
        state: 'personal',
      },
    ]);

    // Local folders get a page even before they are cloud-backed. Cloud-only
    // memberships stay visible too. A stale/missing hasLocalFolder flag must
    // not erase a workspace returned by the backend.
    expect(visible.map((workspace) => workspace.slug)).toEqual([
      'synced',
      'local',
      'cloud',
      'broken',
      'personal',
    ]);
  });

  it('deduplicates repeated slugs before they reach keyed sidebar rendering', () => {
    const visible = getDesktopCompanies([
      company({ slug: 'dupe', displayName: 'Dupe Local', state: 'local-only' }),
      company({ slug: 'dupe', displayName: 'Dupe Cloud', state: 'cloud-only' }),
      company({ slug: 'next', displayName: 'Next' }),
    ]);

    expect(visible.map((workspace) => workspace.slug)).toEqual(['dupe', 'next']);
    expect(visible.map((workspace) => workspace.displayName)).toEqual(['Dupe Local', 'Next']);
  });

  it('declares the company sections with Skills/Workers/Knowledge/Team (no Accounts/Tasks/Library)', () => {
    expect(COMPANY_SECTIONS.map((section) => section.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
      'activity',
      'deployments',
      'secrets',
      'settings',
    ]);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'accounts')).toBe(false);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'tasks')).toBe(false);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'library')).toBe(false);
  });

  it('redirects legacy company deep-links: accounts→overview, tasks→projects, library→skills', () => {
    expect(resolvePendingDesktopRoute('company:indigo:accounts')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'overview',
    });
    expect(resolvePendingDesktopRoute('company:indigo:tasks')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'projects',
    });
    expect(resolvePendingDesktopRoute('company:indigo:library')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'skills',
    });
  });

  it('resolves new company tabs skills / workers / team; knowledge renders inline', () => {
    expect(resolvePendingDesktopRoute('company:indigo:skills')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'skills',
    });
    expect(resolvePendingDesktopRoute('company:indigo:team')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'team',
    });
    expect(resolvePendingDesktopRoute('company:indigo:knowledge')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'knowledge',
    });
  });

  it('declares the four library sections in SPEC order — Marketplace is top-level now (US-007)', () => {
    expect(LIBRARY_SECTIONS.map((section) => section.id)).toEqual([
      'skills',
      'workers',
      'installed',
      'profile',
    ]);
  });

  it('keys company pages by slug only so section switches never remount the page', () => {
    expect(getDesktopRouteKey({ kind: 'company', slug: 'indigo', tab: 'overview' })).toBe(
      'company:indigo',
    );
    expect(getDesktopRouteKey({ kind: 'company', slug: 'indigo', tab: 'secrets' })).toBe(
      'company:indigo',
    );
    expect(getDesktopRouteKey({ kind: 'library', tab: 'workers' })).toBe('library');
    expect(getDesktopRouteKey({ kind: 'home' })).toBe('home');
  });

  it('treats every section of a company as the same active sidebar destination', () => {
    const overview: DesktopRoute = { kind: 'company', slug: 'indigo', tab: 'overview' };
    const secrets: DesktopRoute = { kind: 'company', slug: 'indigo', tab: 'secrets' };
    expect(isDesktopRouteActive(overview, secrets)).toBe(true);
    expect(
      isDesktopRouteActive(overview, { kind: 'company', slug: 'other', tab: 'overview' }),
    ).toBe(false);
    expect(isDesktopRouteActive({ kind: 'library' }, { kind: 'library', tab: 'profile' })).toBe(
      true,
    );
  });
});

describe('US-008 hotkeys — ⌘1..9 renumbered after Inbox merge, no dead slots', () => {
  const companies = getDesktopCompanies([
    company({ slug: 'first', displayName: 'First', state: 'synced' }),
    company({ slug: 'second', displayName: 'Second', state: 'synced' }),
  ]);

  it('maps ⌘1–⌘4 to the four primary destinations in sidebar order (Inbox merged; no Home / Mission Control / Companies slots)', () => {
    const meta = (key: string) => getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
    expect(meta('1')).toEqual({ kind: 'inbox' });
    expect(meta('2')).toEqual({ kind: 'meetings' });
    expect(meta('3')).toEqual({ kind: 'marketplace' });
    expect(meta('4')).toEqual({ kind: 'library' });
  });

  it('maps ⌘5+ to companies in sidebar (connected-first) order, ctrl works too, and unmodified keys do nothing', () => {
    expect(
      getDesktopHotkeyRoute({ key: '5', metaKey: true, ctrlKey: false }, companies),
    ).toEqual({ kind: 'company', slug: 'first' });
    expect(
      getDesktopHotkeyRoute({ key: '6', metaKey: false, ctrlKey: true }, companies),
    ).toEqual({ kind: 'company', slug: 'second' });
    // Only two companies exist — ⌘7+ stay quiet rather than misfiring.
    expect(getDesktopHotkeyRoute({ key: '7', metaKey: true, ctrlKey: false }, companies)).toBeNull();
    expect(getDesktopHotkeyRoute({ key: '1', metaKey: false, ctrlKey: false }, companies)).toBeNull();
  });

  it('leaves no dead slot: with five companies every ⌘1–⌘9 key resolves', () => {
    const five = getDesktopCompanies([
      company({ slug: 'a', displayName: 'A', state: 'synced' }),
      company({ slug: 'b', displayName: 'B', state: 'synced' }),
      company({ slug: 'c', displayName: 'C', state: 'synced' }),
      company({ slug: 'd', displayName: 'D', state: 'synced' }),
      company({ slug: 'e', displayName: 'E', state: 'synced' }),
    ]);
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, five)).not.toBeNull();
    }
  });

  it('orders company hotkeys by the rendered sidebar rows, not the raw workspace list', () => {
    const unsorted = getDesktopCompanies([
      company({ slug: 'zeta', displayName: 'Zeta', state: 'local-only', cloudUid: null }),
      company({ slug: 'alpha', displayName: 'Alpha', state: 'synced' }),
    ]);
    // Alpha (connected) is the first sidebar row even though Zeta leads the list.
    expect(
      getDesktopHotkeyRoute({ key: '5', metaKey: true, ctrlKey: false }, unsorted),
    ).toEqual({ kind: 'company', slug: 'alpha' });
  });

  it('labels company hotkeys ⌘5–⌘9 and none past the ninth slot (US-008 renumber)', () => {
    expect(companyHotkey(0)).toBe('⌘5');
    expect(companyHotkey(4)).toBe('⌘9');
    expect(companyHotkey(5)).toBeUndefined();
  });
});

describe('US-002 pending-route aliases (desktop_alt_consume_pending_route)', () => {
  it("keeps the legacy 'sync' deep-link functional by landing it on Home", () => {
    expect(resolvePendingDesktopRoute('sync')).toEqual({ kind: 'home' });
  });

  it('resolves the V4 destinations and rejects unknown intents', () => {
    expect(resolvePendingDesktopRoute('meetings')).toEqual({ kind: 'meetings' });
    // Legacy intents resolve to the combined Inbox surface (US-008).
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('home')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'mission-control' });
    expect(resolvePendingDesktopRoute('marketplace')).toEqual({ kind: 'marketplace' });
    expect(resolvePendingDesktopRoute('library')).toEqual({ kind: 'library' });
    expect(resolvePendingDesktopRoute('settings')).toEqual({ kind: 'settings' });
    // The Companies page is gone (US-007) — a stale intent is ignored, not routed.
    expect(resolvePendingDesktopRoute('companies')).toBeNull();
    expect(resolvePendingDesktopRoute('bogus')).toBeNull();
    expect(resolvePendingDesktopRoute(null)).toBeNull();
  });

  it('resolves deep links into company sections, library tabs, and settings tabs', () => {
    expect(resolvePendingDesktopRoute('company:indigo:projects')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'projects',
    });
    expect(resolvePendingDesktopRoute('company/indigo/secrets')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'secrets',
    });
    expect(resolvePendingDesktopRoute('company:indigo:not-real')).toEqual({
      kind: 'company',
      slug: 'indigo',
    });
    // Legacy Library-tab alias — Marketplace is a top-level destination now (US-007).
    expect(resolvePendingDesktopRoute('library:marketplace')).toEqual({
      kind: 'marketplace',
    });
    expect(resolvePendingDesktopRoute('library:installed')).toEqual({
      kind: 'library',
      tab: 'installed',
    });
    expect(resolvePendingDesktopRoute('settings:meetings')).toEqual({
      kind: 'settings',
      tab: 'meetings',
    });
  });
});

describe('US-002 V4Sidebar payload narrowing', () => {
  it('maps sidebar payloads onto the DesktopRoute union', () => {
    expect(fromV4Route({ kind: 'company', slug: 'indigo' })).toEqual({
      kind: 'company',
      slug: 'indigo',
    });
    // DESKTOP-001: primary child clicks carry a tab; More aliases to activity.
    expect(fromV4Route({ kind: 'company', slug: 'indigo', tab: 'projects' })).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'projects',
    });
    expect(fromV4Route({ kind: 'company', slug: 'indigo', tab: 'more' })).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'activity',
    });
    expect(fromV4Route({ kind: 'settings' })).toEqual({ kind: 'settings' });
    expect(fromV4Route({ kind: 'library' })).toEqual({ kind: 'library' });
    // Marketplace is a top-level destination (US-007); the Companies kind is gone.
    expect(fromV4Route({ kind: 'marketplace' })).toEqual({ kind: 'marketplace' });
    expect(fromV4Route({ kind: 'companies' })).toEqual({ kind: 'home' });
    // Inbox + legacy V4 payload kinds land on the combined surface (US-008).
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'inbox' });
    // Unknown kinds land on Home, mirroring the sidebar model's fallback.
    expect(fromV4Route({ kind: 'mystery' })).toEqual({ kind: 'home' });
  });
});

describe('DESKTOP-001 secondary sidebar — library / settings only (no company column)', () => {
  const companies = [
    company({ slug: 'indigo', displayName: 'Indigo', state: 'synced', role: 'owner' }),
  ];

  it('never mounts a permanent company secondary sidebar', () => {
    expect(getDesktopSecondarySidebar({ kind: 'company', slug: 'indigo' }, companies)).toBeNull();
    expect(
      getDesktopSecondarySidebar(
        { kind: 'company', slug: 'indigo', tab: 'deployments' },
        companies,
      ),
    ).toBeNull();
    expect(getDesktopSecondarySidebar({ kind: 'company', slug: 'ghost' }, companies)).toBeNull();
  });

  it('declares compact primary company children (More, not Skills/Workers/Activity…)', () => {
    expect(COMPANY_PRIMARY_SECTIONS.map((s) => s.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'knowledge',
      'team',
      'more',
    ]);
    expect(companyPrimarySectionForTab('overview')).toBe('overview');
    expect(companyPrimarySectionForTab('activity')).toBe('more');
    expect(companyPrimarySectionForTab('deployments')).toBe('more');
    expect(companyPrimarySectionForTab('secrets')).toBe('more');
    expect(companyPrimarySectionForTab('skills')).toBeNull();
    expect(companyTabForPrimarySection('more')).toBe('activity');
    expect(companyTabForPrimarySection('knowledge')).toBe('knowledge');
  });

  it('shows the four library sections — without Marketplace — with the routed tab active', () => {
    const configuredPath = ['', 'Users', 'corey', 'Documents', 'HQ'].join('/');
    const model = getDesktopSecondarySidebar(
      { kind: 'library', tab: 'installed' },
      companies,
      { hqFolderPath: configuredPath },
    );
    expect(model?.surface).toBe('library');
    expect(model?.meta).toBe('~/Documents/HQ');
    expect(model?.items.map((item) => item.id)).toEqual(LIBRARY_SECTIONS.map((s) => s.id));
    expect(model?.items.some((item) => item.label === 'Marketplace')).toBe(false);
    expect(model?.activeId).toBe('installed');
    expect(getDesktopSecondarySidebar({ kind: 'library' }, companies)?.activeId).toBe('skills');
  });

  it('shows the settings sections with the gated Meetings note and a version meta', () => {
    const model = getDesktopSecondarySidebar({ kind: 'settings' }, companies, {
      version: '1.2.3',
    });
    expect(model?.surface).toBe('settings');
    expect(model?.meta).toBe('HQ v1.2.3');
    expect(model?.items.map((item) => item.id)).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(model?.items.find((item) => item.id === 'meetings')?.note).toBe('gated');
    expect(model?.activeId).toBe('sync');
  });

  it('has no secondary sidebar on Home, Mission Control, Marketplace, Inbox, Meetings, or Moderation', () => {
    for (const kind of [
      'home',
      'mission-control',
      'marketplace',
      'inbox',
      'meetings',
      'moderation',
    ] as const) {
      expect(getDesktopSecondarySidebar({ kind }, companies)).toBeNull();
    }
  });
});

describe('US-009 top-level Files mode', () => {
  const companies = [company({ slug: 'indigo', displayName: 'Indigo', state: 'synced' })];

  it('resolves the files pending-route, with and without a slug + path', () => {
    expect(resolvePendingDesktopRoute('files')).toEqual({ kind: 'files' });
    expect(resolvePendingDesktopRoute('files:indigo')).toEqual({ kind: 'files', slug: 'indigo' });
    // File paths contain '/', which the normaliser turns into ':'. The path
    // remainder after the slug must survive intact (restored to slashes).
    expect(resolvePendingDesktopRoute('files:indigo:companies/indigo/a.md')).toEqual({
      kind: 'files',
      slug: 'indigo',
      path: 'companies/indigo/a.md',
    });
  });

  it('keys Files mode on its kind only so company/file changes never remount the shell', () => {
    expect(getDesktopRouteKey({ kind: 'files' })).toBe('files');
    expect(getDesktopRouteKey({ kind: 'files', slug: 'indigo' })).toBe('files');
    expect(getDesktopRouteKey({ kind: 'files', slug: 'indigo', path: 'a/b.md' })).toBe('files');
  });

  it('treats every Files-mode route as the same active destination', () => {
    const route: DesktopRoute = { kind: 'files', slug: 'indigo', path: 'a/b.md' };
    expect(isDesktopRouteActive(route, { kind: 'files' })).toBe(true);
    expect(isDesktopRouteActive(route, { kind: 'files', slug: 'other' })).toBe(true);
    expect(isDesktopRouteActive(route, { kind: 'home' })).toBe(false);
  });

  it('renders no secondary sidebar in Files mode', () => {
    expect(getDesktopSecondarySidebar({ kind: 'files', slug: 'indigo' }, companies)).toBeNull();
    expect(
      getDesktopSecondarySidebar({ kind: 'files', slug: 'indigo', path: 'a/b.md' }, companies),
    ).toBeNull();
  });

  it('narrows the Files nav payload onto the DesktopRoute union with no slug', () => {
    expect(fromV4Route({ kind: 'files' })).toEqual({ kind: 'files' });
  });

  it('has dropped the company Files secondary-sidebar section', () => {
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'files')).toBe(false);
    // DESKTOP-001: company secondary column is gone entirely.
    expect(getDesktopSecondarySidebar({ kind: 'company', slug: 'indigo' }, companies)).toBeNull();
  });
});

describe('US-006 Mission Control destination', () => {
  it('is a primary destination route keyed on its own kind', () => {
    const route: DesktopRoute = { kind: 'mission-control' };
    expect(getDesktopRouteKey(route)).toBe('mission-control');
  });

  it('treats every Mission Control route as the same active sidebar destination', () => {
    const route: DesktopRoute = { kind: 'mission-control' };
    expect(isDesktopRouteActive(route, { kind: 'mission-control' })).toBe(true);
    expect(isDesktopRouteActive(route, { kind: 'home' })).toBe(false);
    expect(isDesktopRouteActive({ kind: 'home' }, route)).toBe(false);
  });

  it('resolves the backend navigation intent to the Mission Control route', () => {
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'mission-control' });
  });

  it('narrows a V4 sidebar payload for Mission Control onto the DesktopRoute union', () => {
    expect(fromV4Route({ kind: 'mission-control' })).toEqual({ kind: 'mission-control' });
  });

  it('has no ⌘ hotkey slot since US-007 — reachable via the palette intent only', () => {
    const companies = getDesktopCompanies([
      company({ slug: 'first', displayName: 'First', state: 'synced' }),
    ]);
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const routed = getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
      expect(routed?.kind).not.toBe('mission-control');
      expect(routed?.kind).not.toBe('home');
    }
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'mission-control' });
  });
});

describe('US-012 Mission Control destination — routing coverage gate', () => {
  const companies = [company({ slug: 'indigo', displayName: 'Indigo', state: 'synced' })];

  it('resolves the destination intent and trims surrounding whitespace', () => {
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'mission-control' });
    // The slash→colon normaliser must not split the hyphenated kind into a bogus
    // 'mission'/'control' pair — the whole token has to survive as one kind.
    expect(resolvePendingDesktopRoute('  mission-control  ')).toEqual({ kind: 'mission-control' });
  });

  it('renders no secondary sidebar — Mission Control is a full-width global surface', () => {
    expect(getDesktopSecondarySidebar({ kind: 'mission-control' }, companies)).toBeNull();
  });

  it('is a distinct primary destination, not aliased onto any other surface', () => {
    const route: DesktopRoute = { kind: 'mission-control' };
    for (const other of [
      { kind: 'home' },
      { kind: 'marketplace' },
      { kind: 'inbox' },
      { kind: 'meetings' },
      { kind: 'library' },
      { kind: 'settings' },
    ] as DesktopRoute[]) {
      expect(isDesktopRouteActive(route, other)).toBe(false);
      expect(getDesktopRouteKey(other)).not.toBe(getDesktopRouteKey(route));
    }
    // And it round-trips through the V4 sidebar payload narrowing unchanged.
    expect(fromV4Route({ kind: 'mission-control' })).toEqual(route);
  });
});
