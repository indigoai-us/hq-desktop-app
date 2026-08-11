import { describe, expect, it } from 'vitest';
import type { Workspace } from '../lib/workspaces';
import {
  COMPANY_PRIMARY_SECTIONS,
  COMPANY_SECTIONS,
  companyHotkey,
  companyPrimarySectionForTab,
  companyTabForPrimarySection,
  consoleUrlForLegacyRoute,
  fromV4Route,
  getAddWorkspaceRoute,
  getDesktopCompanies,
  getDesktopHotkeyRoute,
  getDesktopLandingRoute,
  getDesktopRouteKey,
  getDesktopSecondarySidebar,
  isDesktopRouteActive,
  landOnRouteForResolution,
  LIBRARY_SECTIONS,
  resolvePendingDesktopRoute,
  SETTINGS_SECTIONS,
  type DesktopRoute,
} from './route';
import { companyConsoleUrl, companySettingsUrl, HQ_CONSOLE_BASE } from './lib/hq-console';

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

/** Assert an internal-only pending resolution. */
function expectInternal(name: string | null | undefined, route: DesktopRoute) {
  expect(resolvePendingDesktopRoute(name)).toEqual({ mode: 'internal', route });
  expect(landOnRouteForResolution(resolvePendingDesktopRoute(name))).toEqual(route);
  expect(consoleUrlForLegacyRoute(name)).toBeNull();
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

  it('declares the company sections without dropped operations tabs (US-021)', () => {
    expect(COMPANY_SECTIONS.map((section) => section.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
    ]);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'accounts')).toBe(false);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'tasks')).toBe(false);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'library')).toBe(false);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'activity')).toBe(false);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'deployments')).toBe(false);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'secrets')).toBe(false);
    expect(COMPANY_SECTIONS.some((section) => (section.id as string) === 'settings')).toBe(false);
  });

  it('redirects legacy company deep-links: accounts→overview, tasks→projects, library→skills', () => {
    expectInternal('company:indigo:accounts', {
      kind: 'company',
      slug: 'indigo',
      tab: 'overview',
    });
    expectInternal('company:indigo:tasks', {
      kind: 'company',
      slug: 'indigo',
      tab: 'projects',
    });
    expectInternal('company:indigo:library', {
      kind: 'company',
      slug: 'indigo',
      tab: 'skills',
    });
  });

  it('resolves new company tabs skills / workers / team; knowledge renders inline', () => {
    expectInternal('company:indigo:skills', {
      kind: 'company',
      slug: 'indigo',
      tab: 'skills',
    });
    expectInternal('company:indigo:team', {
      kind: 'company',
      slug: 'indigo',
      tab: 'team',
    });
    expectInternal('company:indigo:knowledge', {
      kind: 'company',
      slug: 'indigo',
      tab: 'knowledge',
    });
  });

  it('declares the library sections in SPEC order with the Marketplace fold-in entry (US-015)', () => {
    expect(LIBRARY_SECTIONS.map((section) => section.id)).toEqual([
      'skills',
      'workers',
      'marketplace',
      'installed',
      'profile',
    ]);
  });

  it('keys company pages by slug only so section switches never remount the page', () => {
    expect(getDesktopRouteKey({ kind: 'company', slug: 'indigo', tab: 'overview' })).toBe(
      'company:indigo',
    );
    expect(getDesktopRouteKey({ kind: 'company', slug: 'indigo', tab: 'projects' })).toBe(
      'company:indigo',
    );
    expect(getDesktopRouteKey({ kind: 'library', tab: 'workers' })).toBe('library');
    expect(getDesktopRouteKey({ kind: 'home' })).toBe('home');
  });

  it('treats every section of a company as the same active sidebar destination', () => {
    const overview: DesktopRoute = { kind: 'company', slug: 'indigo', tab: 'overview' };
    const projects: DesktopRoute = { kind: 'company', slug: 'indigo', tab: 'projects' };
    expect(isDesktopRouteActive(overview, projects)).toBe(true);
    expect(
      isDesktopRouteActive(overview, { kind: 'company', slug: 'other', tab: 'overview' }),
    ).toBe(false);
    expect(isDesktopRouteActive({ kind: 'library' }, { kind: 'library', tab: 'profile' })).toBe(
      true,
    );
  });
});

describe('US-002 hotkeys — single-active-workspace numbering (⌘1–⌘9 companies, ⌘0 personal)', () => {
  const companies = getDesktopCompanies([
    company({ slug: 'first', displayName: 'First', state: 'synced' }),
    company({ slug: 'second', displayName: 'Second', state: 'synced' }),
    {
      ...baseCompany,
      slug: 'personal',
      displayName: 'Personal',
      kind: 'personal',
      state: 'personal',
    },
  ]);

  it('maps ⌘1 / ⌘2 to the first / second non-personal company in connected-first order', () => {
    const meta = (key: string) =>
      getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
    expect(meta('1')).toEqual({ kind: 'company', slug: 'first' });
    expect(meta('2')).toEqual({ kind: 'company', slug: 'second' });
  });

  it('maps ⌘0 to Personal; ctrl works too; keys past the company count and unmodified keys stay quiet', () => {
    expect(
      getDesktopHotkeyRoute({ key: '0', metaKey: true, ctrlKey: false }, companies),
    ).toEqual({ kind: 'company', slug: 'personal' });
    expect(
      getDesktopHotkeyRoute({ key: '2', metaKey: false, ctrlKey: true }, companies),
    ).toEqual({ kind: 'company', slug: 'second' });
    // Only two non-personal companies — ⌘3+ stay quiet rather than misfiring.
    expect(getDesktopHotkeyRoute({ key: '3', metaKey: true, ctrlKey: false }, companies)).toBeNull();
    expect(getDesktopHotkeyRoute({ key: '1', metaKey: false, ctrlKey: false }, companies)).toBeNull();
  });

  it('orders company hotkeys by connected-first sidebar rows, not the raw workspace list', () => {
    const unsorted = getDesktopCompanies([
      company({ slug: 'zeta', displayName: 'Zeta', state: 'local-only', cloudUid: null }),
      company({ slug: 'alpha', displayName: 'Alpha', state: 'synced' }),
    ]);
    // Alpha (connected) is the first non-personal row even though Zeta leads the list.
    expect(
      getDesktopHotkeyRoute({ key: '1', metaKey: true, ctrlKey: false }, unsorted),
    ).toEqual({ kind: 'company', slug: 'alpha' });
    expect(
      getDesktopHotkeyRoute({ key: '2', metaKey: true, ctrlKey: false }, unsorted),
    ).toEqual({ kind: 'company', slug: 'zeta' });
  });

  it('labels company hotkeys ⌘1–⌘9 and none past the ninth slot', () => {
    expect(companyHotkey(0)).toBe('⌘1');
    expect(companyHotkey(8)).toBe('⌘9');
    expect(companyHotkey(9)).toBeUndefined();
  });

  it('returns null for ⌘0 when no personal workspace is present', () => {
    const noPersonal = getDesktopCompanies([
      company({ slug: 'only', displayName: 'Only', state: 'synced' }),
    ]);
    expect(
      getDesktopHotkeyRoute({ key: '0', metaKey: true, ctrlKey: false }, noPersonal),
    ).toBeNull();
  });
});

describe('US-002 getAddWorkspaceRoute', () => {
  it('routes to the first pending-invite company', () => {
    expect(
      getAddWorkspaceRoute([
        company({ slug: 'synced', displayName: 'Synced', state: 'synced' }),
        company({
          slug: 'invite',
          displayName: 'Invite Co',
          state: 'cloud-only',
          membershipStatus: 'pending',
        }),
        company({ slug: 'local', displayName: 'Local', state: 'local-only', cloudUid: null }),
      ]),
    ).toEqual({ kind: 'company', slug: 'invite' });
  });

  it('routes to the first local-only or broken company when there is no pending invite', () => {
    expect(
      getAddWorkspaceRoute([
        company({ slug: 'synced', displayName: 'Synced', state: 'synced' }),
        company({ slug: 'broken', displayName: 'Broken', state: 'broken' }),
        company({ slug: 'local', displayName: 'Local', state: 'local-only', cloudUid: null }),
      ]),
    ).toEqual({ kind: 'company', slug: 'broken' });
    expect(
      getAddWorkspaceRoute([
        company({ slug: 'synced', displayName: 'Synced', state: 'synced' }),
        company({ slug: 'local', displayName: 'Local', state: 'local-only', cloudUid: null }),
      ]),
    ).toEqual({ kind: 'company', slug: 'local' });
  });

  it('falls back to Settings → Sync when every company is already connected', () => {
    expect(
      getAddWorkspaceRoute([
        company({ slug: 'synced', displayName: 'Synced', state: 'synced' }),
        company({ slug: 'cloud', displayName: 'Cloud', state: 'cloud-only' }),
      ]),
    ).toEqual({ kind: 'settings', tab: 'sync' });
  });
});

describe('US-002 pending-route aliases (desktop_alt_consume_pending_route)', () => {
  it("keeps the legacy 'sync' deep-link functional by landing it on Home", () => {
    expectInternal('sync', { kind: 'home' });
  });

  it('resolves the V4 destinations and rejects unknown intents', () => {
    expectInternal('meetings', { kind: 'meetings' });
    // Messages is the complete conversation surface; Notifications stays Inbox.
    expectInternal('messages', { kind: 'messages' });
    expectInternal('notifications', { kind: 'inbox' });
    expectInternal('inbox', { kind: 'inbox' });
    expectInternal('home', { kind: 'home' });
    expectInternal('marketplace', { kind: 'marketplace' });
    expectInternal('moderation', { kind: 'moderation' });
    expectInternal('library', { kind: 'library' });
    expectInternal('settings', { kind: 'settings' });
    // US-004 WindowRouter: Activity + Core Drift land on Home (no top-level windows).
    expectInternal('activity', { kind: 'home' });
    expectInternal('core-drift', { kind: 'home' });
    expectInternal('drift', { kind: 'home' });
    // The Companies page is gone (US-007) — a stale intent is ignored, not routed.
    expect(resolvePendingDesktopRoute('companies')).toBeNull();
    expect(resolvePendingDesktopRoute('bogus')).toBeNull();
    expect(resolvePendingDesktopRoute(null)).toBeNull();
  });

  it('resolves deep links into company sections, library tabs, and settings tabs', () => {
    expectInternal('company:indigo:projects', {
      kind: 'company',
      slug: 'indigo',
      tab: 'projects',
    });
    expectInternal('company:indigo:not-real', {
      kind: 'company',
      slug: 'indigo',
    });
    // Marketplace folded back into the Library sub-nav (US-015); the top-level
    // `marketplace` route stays alive as the palette destination.
    expectInternal('library:marketplace', {
      kind: 'library',
      tab: 'marketplace',
    });
    expectInternal('library:installed', {
      kind: 'library',
      tab: 'installed',
    });
    expectInternal('library:submit', {
      kind: 'library',
      tab: 'submit',
    });
    expectInternal('settings:meetings', {
      kind: 'settings',
      tab: 'meetings',
    });
  });
});

describe('US-021 legacy operations + mission-control console remaps', () => {
  it('opens company ops tabs in the HQ console and lands on company overview', () => {
    const deployments = resolvePendingDesktopRoute('company:indigo:deployments');
    expect(deployments).toEqual({
      mode: 'console',
      url: `${HQ_CONSOLE_BASE}/deployments`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    expect(consoleUrlForLegacyRoute('company/indigo/deployments')).toBe(
      `${HQ_CONSOLE_BASE}/deployments`,
    );

    const secrets = resolvePendingDesktopRoute('company/indigo/secrets');
    expect(secrets).toEqual({
      mode: 'console',
      url: `${companyConsoleUrl('indigo')}/secrets`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });

    const activity = resolvePendingDesktopRoute('company:indigo:activity');
    expect(activity).toEqual({
      mode: 'console',
      url: `${companyConsoleUrl('indigo')}/activity`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });

    const settings = resolvePendingDesktopRoute('company:indigo:settings');
    expect(settings).toEqual({
      mode: 'console',
      url: companySettingsUrl('indigo'),
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
  });

  it('maps company:more to company overview (nearest V2 screen)', () => {
    expectInternal('company:indigo:more', {
      kind: 'company',
      slug: 'indigo',
      tab: 'overview',
    });
  });

  it('maps mission-control to Telescope when a company slug is known, else Home', () => {
    expect(
      resolvePendingDesktopRoute('mission-control', { activeCompanySlug: 'indigo' }),
    ).toEqual({
      mode: 'console',
      url: `${companyConsoleUrl('indigo')}/telescope`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    expect(
      consoleUrlForLegacyRoute('mission-control', { activeCompanySlug: 'indigo' }),
    ).toBe(`${companyConsoleUrl('indigo')}/telescope`);

    expectInternal('mission-control', { kind: 'home' });
    expectInternal('  mission-control  ', { kind: 'home' });
  });
});

describe('US-002 V4Sidebar payload narrowing', () => {
  it('maps sidebar payloads onto the DesktopRoute union', () => {
    expect(fromV4Route({ kind: 'company', slug: 'indigo' })).toEqual({
      kind: 'company',
      slug: 'indigo',
    });
    // DESKTOP-001: primary child clicks carry a tab; more aliases to overview.
    expect(fromV4Route({ kind: 'company', slug: 'indigo', tab: 'projects' })).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'projects',
    });
    expect(fromV4Route({ kind: 'company', slug: 'indigo', tab: 'more' })).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'overview',
    });
    expect(fromV4Route({ kind: 'settings' })).toEqual({ kind: 'settings' });
    expect(fromV4Route({ kind: 'library' })).toEqual({ kind: 'library' });
    // Marketplace is a top-level destination (US-007); the Companies kind is gone.
    expect(fromV4Route({ kind: 'marketplace' })).toEqual({ kind: 'marketplace' });
    expect(fromV4Route({ kind: 'companies' })).toEqual({ kind: 'home' });
    // Messages remains distinct; notification payloads land on Inbox.
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'inbox' });
    // US-021: mission-control no longer an in-app route — nearest V2 is Home.
    expect(fromV4Route({ kind: 'mission-control' })).toEqual({ kind: 'home' });
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
        { kind: 'company', slug: 'indigo', tab: 'projects' },
        companies,
      ),
    ).toBeNull();
    expect(getDesktopSecondarySidebar({ kind: 'company', slug: 'ghost' }, companies)).toBeNull();
  });

  it('declares visible primary company children without More (US-021)', () => {
    expect(COMPANY_PRIMARY_SECTIONS.map((s) => s.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
    ]);
    expect(companyPrimarySectionForTab('overview')).toBe('overview');
    expect(companyPrimarySectionForTab('skills')).toBe('skills');
    expect(companyPrimarySectionForTab('workers')).toBe('workers');
    expect(companyTabForPrimarySection('skills')).toBe('skills');
    expect(companyTabForPrimarySection('workers')).toBe('workers');
    expect(companyTabForPrimarySection('knowledge')).toBe('knowledge');
    expect(companyTabForPrimarySection('team')).toBe('team');
  });

  it('shows the library sections — including the Marketplace fold-in — with the routed tab active', () => {
    const configuredPath = ['', 'Users', 'corey', 'Documents', 'HQ'].join('/');
    const model = getDesktopSecondarySidebar(
      { kind: 'library', tab: 'installed' },
      companies,
      { hqFolderPath: configuredPath },
    );
    expect(model?.surface).toBe('library');
    expect(model?.meta).toBe('~/Documents/HQ');
    expect(model?.items.map((item) => item.id)).toEqual(LIBRARY_SECTIONS.map((s) => s.id));
    expect(model?.items.some((item) => item.label === 'Marketplace')).toBe(true);
    expect(model?.activeId).toBe('installed');
    expect(getDesktopSecondarySidebar({ kind: 'library' }, companies)?.activeId).toBe('skills');

    const submitModel = getDesktopSecondarySidebar(
      { kind: 'library', tab: 'submit' },
      companies,
    );
    expect(submitModel?.activeId).toBe('submit');
    expect(submitModel?.footer).toEqual({ label: 'Publish a pack', active: true });
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
      'inbox',
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
    expectInternal('files', { kind: 'files' });
    expectInternal('files:indigo', { kind: 'files', slug: 'indigo' });
    // File paths contain '/', which the normaliser turns into ':'. The path
    // remainder after the slug must survive intact (restored to slashes).
    expectInternal('files:indigo:companies/indigo/a.md', {
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

describe('US-021 Mission Control legacy remap (was US-006 / US-012 destination)', () => {
  it('is not a DesktopRoute kind — pending intent remaps via resolvePendingDesktopRoute', () => {
    const kinds: DesktopRoute['kind'][] = [
      'home',
      'inbox',
      'messages',
      'meetings',
      'marketplace',
      'moderation',
      'library',
      'settings',
      'files',
      'company',
    ];
    expect(kinds).not.toContain('mission-control' as DesktopRoute['kind']);
  });

  it('has no ⌘ hotkey slot — reachable via the palette console deep link only', () => {
    const companies = getDesktopCompanies([
      company({ slug: 'first', displayName: 'First', state: 'synced' }),
    ]);
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const routed = getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
      expect(routed?.kind).not.toBe('home');
    }
  });
});
