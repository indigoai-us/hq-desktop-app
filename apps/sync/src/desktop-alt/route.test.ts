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
  getDesktopSessionScopeSlug,
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

describe('US-008 / US-018 hotkeys — ⌘1 Notifications, ⌘2–4 primary, ⌘5–9 companies', () => {
  const companies = getDesktopCompanies([
    company({ slug: 'first', displayName: 'First', state: 'synced' }),
    company({ slug: 'second', displayName: 'Second', state: 'synced' }),
  ]);

  it('maps ⌘1–⌘4 to the four primary destinations (Notifications replaces retired Inbox)', () => {
    const meta = (key: string) => getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
    expect(meta('1')).toEqual({ kind: 'notifications' });
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

describe('US-002 / US-018 pending-route aliases (desktop_alt_consume_pending_route)', () => {
  it("keeps the legacy 'sync' deep-link functional by landing it on Home", () => {
    expect(resolvePendingDesktopRoute('sync')).toEqual({ kind: 'home' });
  });

  it('resolves live destinations and remaps retired legacy names (never null)', () => {
    expect(resolvePendingDesktopRoute('meetings')).toEqual({ kind: 'meetings' });
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'messages' });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'notifications' });
    // US-018: InboxPage retired → Notifications feed.
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'notifications' });
    expect(resolvePendingDesktopRoute('home')).toEqual({ kind: 'home' });
    // US-018: MissionControlPage retired → Home.
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('marketplace')).toEqual({ kind: 'marketplace' });
    expect(resolvePendingDesktopRoute('moderation')).toEqual({ kind: 'moderation' });
    expect(resolvePendingDesktopRoute('library')).toEqual({ kind: 'library' });
    expect(resolvePendingDesktopRoute('settings')).toEqual({ kind: 'settings' });
    // US-004 WindowRouter: Activity + Core Drift land on Home (no top-level windows).
    expect(resolvePendingDesktopRoute('activity')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('core-drift')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('drift')).toEqual({ kind: 'home' });
    // The Companies page is gone (US-007) — a stale intent is ignored, not routed.
    expect(resolvePendingDesktopRoute('companies')).toBeNull();
    expect(resolvePendingDesktopRoute('bogus')).toBeNull();
    expect(resolvePendingDesktopRoute(null)).toBeNull();
  });

  it('US-018: every previously accepted legacy deep-link name still resolves to a live route', () => {
    const legacyLive: Array<[string, DesktopRoute]> = [
      ['inbox', { kind: 'notifications' }],
      ['mission-control', { kind: 'home' }],
      ['sync', { kind: 'home' }],
      ['activity', { kind: 'home' }],
      ['core-drift', { kind: 'home' }],
      ['drift', { kind: 'home' }],
      ['library:marketplace', { kind: 'marketplace' }],
      ['company:indigo:accounts', { kind: 'company', slug: 'indigo', tab: 'overview' }],
      ['company:indigo:tasks', { kind: 'company', slug: 'indigo', tab: 'projects' }],
      ['company:indigo:library', { kind: 'company', slug: 'indigo', tab: 'skills' }],
      ['company:indigo:more', { kind: 'company', slug: 'indigo', tab: 'activity' }],
    ];
    for (const [name, expected] of legacyLive) {
      expect(resolvePendingDesktopRoute(name), name).toEqual(expected);
      expect(resolvePendingDesktopRoute(name), name).not.toBeNull();
    }
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
    expect(resolvePendingDesktopRoute('library:submit')).toEqual({
      kind: 'library',
      tab: 'submit',
    });
    expect(resolvePendingDesktopRoute('settings:meetings')).toEqual({
      kind: 'settings',
      tab: 'meetings',
    });
  });
});

describe('US-002 / US-018 V4Route payload narrowing', () => {
  it('maps sidebar payloads onto the DesktopRoute union with legacy remaps', () => {
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
    // US-018: inbox → notifications; mission-control → home.
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'notifications' });
    expect(fromV4Route({ kind: 'mission-control' })).toEqual({ kind: 'home' });
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'notifications' });
    // Unknown kinds land on Home, mirroring the shell fallback.
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

  it('declares visible primary company children, including Skills and Workers', () => {
    expect(COMPANY_PRIMARY_SECTIONS.map((s) => s.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
      'more',
    ]);
    expect(companyPrimarySectionForTab('overview')).toBe('overview');
    expect(companyPrimarySectionForTab('activity')).toBe('more');
    expect(companyPrimarySectionForTab('deployments')).toBe('more');
    expect(companyPrimarySectionForTab('secrets')).toBe('more');
    expect(companyPrimarySectionForTab('skills')).toBe('skills');
    expect(companyPrimarySectionForTab('workers')).toBe('workers');
    expect(companyTabForPrimarySection('more')).toBe('activity');
    expect(companyTabForPrimarySection('skills')).toBe('skills');
    expect(companyTabForPrimarySection('workers')).toBe('workers');
    expect(companyTabForPrimarySection('knowledge')).toBe('knowledge');
  });

  it('US-017: library has no permanent secondary sidebar (overlay owns left nav)', () => {
    // Route tabs + LIBRARY_SECTIONS still drive palette / deep links; the
    // secondary column is suppressed in favor of LibraryOverlay.
    expect(LIBRARY_SECTIONS.map((s) => s.id)).toEqual([
      'skills',
      'workers',
      'installed',
      'profile',
    ]);
    expect(LIBRARY_SECTIONS.map((s) => s.label)).not.toContain('Marketplace');
    expect(
      getDesktopSecondarySidebar(
        { kind: 'library', tab: 'installed' },
        companies,
        { hqFolderPath: ['', 'Users', 'corey', 'Documents', 'HQ'].join('/') },
      ),
    ).toBeNull();
    expect(getDesktopSecondarySidebar({ kind: 'library' }, companies)).toBeNull();
    expect(
      getDesktopSecondarySidebar({ kind: 'library', tab: 'submit' }, companies),
    ).toBeNull();
  });

  it('shows the generally available settings sections and a version meta', () => {
    const model = getDesktopSecondarySidebar({ kind: 'settings' }, companies, {
      version: '1.2.3',
    });
    expect(model?.surface).toBe('settings');
    expect(model?.meta).toBe('HQ v1.2.3');
    expect(model?.items.map((item) => item.id)).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(model?.items.find((item) => item.id === 'meetings')?.note).toBeNull();
    expect(model?.activeId).toBe('sync');
  });

  it('has no secondary sidebar on full-width global surfaces', () => {
    for (const kind of [
      'home',
      'marketplace',
      'notifications',
      'messages',
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

describe('US-018 Mission Control retirement — deep link remaps to Home', () => {
  it('resolves mission-control (and whitespace variants) to home, never a dead route', () => {
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('  mission-control  ')).toEqual({ kind: 'home' });
    expect(fromV4Route({ kind: 'mission-control' })).toEqual({ kind: 'home' });
  });

  it('has no ⌘ hotkey slot for mission-control or home', () => {
    const companies = getDesktopCompanies([
      company({ slug: 'first', displayName: 'First', state: 'synced' }),
    ]);
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const routed = getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
      expect(routed?.kind).not.toBe('mission-control' as DesktopRoute['kind']);
      expect(routed?.kind).not.toBe('home');
    }
  });
});

describe('US-018 Inbox retirement — deep link remaps to Notifications', () => {
  it('resolves inbox to notifications and keys notifications as its own kind', () => {
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'notifications' });
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'notifications' });
    expect(getDesktopRouteKey({ kind: 'notifications' })).toBe('notifications');
    expect(
      isDesktopRouteActive({ kind: 'notifications' }, { kind: 'messages' }),
    ).toBe(false);
  });
});

describe('desktop session read-scope binding (knowledge-path fixes)', () => {
  const personal: Workspace = {
    ...baseCompany,
    slug: 'personal',
    displayName: 'Personal',
    kind: 'personal',
    state: 'personal',
    cloudUid: null,
    membershipStatus: null,
    role: null,
  };

  it('binds the viewed company on a company route', () => {
    const workspaces = [company({ slug: 'acme' })];
    expect(
      getDesktopSessionScopeSlug({ kind: 'company', slug: 'acme', tab: 'knowledge' }, workspaces, null),
    ).toBe('acme');
  });

  it('binds sync-paused and local-only companies too — sync state must not unbind the viewed company (fleet board/knowledge regression)', () => {
    const paused = company({ slug: 'acme', syncEnabled: false });
    const localOnly = company({
      slug: 'localco',
      state: 'local-only',
      cloudUid: null,
      membershipStatus: null,
      syncEnabled: false,
    });
    expect(
      getDesktopSessionScopeSlug({ kind: 'company', slug: 'acme', tab: 'knowledge' }, [paused], null),
    ).toBe('acme');
    expect(
      getDesktopSessionScopeSlug({ kind: 'company', slug: 'localco' }, [localOnly], null),
    ).toBe('localco');
  });

  it('binds the personal workspace when its surface is viewed', () => {
    expect(
      getDesktopSessionScopeSlug(
        { kind: 'company', slug: 'personal', tab: 'knowledge' },
        [personal, company({ slug: 'acme' })],
        null,
      ),
    ).toBe('personal');
  });

  it('files mode binds the membership-validated files filter, not the company route', () => {
    const workspaces = [company({ slug: 'acme' })];
    expect(getDesktopSessionScopeSlug({ kind: 'files' }, workspaces, null)).toBeNull();
    expect(getDesktopSessionScopeSlug({ kind: 'files', slug: 'acme' }, workspaces, 'acme')).toBe(
      'acme',
    );
  });

  it('unbinds on non-company, non-files surfaces and unknown slugs', () => {
    const workspaces = [company({ slug: 'acme' })];
    expect(getDesktopSessionScopeSlug({ kind: 'home' }, workspaces, null)).toBeNull();
    expect(getDesktopSessionScopeSlug({ kind: 'library' }, workspaces, null)).toBeNull();
    expect(
      getDesktopSessionScopeSlug({ kind: 'company', slug: 'ghost' }, workspaces, null),
    ).toBeNull();
  });
});
