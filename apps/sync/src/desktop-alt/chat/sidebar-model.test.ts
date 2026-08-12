import { describe, expect, it } from 'vitest';
import type { Channel } from '../../lib/channels';
import {
  applyPairUnreads,
  applySidebarFilters,
  buildScopeOptions,
  clearDmDot,
  clearPairUnread,
  daySectionLabel,
  distinctDmPeople,
  filterByCompanyScope,
  filterByShow,
  filterTypeahead,
  groupByDay,
  initialsFor,
  loadPins,
  normalizeChannel,
  normalizeConversations,
  normalizeDm,
  nextScope,
  savePins,
  scopeFromHotkey,
  scopePillLabel,
  searchHistory,
  sortConversations,
  titlebarDayDate,
  togglePin,
  type ConversationRow,
  type DmContactInput,
} from './sidebar-model';

// Fixed "now": Wednesday Aug 12, 2026 15:00 local — tests use local day math.
const NOW = new Date(2026, 7, 12, 15, 0, 0, 0).getTime();

function msOnDay(daysAgo: number, hour = 12): number {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function channel(overrides: Partial<Channel> & { channelId: string; name: string }): Channel {
  return {
    scope: 'company',
    companyUid: 'cmp_a',
    companyName: 'Acme',
    unread: 0,
    ...overrides,
  };
}

function dm(overrides: Partial<DmContactInput> & { personUid: string }): DmContactInput {
  return {
    displayName: 'Alex',
    email: 'alex@example.com',
    ...overrides,
  };
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  } as Storage;
}

describe('normalizeChannel / normalizeDm', () => {
  it('maps company channels with numeric unread and no DM-style assumptions', () => {
    const row = normalizeChannel(
      channel({
        channelId: 'ch1',
        name: '#launch',
        unread: 3,
        lastActivityAt: iso(msOnDay(0)),
      }),
    );
    expect(row).toMatchObject({
      id: 'ch:ch1',
      kind: 'channel',
      title: 'launch',
      companyUid: 'cmp_a',
      unreadCount: 3,
      unreadDot: false,
    });
    expect(row.unreadCount).toBe(3);
  });

  it('maps group DMs as kind group with member-count and dot-only unread', () => {
    const row = normalizeChannel(
      channel({
        channelId: 'g1',
        name: '',
        scope: 'group',
        companyUid: null,
        unread: 2,
        memberCount: 3,
        members: [
          { personUid: 'p1', displayName: 'Sam' },
          { personUid: 'p2', displayName: 'Jo' },
        ],
        lastActivityAt: iso(msOnDay(1)),
      }),
    );
    expect(row.kind).toBe('group');
    expect(row.unreadCount).toBeUndefined();
    expect(row.unreadDot).toBe(true);
    expect(row.memberCount).toBe(3);
    expect(row.title).toContain('Sam');
  });

  it('DM unread is absent-safe — never invents a numeric field from unrelated keys', () => {
    const contact = dm({
      personUid: 'p-alex',
      // `unread` alone is not the server pair-unread field — ignore it.
      ...({ unread: 99 } as object),
    }) as DmContactInput;
    const row = normalizeDm(contact);
    expect(row.kind).toBe('dm');
    expect(row.unreadCount).toBeUndefined();
    expect(row.unreadDot).toBe(false);
  });

  it('DM unreadCount > 0 renders a numeric badge (no server-driven dot)', () => {
    const row = normalizeDm(dm({ personUid: 'p1', unreadCount: 4 }));
    expect(row.unreadCount).toBe(4);
    expect(row.unreadDot).toBe(false);
  });

  it('DM unreadCount 0 means read — no badge/dot from server (local dots may still show)', () => {
    const read = normalizeDm(dm({ personUid: 'p1', unreadCount: 0 }));
    expect(read.unreadCount).toBeUndefined();
    expect(read.unreadDot).toBe(false);

    const withLocalDot = normalizeDm(dm({ personUid: 'p2', unreadCount: 0 }), {
      dmDots: ['p2'],
    });
    expect(withLocalDot.unreadCount).toBeUndefined();
    expect(withLocalDot.unreadDot).toBe(true);
  });

  it('DM unreadCount absent/null/undefined falls back to legacy dot behavior', () => {
    expect(normalizeDm(dm({ personUid: 'p-a' })).unreadDot).toBe(false);
    expect(normalizeDm(dm({ personUid: 'p-b', unreadCount: null })).unreadDot).toBe(
      false,
    );
    expect(
      normalizeDm(dm({ personUid: 'p-c', unreadCount: undefined }), {
        dmDots: ['p-c'],
      }).unreadDot,
    ).toBe(true);
    expect(
      normalizeDm(dm({ personUid: 'p-d', activityDot: true })).unreadDot,
    ).toBe(true);
  });

  it('DM activityDot / dmDots set lights the local-only unread dot', () => {
    expect(normalizeDm(dm({ personUid: 'p1', activityDot: true })).unreadDot).toBe(true);
    expect(
      normalizeDm(dm({ personUid: 'p2' }), { dmDots: ['p2'] }).unreadDot,
    ).toBe(true);
  });

  it('applyPairUnreads merges server rollups; clearPairUnread zeros one pair', () => {
    const contacts = [
      dm({ personUid: 'p1', displayName: 'Ada' }),
      dm({ personUid: 'p2', displayName: 'Grace' }),
    ];
    const merged = applyPairUnreads(contacts, { p1: 3 });
    expect(merged[0]?.unreadCount).toBe(3);
    expect(merged[1]?.unreadCount).toBeUndefined();

    const cleared = clearPairUnread({ p1: 3, p2: 1 }, 'p1');
    expect(cleared.get('p1')).toBe(0);
    expect(cleared.get('p2')).toBe(1);
  });

  it('recent sort still favors numeric DM unread over quiet rows', () => {
    const rows = normalizeConversations(
      [],
      [
        dm({
          personUid: 'quiet',
          displayName: 'Quiet',
          lastMessageAt: iso(msOnDay(0, 14)),
          unreadCount: 0,
        }),
        dm({
          personUid: 'hot',
          displayName: 'Hot',
          lastMessageAt: iso(msOnDay(0, 10)),
          unreadCount: 5,
        }),
      ],
    );
    // Same day, quiet is more recent by activity — but when activity ties on
    // the secondary key, unread tilts. Here activity differs so recency wins;
    // force equal activity to prove unread secondary sort.
    const equalActivity: ConversationRow[] = rows.map((r) => ({
      ...r,
      lastActivityAt: NOW,
    }));
    const sorted = sortConversations(equalActivity, 'recent');
    expect(sorted[0]?.personUid).toBe('hot');
    expect(sorted[0]?.unreadCount).toBe(5);
  });

  it('pins apply to both channels and DMs', () => {
    const rows = normalizeConversations(
      [channel({ channelId: 'c1', name: 'ops' })],
      [dm({ personUid: 'p1', displayName: 'Bo' })],
      { pinnedIds: ['ch:c1', 'dm:p1'] },
    );
    expect(rows.every((r) => r.pinned)).toBe(true);
  });
});

describe('day grouping', () => {
  function row(partial: Partial<ConversationRow> & { id: string; lastActivityAt: number }): ConversationRow {
    return {
      kind: 'channel',
      title: partial.id,
      companyUid: null,
      unreadDot: false,
      pinned: false,
      ...partial,
    };
  }

  it('labels TODAY with real month/day, YESTERDAY, and weekday names for 2–7d', () => {
    expect(daySectionLabel(msOnDay(0), NOW)).toMatch(/^TODAY · AUG 12$/);
    expect(daySectionLabel(msOnDay(1), NOW)).toBe('YESTERDAY');
    // 2 days before Wed Aug 12 = Monday
    expect(daySectionLabel(msOnDay(2), NOW)).toBe('MONDAY');
    // 3 days = Sunday
    expect(daySectionLabel(msOnDay(3), NOW)).toBe('SUNDAY');
  });

  it('titlebar day·date uses weekday abbrev + month day', () => {
    expect(titlebarDayDate(NOW)).toBe('WED · AUG 12');
  });

  it('groups recent days into sections and collapses >7d into LAST WEEK', () => {
    const rows = [
      row({ id: 'today', lastActivityAt: msOnDay(0) }),
      row({ id: 'yest', lastActivityAt: msOnDay(1) }),
      row({ id: 'mon', lastActivityAt: msOnDay(2) }),
      row({ id: 'old-a', lastActivityAt: msOnDay(10) }),
      row({ id: 'old-b', lastActivityAt: msOnDay(20) }),
      row({ id: 'pinned-old', lastActivityAt: msOnDay(30), pinned: true }),
    ];
    const grouped = groupByDay(rows, NOW);

    expect(grouped.pinned.map((r) => r.id)).toEqual(['pinned-old']);
    expect(grouped.sections.map((s) => s.label)).toEqual([
      'TODAY · AUG 12',
      'YESTERDAY',
      'MONDAY',
    ]);
    expect(grouped.sections[0]?.rows.map((r) => r.id)).toEqual(['today']);
    expect(grouped.lastWeek.map((r) => r.id).sort()).toEqual(['old-a', 'old-b']);
    // Pinned is excluded from lastWeek even if old.
    expect(grouped.lastWeek.find((r) => r.id === 'pinned-old')).toBeUndefined();
  });

  it('treats activity at exactly the 7-day boundary as a day section, not LAST WEEK', () => {
    // day 6 (inclusive of the 7-day window today..today-6) stays in sections.
    const rows = [row({ id: 'edge', lastActivityAt: msOnDay(6) })];
    const grouped = groupByDay(rows, NOW);
    expect(grouped.lastWeek).toHaveLength(0);
    expect(grouped.sections).toHaveLength(1);
  });

  it('activity older than 7 days collapses into lastWeek', () => {
    const rows = [row({ id: 'edge-old', lastActivityAt: msOnDay(7) })];
    const grouped = groupByDay(rows, NOW);
    expect(grouped.sections).toHaveLength(0);
    expect(grouped.lastWeek.map((r) => r.id)).toEqual(['edge-old']);
  });
});

describe('company scope filtering', () => {
  const rows: ConversationRow[] = [
    {
      id: 'ch:a',
      kind: 'channel',
      title: 'Acme',
      companyUid: 'cmp_a',
      unreadDot: false,
      lastActivityAt: 3,
      pinned: false,
    },
    {
      id: 'ch:b',
      kind: 'channel',
      title: 'Beta',
      companyUid: 'cmp_b',
      unreadDot: false,
      lastActivityAt: 2,
      pinned: false,
    },
    {
      id: 'ch:p',
      kind: 'channel',
      title: 'Notes',
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 1,
      pinned: false,
    },
    {
      id: 'dm:1',
      kind: 'dm',
      title: 'Alex',
      companyUid: 'cmp_a',
      unreadDot: false,
      lastActivityAt: 4,
      pinned: false,
      personUid: 'p1',
    },
    {
      id: 'dm:2',
      kind: 'dm',
      title: 'Sam',
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 5,
      pinned: false,
      personUid: 'p2',
    },
    {
      id: 'ch:g',
      kind: 'group',
      title: 'Trio',
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 6,
      pinned: false,
    },
  ];

  it('all keeps every row', () => {
    expect(filterByCompanyScope(rows, 'all')).toHaveLength(rows.length);
  });

  it('company uid keeps that company channels + matching DMs + group DMs', () => {
    const filtered = filterByCompanyScope(rows, 'cmp_a');
    expect(filtered.map((r) => r.id).sort()).toEqual(['ch:a', 'ch:g', 'dm:1']);
  });

  it('personal keeps personal channels, unscoped DMs, and group DMs', () => {
    const filtered = filterByCompanyScope(rows, 'personal');
    expect(filtered.map((r) => r.id).sort()).toEqual(['ch:g', 'ch:p', 'dm:2']);
  });
});

describe('sort + show filters', () => {
  const rows: ConversationRow[] = [
    {
      id: 'ch:1',
      kind: 'channel',
      title: 'Zebra',
      companyUid: 'c',
      unreadDot: false,
      lastActivityAt: 10,
      pinned: false,
    },
    {
      id: 'dm:1',
      kind: 'dm',
      title: 'Alpha',
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 50,
      pinned: false,
      personUid: 'p1',
    },
    {
      id: 'ch:g',
      kind: 'group',
      title: 'Group',
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 30,
      pinned: false,
    },
  ];

  it('Recent sorts by lastActivityAt desc', () => {
    expect(sortConversations(rows, 'recent').map((r) => r.id)).toEqual([
      'dm:1',
      'ch:g',
      'ch:1',
    ]);
  });

  it('Type sorts channel → group → dm, then recency within type', () => {
    expect(sortConversations(rows, 'type').map((r) => r.id)).toEqual([
      'ch:1',
      'ch:g',
      'dm:1',
    ]);
  });

  it('Show Projects keeps only project/company channels', () => {
    expect(filterByShow(rows, 'projects').map((r) => r.id)).toEqual(['ch:1']);
  });

  it('Show DMs keeps dm + group', () => {
    expect(filterByShow(rows, 'dms').map((r) => r.id).sort()).toEqual(['ch:g', 'dm:1']);
  });

  it('applySidebarFilters composes scope + show + sort + person', () => {
    const result = applySidebarFilters(rows, {
      scope: 'all',
      show: 'dms',
      sort: 'recent',
      personUid: 'p1',
    });
    expect(result.map((r) => r.id)).toEqual(['dm:1']);
  });
});

describe('pin persistence', () => {
  it('loadPins / savePins / togglePin round-trip through localStorage', () => {
    const storage = memoryStorage();
    expect(loadPins(storage)).toEqual([]);
    savePins(['ch:1', 'dm:2'], storage);
    expect(loadPins(storage)).toEqual(['ch:1', 'dm:2']);
    const toggled = togglePin(loadPins(storage), 'ch:1');
    expect(toggled).toEqual(['dm:2']);
    savePins(toggled, storage);
    expect(loadPins(storage)).toEqual(['dm:2']);
  });

  it('loadPins tolerates corrupt JSON', () => {
    const storage = memoryStorage({ 'hq.chat.pins': '{not-json' });
    expect(loadPins(storage)).toEqual([]);
  });

  it('clearDmDot removes only the targeted person', () => {
    expect(clearDmDot(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
});

describe('scope pill helpers', () => {
  const companies = [
    { companyUid: 'cmp_1', label: 'Acme' },
    { companyUid: 'cmp_2', label: 'Beta' },
  ];

  it('buildScopeOptions is All + companies + Personal', () => {
    expect(buildScopeOptions(companies).map((o) => o.id)).toEqual([
      'all',
      'cmp_1',
      'cmp_2',
      'personal',
    ]);
  });

  it('nextScope cycles', () => {
    expect(nextScope('all', companies)).toBe('cmp_1');
    expect(nextScope('cmp_2', companies)).toBe('personal');
    expect(nextScope('personal', companies)).toBe('all');
  });

  it('scopeFromHotkey maps 0 / 1..5 / p', () => {
    expect(scopeFromHotkey('0', companies)).toBe('all');
    expect(scopeFromHotkey('1', companies)).toBe('cmp_1');
    expect(scopeFromHotkey('2', companies)).toBe('cmp_2');
    expect(scopeFromHotkey('3', companies)).toBeNull(); // only 2 companies
    expect(scopeFromHotkey('p', companies)).toBe('personal');
    expect(scopeFromHotkey('P', companies)).toBe('personal');
    expect(scopeFromHotkey('x', companies)).toBeNull();
  });

  it('scopePillLabel resolves company names', () => {
    expect(scopePillLabel('all', companies)).toBe('All');
    expect(scopePillLabel('personal', companies)).toBe('Personal');
    expect(scopePillLabel('cmp_1', companies)).toBe('Acme');
  });
});

describe('typeahead / history / people helpers', () => {
  const rows: ConversationRow[] = [
    {
      id: 'dm:1',
      kind: 'dm',
      title: 'Alex Rivera',
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 10,
      pinned: false,
      personUid: 'p1',
      email: 'alex@x.com',
    },
    {
      id: 'ch:1',
      kind: 'channel',
      title: 'launch',
      companyUid: 'c',
      unreadDot: false,
      lastActivityAt: 5,
      pinned: false,
    },
  ];

  it('filterTypeahead matches title and email', () => {
    expect(filterTypeahead(rows, 'alex').map((r) => r.id)).toEqual(['dm:1']);
    expect(filterTypeahead(rows, 'launch').map((r) => r.id)).toEqual(['ch:1']);
  });

  it('searchHistory filters by title', () => {
    expect(searchHistory(rows, 'LAU').map((r) => r.id)).toEqual(['ch:1']);
  });

  it('distinctDmPeople returns unique DM counterparts', () => {
    expect(distinctDmPeople(rows)).toEqual([{ personUid: 'p1', label: 'Alex Rivera' }]);
  });

  it('initialsFor builds monograms', () => {
    expect(initialsFor('Alex Rivera')).toBe('AR');
    expect(initialsFor('Bo')).toBe('BO');
  });
});
