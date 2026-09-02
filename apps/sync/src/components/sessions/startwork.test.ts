import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  filterProjects,
  forgetLastProject,
  isMine,
  isStartworkTurn,
  LAST_PROJECT_KEY_PREFIX,
  lastProjectKey,
  ownerChips,
  ownerInitials,
  ownerLabel,
  planFirstSend,
  type ProjectEntry,
  readLastProject,
  readStartworkEnabled,
  relativeTime,
  rememberLastProject,
  rememberStartworkEnabled,
  sortProjectsByActivity,
  STARTWORK_ENABLED_KEY,
  startworkCommand,
  startworkLabel,
  startworkLabelFromText,
  storyPercent,
  storyProgress,
} from './startwork';

describe('startworkCommand', () => {
  it('orients on the company when no project is chosen', () => {
    expect(startworkCommand({ company: 'indigo', project: null })).toBe('/startwork indigo');
  });

  it('lets a chosen project override the company', () => {
    expect(startworkCommand({ company: 'indigo', project: 'hq-desktop' })).toBe(
      '/startwork hq-desktop',
    );
  });

  it('has nothing to orient on without a company or a project', () => {
    expect(startworkCommand({ company: null, project: null })).toBeNull();
    expect(startworkCommand({ company: '  ', project: '' })).toBeNull();
  });
});

describe('isStartworkTurn', () => {
  it('recognises the command alone, with arguments, and with leading space', () => {
    expect(isStartworkTurn('/startwork')).toBe(true);
    expect(isStartworkTurn('/startwork indigo')).toBe(true);
    expect(isStartworkTurn('  /startwork indigo')).toBe(true);
  });

  it('does not match prose or a longer command name', () => {
    expect(isStartworkTurn('start work please')).toBe(false);
    expect(isStartworkTurn('/startworkflow')).toBe(false);
    expect(isStartworkTurn('/handoff')).toBe(false);
  });
});

describe('planFirstSend — the exact first-send sequence', () => {
  it('sends the hidden orientation turn, THEN the user text', () => {
    const plan = planFirstSend('fix the bug', { company: 'indigo', project: null }, true);
    expect(plan).toEqual([
      { text: '/startwork indigo', hidden: true, label: 'Starting work in indigo' },
      { text: 'fix the bug', hidden: false },
    ]);
  });

  it('uses the project when one is chosen and labels it', () => {
    const plan = planFirstSend('go', { company: 'indigo', project: 'sessions' }, true);
    expect(plan[0]).toEqual({
      text: '/startwork sessions',
      hidden: true,
      label: 'Starting work in indigo · project sessions',
    });
    expect(plan[1]).toEqual({ text: 'go', hidden: false });
  });

  it('respects the opt-out: one send, the text alone', () => {
    expect(planFirstSend('go', { company: 'indigo', project: null }, false)).toEqual([
      { text: 'go', hidden: false },
    ]);
  });

  it('never double-sends when the user typed /startwork themselves', () => {
    expect(planFirstSend('/startwork ridge', { company: 'indigo', project: null }, true)).toEqual([
      { text: '/startwork ridge', hidden: false },
    ]);
    expect(planFirstSend('  /startwork', { company: 'indigo', project: null }, true)).toHaveLength(1);
  });

  it('sends the text alone when there is no company to orient on', () => {
    expect(planFirstSend('go', { company: null, project: null }, true)).toEqual([
      { text: 'go', hidden: false },
    ]);
  });
});

describe('labels', () => {
  it('names company and project on the system line', () => {
    expect(startworkLabel({ company: 'indigo', project: null })).toBe('Starting work in indigo');
    expect(startworkLabel({ company: 'indigo', project: 'x' })).toBe(
      'Starting work in indigo · project x',
    );
    expect(startworkLabel({ company: null, project: null })).toBe('Starting work');
  });

  it('derives a label from a bare command once the mirror is gone', () => {
    expect(startworkLabelFromText('/startwork indigo')).toBe('Starting work in indigo');
    expect(startworkLabelFromText('/startwork')).toBe('Starting work');
  });

  it('formats story progress as done/total', () => {
    expect(storyProgress({ storyCounts: { total: 12, done: 3 } })).toBe('3/12');
  });
});

describe('persistence', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults the startwork toggle ON and persists only the opt-out', () => {
    expect(readStartworkEnabled()).toBe(true);
    rememberStartworkEnabled(false);
    expect(store.get(STARTWORK_ENABLED_KEY)).toBe('off');
    expect(readStartworkEnabled()).toBe(false);
    rememberStartworkEnabled(true);
    expect(store.has(STARTWORK_ENABLED_KEY)).toBe(false);
    expect(readStartworkEnabled()).toBe(true);
  });

  it('a new session forgets the remembered project for the company, and only that', () => {
    rememberLastProject('indigo', 'sessions');
    rememberLastProject('ridge', 'ads');
    forgetLastProject('indigo');
    expect(readLastProject('indigo')).toBeNull();
    expect(store.has('hq.sessions.lastProject.indigo')).toBe(false);
    // Another company's pick is untouched, and no company is a no-op.
    expect(readLastProject('ridge')).toBe('ads');
    forgetLastProject(null);
    expect(readLastProject('ridge')).toBe('ads');
  });

  it('remembers the last project PER company under the agreed key', () => {
    expect(lastProjectKey('indigo')).toBe(`${LAST_PROJECT_KEY_PREFIX}indigo`);
    expect(lastProjectKey('indigo')).toBe('hq.sessions.lastProject.indigo');
    rememberLastProject('indigo', 'sessions');
    rememberLastProject('ridge', 'ads');
    expect(readLastProject('indigo')).toBe('sessions');
    expect(readLastProject('ridge')).toBe('ads');
    rememberLastProject('indigo', null);
    expect(readLastProject('indigo')).toBeNull();
    expect(readLastProject(null)).toBeNull();
  });
});

describe('the project picker\'s decisions', () => {
  const NOW = Date.parse('2026-09-02T12:00:00Z');
  const row = (
    name: string,
    over: Partial<ProjectEntry> = {},
  ): ProjectEntry => ({
    name,
    description: '',
    branchName: null,
    path: `/hq/companies/indigo/projects/${name}`,
    storyCounts: { total: 0, done: 0 },
    updatedAt: null,
    owner: null,
    lastActivityAt: null,
    status: 'active',
    ...over,
  });
  const ROWS: ProjectEntry[] = [
    row('sessions', {
      description: 'In-app sessions',
      owner: 'jacob@getindigo.ai',
      lastActivityAt: '2026-09-02T11:00:00Z',
      storyCounts: { total: 4, done: 1 },
    }),
    row('ads', {
      description: 'Meta ads sessions report',
      owner: 'Hassaan@getindigo.ai',
      lastActivityAt: '2026-09-01T11:00:00Z',
    }),
    row('billing', {
      owner: 'prs_01KQ2TZQMA8078CHPDWBAFPN0Z',
      lastActivityAt: '2026-08-30T11:00:00Z',
      status: 'done',
      storyCounts: { total: 2, done: 2 },
    }),
    row('retired', {
      description: 'Old work',
      owner: 'jacob@getindigo.ai',
      lastActivityAt: '2026-07-01T11:00:00Z',
      status: 'archived',
    }),
    row('unowned', { updatedAt: '2026-08-31T11:00:00Z' }),
    row('nodate'),
  ];

  it('orders by last activity, falling back to updatedAt, unknown dates last', () => {
    expect(sortProjectsByActivity(ROWS).map((entry) => entry.name)).toEqual([
      'sessions',
      'ads',
      'unowned',
      'billing',
      'retired',
      'nodate',
    ]);
  });

  it('Active hides done and archived; All shows everything', () => {
    expect(filterProjects(ROWS, { query: '', owner: null, status: 'active' }).map((e) => e.name)).toEqual([
      'sessions',
      'ads',
      'unowned',
      'nodate',
    ]);
    expect(filterProjects(ROWS, { query: '', owner: null, status: 'all' })).toHaveLength(6);
  });

  it('searches name and description, name-prefix first, then name, then description', () => {
    expect(filterProjects(ROWS, { query: 'sess', owner: null, status: 'all' }).map((e) => e.name)).toEqual([
      'sessions',
      'ads',
    ]);
    expect(filterProjects(ROWS, { query: 'ILL', owner: null, status: 'all' }).map((e) => e.name)).toEqual([
      'billing',
    ]);
    expect(filterProjects(ROWS, { query: 'old', owner: null, status: 'all' }).map((e) => e.name)).toEqual([
      'retired',
    ]);
    expect(filterProjects(ROWS, { query: 'zzz', owner: null, status: 'all' })).toEqual([]);
  });

  it('filters by owner case-insensitively', () => {
    expect(
      filterProjects(ROWS, { query: '', owner: 'JACOB@getindigo.ai', status: 'all' }).map((e) => e.name),
    ).toEqual(['sessions', 'retired']);
    expect(
      filterProjects(ROWS, { query: '', owner: 'jacob@getindigo.ai', status: 'active' }).map((e) => e.name),
    ).toEqual(['sessions']);
  });

  it('builds person chips — Mine first for the viewer, then by count — and skips unowned rows', () => {
    const chips = ownerChips(ROWS, { email: 'Jacob@getindigo.ai' });
    expect(chips.map((chip) => [chip.label, chip.count, chip.mine])).toEqual([
      ['Mine', 2, true],
      ['hassaan', 1, false],
      ['Person 01KQ', 1, false],
    ]);
    // Without a viewer, or one who owns nothing, there is no Mine.
    expect(ownerChips(ROWS, null).map((chip) => chip.label)).toEqual(['jacob', 'hassaan', 'Person 01KQ']);
    expect(ownerChips(ROWS, { email: 'nobody@x' }).some((chip) => chip.mine)).toBe(false);
    // A person uid matches the viewer's uid.
    expect(isMine('prs_01KQ2TZQMA8078CHPDWBAFPN0Z', { email: null, uid: 'prs_01KQ2TZQMA8078CHPDWBAFPN0Z' })).toBe(true);
    expect(isMine(null, { email: 'x@y' })).toBe(false);
  });

  it('labels and initials read well for emails, uids and names', () => {
    expect(ownerLabel('hassaan@getindigo.ai')).toBe('hassaan');
    expect(ownerLabel('prs_01KQ695MZHZBYFMVMPRTGFW34B')).toBe('Person 01KQ');
    expect(ownerLabel('Hassaan Saleem')).toBe('Hassaan Saleem');
    expect(ownerLabel(null)).toBe('Unowned');
    expect(ownerInitials('hassaan@getindigo.ai')).toBe('H');
    expect(ownerInitials('Hassaan Saleem')).toBe('HS');
    expect(ownerInitials('prs_01KQ695MZHZBYFMVMPRTGFW34B')).toBe('0');
    expect(ownerInitials(null)).toBe('·');
  });

  it('says how long ago, and nothing for an unknown date', () => {
    expect(relativeTime('2026-09-02T11:59:50Z', NOW)).toBe('just now');
    expect(relativeTime('2026-09-02T11:55:00Z', NOW)).toBe('5m ago');
    expect(relativeTime('2026-09-02T10:00:00Z', NOW)).toBe('2h ago');
    expect(relativeTime('2026-08-30T12:00:00Z', NOW)).toBe('3d ago');
    expect(relativeTime('2026-07-01T12:00:00Z', NOW)).toBe('2mo ago');
    expect(relativeTime('2024-09-02T12:00:00Z', NOW)).toBe('2y ago');
    expect(relativeTime(null, NOW)).toBe('');
    expect(relativeTime('garbage', NOW)).toBe('');
  });

  it('turns story counts into a bar width', () => {
    expect(storyPercent({ storyCounts: { total: 4, done: 1 } })).toBe(25);
    expect(storyPercent({ storyCounts: { total: 0, done: 0 } })).toBe(0);
    expect(storyPercent({ storyCounts: { total: 3, done: 3 } })).toBe(100);
  });
});
