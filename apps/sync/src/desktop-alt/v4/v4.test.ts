import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../lib/workspaces';
import {
  accountIdentityFromWorkspaces,
  getV4TitleBarModel,
  sortV4CompaniesConnectedFirst,
  v4CompanyConnected,
  v4CompanyDotTone,
  v4CompanyPrimaryForTab,
  V4_COMPANY_PRIMARY_ITEMS,
} from './model';

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
  return { ...baseCompany, ...overrides, kind: 'company' };
}

const personal: Workspace = {
  ...baseCompany,
  slug: 'personal',
  displayName: 'Personal',
  kind: 'personal',
  state: 'personal',
};

describe('V4 account identity', () => {
  it('derives the visible account label and initials from the personal workspace', () => {
    expect(
      accountIdentityFromWorkspaces([
        company({ slug: 'indigo', displayName: 'Indigo' }),
        { ...personal, displayName: 'Corey Epstein' },
      ]),
    ).toEqual({ label: 'Corey Epstein', initials: 'CE' });
  });

  it('handles one-word names and falls back cleanly without a personal workspace', () => {
    expect(accountIdentityFromWorkspaces([{ ...personal, displayName: 'Prince' }])).toEqual({
      label: 'Prince',
      initials: 'PR',
    });
    expect(accountIdentityFromWorkspaces([company({})])).toEqual({
      label: null,
      initials: 'HQ',
    });
    expect(accountIdentityFromWorkspaces([personal])).toEqual({
      label: null,
      initials: 'HQ',
    });
  });
});

describe('US-001 / US-018 company row model (sortV4CompaniesConnectedFirst)', () => {
  const workspaces = [
    company({ slug: 'indigo', displayName: 'Indigo' }),
    company({ slug: 'hpo', displayName: 'hpo' }),
    personal,
  ];

  it('highlights the company row and expands primary children when active', () => {
    const companies = sortV4CompaniesConnectedFirst(workspaces, 'hpo', 'overview');
    expect(companies.filter((row) => row.active).map((row) => row.slug)).toEqual(['hpo']);
    const hpo = companies.find((row) => row.slug === 'hpo');
    expect(hpo?.expanded).toBe(true);
    expect(hpo?.children.map((c) => c.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
      'more',
    ]);
    expect(hpo?.children.find((c) => c.id === 'overview')?.active).toBe(true);
    expect(companies.filter((row) => row.slug !== 'hpo').every((row) => !row.expanded)).toBe(true);
  });

  it('never expands tenant navigation for an unaccepted company invite', () => {
    const pending = company({
      slug: 'sender-agency',
      displayName: 'Sender Agency',
      state: 'cloud-only',
      membershipStatus: 'pending',
      hasLocalFolder: false,
      localPath: null,
    });
    const companies = sortV4CompaniesConnectedFirst([pending], 'sender-agency', 'projects');
    const row = companies[0];

    expect(row.pendingInvite).toBe(true);
    expect(row.active).toBe(true);
    expect(row.expanded).toBe(false);
    expect(row.children).toEqual([]);
  });

  it('keeps Skills and Workers visible and highlights their company child routes', () => {
    for (const tab of ['skills', 'workers'] as const) {
      const primary = v4CompanyPrimaryForTab(tab);
      const companies = sortV4CompaniesConnectedFirst(workspaces, 'hpo', primary);
      const activeCompany = companies.find((row) => row.slug === 'hpo');
      expect(activeCompany?.children.some((child) => child.id === tab)).toBe(true);
      expect(activeCompany?.children.find((child) => child.id === tab)?.active).toBe(true);
    }
  });

  it('collapses company children when no active company is selected', () => {
    const companies = sortV4CompaniesConnectedFirst(workspaces);
    expect(companies.every((row) => !row.expanded && row.children.length === 0)).toBe(true);
  });

  it('lights no active company for a missing slug', () => {
    const companies = sortV4CompaniesConnectedFirst(workspaces, 'ghost');
    expect(companies.every((row) => !row.active)).toBe(true);
  });

  it('declares the full primary company child list', () => {
    expect(V4_COMPANY_PRIMARY_ITEMS.map((item) => item.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
      'more',
    ]);
  });
});

describe('US-001 V4 companies-list rendering', () => {
  it('renders one row per workspace with the display name and status dot tone (connected-first, alpha within group)', () => {
    const companies = sortV4CompaniesConnectedFirst([
      company({ slug: 'synced', displayName: 'Synced Co', state: 'synced' }),
      company({ slug: 'broken', displayName: 'Broken Co', state: 'broken' }),
      company({ slug: 'local', displayName: 'Local Co', state: 'local-only', cloudUid: null }),
      company({ slug: 'cloud', displayName: 'Cloud Co', state: 'cloud-only', hasLocalFolder: false }),
      personal,
    ]);

    // Connected (synced / cloud-only / personal) lead, alphabetical by name;
    // the rest (broken, local-only) follow, alphabetical. Tones are unchanged.
    expect(companies.map((row) => [row.slug, row.label, row.tone])).toEqual([
      ['cloud', 'Cloud Co', 'idle'],
      ['personal', 'Personal', 'ok'],
      ['synced', 'Synced Co', 'ok'],
      ['broken', 'Broken Co', 'error'],
      ['local', 'Local Co', 'idle'],
    ]);
  });

  it('maps workspace state to dot tone (gray dot = paused, red = broken)', () => {
    expect(v4CompanyDotTone(company({ state: 'synced' }))).toBe('ok');
    expect(v4CompanyDotTone(personal)).toBe('ok');
    expect(v4CompanyDotTone(company({ state: 'broken' }))).toBe('error');
    expect(v4CompanyDotTone(company({ state: 'local-only' }))).toBe('idle');
    expect(v4CompanyDotTone(company({ state: 'cloud-only' }))).toBe('idle');
    expect(
      v4CompanyDotTone(
        company({ state: 'cloud-only', membershipStatus: 'pending' }),
      ),
    ).toBe('idle');
  });

  it('renders every workspace directly instead of truncating behind an overflow row', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      company({ slug: `co-${index}`, displayName: `Co ${index}` }),
    );
    const companies = sortV4CompaniesConnectedFirst(many);

    expect(companies).toHaveLength(9);
    expect(companies.map((row) => row.slug)).toEqual([
      'co-0',
      'co-1',
      'co-2',
      'co-3',
      'co-4',
      'co-5',
      'co-6',
      'co-7',
      'co-8',
    ]);
  });

  it('deduplicates repeated workspace slugs so cached local data cannot blank the app', () => {
    const companies = sortV4CompaniesConnectedFirst(
      [
        company({ slug: 'dupe', displayName: 'Dupe Local', state: 'local-only' }),
        company({ slug: 'dupe', displayName: 'Dupe Cloud', state: 'cloud-only' }),
        company({ slug: 'next', displayName: 'Next', state: 'synced' }),
      ],
      'dupe',
    );

    // First occurrence wins the dedupe (Dupe Local, local-only → idle/not
    // connected), so the connected-first sort puts 'next' (synced) ahead of it.
    expect(companies.map((row) => row.slug)).toEqual(['next', 'dupe']);
    expect(companies.find((row) => row.slug === 'dupe')?.label).toBe('Dupe Local');
    expect(companies.filter((row) => row.active).map((row) => row.slug)).toEqual(['dupe']);
  });

  it('keeps later companies selectable and active because every row renders', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      company({ slug: `co-${index}`, displayName: `Co ${index}` }),
    );
    const companies = sortV4CompaniesConnectedFirst(many, 'co-8');

    expect(companies).toHaveLength(9);
    expect(companies.find((row) => row.slug === 'co-8')?.active).toBe(true);
  });
});

describe('US-007 V4 connected-first sort', () => {
  it('sorts cloud-connected companies (synced / cloud-only) above idle ones, alphabetical within group', () => {
    const companies = sortV4CompaniesConnectedFirst([
      company({ slug: 'zed', displayName: 'Zed', state: 'local-only' }),
      company({ slug: 'acme', displayName: 'Acme', state: 'synced' }),
      company({ slug: 'beta', displayName: 'Beta', state: 'local-only' }),
      company({ slug: 'cloudco', displayName: 'CloudCo', state: 'cloud-only', hasLocalFolder: false }),
      company({ slug: 'orbit', displayName: 'Orbit', state: 'synced' }),
    ]);

    // Connected (Acme synced, CloudCo cloud-only, Orbit synced) lead in alpha
    // order; idle (Beta, Zed local-only) follow in alpha order.
    expect(companies.map((row) => row.label)).toEqual([
      'Acme',
      'CloudCo',
      'Orbit',
      'Beta',
      'Zed',
    ]);
  });

  it('sorts case-insensitively within each group', () => {
    const companies = sortV4CompaniesConnectedFirst([
      company({ slug: 'b', displayName: 'banana', state: 'synced' }),
      company({ slug: 'a', displayName: 'Apple', state: 'synced' }),
      company({ slug: 'c', displayName: 'Cherry', state: 'synced' }),
    ]);
    expect(companies.map((row) => row.label)).toEqual(['Apple', 'banana', 'Cherry']);
  });

  it('treats personal as connected (green dot) and groups it with synced/cloud-only', () => {
    const companies = sortV4CompaniesConnectedFirst([
      company({ slug: 'idle1', displayName: 'Idle One', state: 'local-only' }),
      personal,
      company({ slug: 'sync1', displayName: 'Aardvark', state: 'synced' }),
    ]);
    // personal + synced lead (alpha: Aardvark, Personal), then the idle row.
    expect(companies.map((row) => row.slug)).toEqual(['sync1', 'personal', 'idle1']);
  });

  it('keeps the active company highlighted after the connected-first reorder', () => {
    const companies = sortV4CompaniesConnectedFirst(
      [
        company({ slug: 'idle-active', displayName: 'Idle Active', state: 'local-only' }),
        company({ slug: 'conn', displayName: 'Connected', state: 'synced' }),
      ],
      'idle-active',
    );
    // Connected row sorts first, but the idle active row stays the only active one.
    expect(companies.map((row) => row.slug)).toEqual(['conn', 'idle-active']);
    expect(companies.filter((row) => row.active).map((row) => row.slug)).toEqual([
      'idle-active',
    ]);
  });

  it('exposes v4CompanyConnected as the grouping predicate (synced/cloud-only/personal)', () => {
    expect(v4CompanyConnected(company({ state: 'synced' }))).toBe(true);
    expect(v4CompanyConnected(company({ state: 'cloud-only' }))).toBe(true);
    expect(v4CompanyConnected(personal)).toBe(true);
    expect(v4CompanyConnected(company({ state: 'local-only' }))).toBe(false);
    expect(v4CompanyConnected(company({ state: 'broken' }))).toBe(false);
  });
});

describe('US-009 Files company list + shared connected-first sort', () => {
  const workspaces = [
    company({ slug: 'indigo', displayName: 'Indigo' }),
    company({ slug: 'hpo', displayName: 'hpo' }),
    personal,
  ];

  it('sortV4CompaniesConnectedFirst groups connected-first, alpha within group', () => {
    const rows = sortV4CompaniesConnectedFirst([
      company({ slug: 'zed', displayName: 'Zed', state: 'local-only' }),
      company({ slug: 'acme', displayName: 'Acme', state: 'synced' }),
      company({ slug: 'beta', displayName: 'Beta', state: 'local-only' }),
      company({ slug: 'cloudco', displayName: 'CloudCo', state: 'cloud-only', hasLocalFolder: false }),
      personal,
    ]);
    // Connected (Acme synced, CloudCo cloud-only, Personal) lead alpha; idle follow.
    expect(rows.map((row) => row.label)).toEqual(['Acme', 'CloudCo', 'Personal', 'Beta', 'Zed']);
    expect(rows.every((row) => !row.active)).toBe(true);
  });

  it('marks the passed activeSlug row active (the FilesModeSidebar contract)', () => {
    const rows = sortV4CompaniesConnectedFirst(workspaces, 'hpo');
    expect(rows.filter((row) => row.active).map((row) => row.slug)).toEqual(['hpo']);
  });
});

describe('US-001 V4 title bar model', () => {
  it('shows the healthy sentence with watched count + last sync and the Sync Now action', () => {
    const model = getV4TitleBarModel({
      syncState: 'idle',
      watchedCount: 12,
      lastSyncLabel: 'just now',
    });
    expect(model).toEqual({
      tone: 'ok',
      sentence: 'All synced',
      meta: '12 watched · just now',
      action: { id: 'sync', label: 'Sync Now' },
    });
  });

  it('switches the primary action to Cancel while syncing, with fanout meta', () => {
    const model = getV4TitleBarModel({
      syncState: 'syncing',
      watchedCount: 12,
      syncingCompany: 'indigo',
      fanoutDone: 2,
      fanoutTotal: 5,
    });
    expect(model.action).toEqual({ id: 'cancel', label: 'Cancel' });
    expect(model.sentence).toBe('Syncing…');
    expect(model.meta).toBe('indigo · 2/5 companies');
  });

  it('keeps sync errors red but gives auth a calm direct sign-in action', () => {
    const error = getV4TitleBarModel({
      syncState: 'error',
      watchedCount: 3,
      errorSummary: 'Connection lost',
    });
    expect(error.tone).toBe('error');
    expect(error.meta).toBe('Connection lost');
    expect(error.action).toEqual({ id: 'retry', label: 'Retry' });

    const auth = getV4TitleBarModel({ syncState: 'auth-error', watchedCount: 3 });
    expect(auth.action).toEqual({ id: 'retry', label: 'Sign in' });
    expect(auth.tone).toBe('idle');
    expect(auth.sentence).toBe('Ready to reconnect');
  });

  it('flags conflicts as a warn state with a direct resolution action', () => {
    const model = getV4TitleBarModel({ syncState: 'conflict', watchedCount: 3 });
    expect(model.tone).toBe('warn');
    expect(model.action).toEqual({ id: 'resolve', label: 'Resolve' });
  });
});
