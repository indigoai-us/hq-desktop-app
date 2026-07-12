import { describe, expect, it } from 'vitest';
import {
  WIDGET_HOVER_LIST_PADDING,
  WIDGET_HOVER_MAX,
  WIDGET_HOVER_PANEL_WIDTH,
  WIDGET_HOVER_ROW_GAP,
  WIDGET_HOVER_ROW_HEIGHT,
  WIDGET_HOVER_SEPARATOR_HEIGHT,
  WIDGET_IDLE_HEIGHT,
  WIDGET_IDLE_WIDTH,
  WIDGET_MARK_AREA,
  WIDGET_MESSAGE_EXPAND_HEADROOM,
  WIDGET_RECENT_MAX,
  WIDGET_ROW_GAP,
  WIDGET_ROW_TIMEOUT_MS,
  WIDGET_STACK_MARGIN_BOTTOM,
  WIDGET_STACK_MAX,
  WIDGET_STACK_WIDTH,
  WIDGET_TOP_HEADROOM,
  addItem,
  bannerToStackItem,
  dayLabel,
  deserializeRecent,
  dismissItem,
  dismissRecent,
  emptyWidgetStack,
  expireItems,
  historyFeedItemToStackItem,
  hoverItems,
  hoverRows,
  markQueueSeen,
  markRecentRead,
  mergeRecentWithHistory,
  serializeRecent,
  setOccluded,
  unreadRecentCount,
  widgetEmptyHoverWindowSize,
  widgetHoverWindowSize,
  widgetWindowSize,
  type WidgetStackItem,
} from './widgetNotifications';

function item(overrides: Partial<WidgetStackItem> & Pick<WidgetStackItem, 'id'>): WidgetStackItem {
  return {
    type: 'system',
    text: 'hello',
    ts: 1_000,
    kind: 'update',
    clickActionId: 'open',
    data: null,
    expiresAt: 1_000 + WIDGET_ROW_TIMEOUT_MS,
    ...overrides,
  };
}

describe('bannerToStackItem', () => {
  it('maps dm → message with actor/title and body text', () => {
    const mapped = bannerToStackItem(
      {
        kind: 'dm',
        title: 'Corey',
        body: 'ship it',
        clickActionId: 'open',
        data: { id: 1 },
      },
      5_000,
      'a',
    );
    expect(mapped).toMatchObject({
      id: 'a',
      type: 'message',
      actor: 'Corey',
      text: 'ship it',
      kind: 'dm',
      clickActionId: 'open',
      ts: 5_000,
      expiresAt: 5_000 + WIDGET_ROW_TIMEOUT_MS,
    });
  });

  it('preserves optional actionId and actionLabel from the banner payload', () => {
    const withActions = bannerToStackItem(
      {
        kind: 'update',
        title: 'HQ Sync',
        body: '0.9.9 available',
        clickActionId: 'open',
        actionId: 'install-update',
        actionLabel: 'Update now',
        data: { version: '0.9.9' },
      },
      1_000,
      'u',
    );
    expect(withActions.actionId).toBe('install-update');
    expect(withActions.actionLabel).toBe('Update now');

    const without = bannerToStackItem(
      {
        kind: 'dm',
        title: 'Corey',
        body: 'hi',
        clickActionId: 'open',
        data: null,
      },
      1_000,
      'd',
    );
    expect(without.actionId).toBeUndefined();
    expect(without.actionLabel).toBeUndefined();

    const nullActions = bannerToStackItem(
      {
        kind: 'share',
        title: 'Yousuf',
        body: 'file.xlsx',
        clickActionId: 'open',
        actionId: null,
        actionLabel: null,
        data: null,
      },
      1_000,
      's',
    );
    expect(nullActions.actionId).toBeNull();
    expect(nullActions.actionLabel).toBeNull();
  });

  it('maps share → share and update/meeting/unknown → system', () => {
    expect(
      bannerToStackItem(
        { kind: 'share', title: 'Yousuf', body: 'q2.xlsx', clickActionId: 'open', data: null },
        1,
        's',
      ),
    ).toMatchObject({ type: 'share', actor: 'Yousuf', text: 'q2.xlsx' });

    expect(
      bannerToStackItem(
        {
          kind: 'update',
          title: 'HQ Sync',
          body: '0.9.9 available',
          clickActionId: 'open',
          data: null,
        },
        1,
        'u',
      ).text,
    ).toBe('HQ Sync — 0.9.9 available');

    expect(
      bannerToStackItem(
        { kind: 'meeting', title: 'Standup', body: 'starting', clickActionId: 'open', data: null },
        1,
        'm',
      ),
    ).toMatchObject({ type: 'system', text: 'Standup — starting' });

    expect(
      bannerToStackItem(
        { kind: 'weird', title: 'X', body: 'Y', clickActionId: 'open', data: null },
        1,
        'z',
      ).type,
    ).toBe('system');
  });
});

describe('addItem / setOccluded / expire / dismiss', () => {
  it('prepends to visible when not occluded and trims to max', () => {
    let state = emptyWidgetStack();
    for (let i = 0; i < WIDGET_STACK_MAX + 2; i++) {
      state = addItem(state, item({ id: `i${i}`, text: `${i}` }));
    }
    expect(state.visible.map((v) => v.id)).toEqual(
      Array.from({ length: WIDGET_STACK_MAX }, (_, i) => `i${WIDGET_STACK_MAX + 1 - i}`),
    );
    expect(state.queued).toEqual([]);
  });

  it('queues newest-first while occluded and flushes on un-occlude', () => {
    let state = setOccluded(emptyWidgetStack(), true, 0);
    state = addItem(state, item({ id: 'a', text: 'a' }));
    state = addItem(state, item({ id: 'b', text: 'b' }));
    expect(state.visible).toEqual([]);
    expect(state.queued.map((q) => q.id)).toEqual(['b', 'a']);

    const now = 10_000;
    state = setOccluded(state, false, now);
    expect(state.occluded).toBe(false);
    expect(state.queued).toEqual([]);
    expect(state.visible.map((v) => v.id)).toEqual(['b', 'a']);
    expect(state.visible.every((v) => v.expiresAt === now + WIDGET_ROW_TIMEOUT_MS)).toBe(true);
  });

  it('expireItems drops only past-due visible rows', () => {
    const state = {
      ...emptyWidgetStack(),
      visible: [
        item({ id: 'keep', expiresAt: 200 }),
        item({ id: 'gone', expiresAt: 100 }),
      ],
    };
    const next = expireItems(state, 150);
    expect(next.visible.map((v) => v.id)).toEqual(['keep']);
    expect(expireItems(next, 150)).toBe(next);
  });

  it('dismissItem removes from visible and queued', () => {
    const state = {
      occluded: true,
      visible: [item({ id: 'v' })],
      queued: [item({ id: 'q' }), item({ id: 'v' })],
      recent: [item({ id: 'v' }), item({ id: 'q' })],
    };
    const next = dismissItem(state, 'v');
    expect(next.visible).toEqual([]);
    expect(next.queued.map((q) => q.id)).toEqual(['q']);
    // Recent history is kept.
    expect(next.recent.map((r) => r.id)).toEqual(['v', 'q']);
  });

  it('dismissRecent removes from recent and visible; unknown id leaves lists equal', () => {
    const state = {
      occluded: false,
      visible: [item({ id: 'v' }), item({ id: 'keep' })],
      queued: [item({ id: 'q' })],
      recent: [item({ id: 'v' }), item({ id: 'keep' }), item({ id: 'q' })],
    };
    const next = dismissRecent(state, 'v');
    expect(next.visible.map((v) => v.id)).toEqual(['keep']);
    expect(next.recent.map((r) => r.id)).toEqual(['keep', 'q']);
    // Queued is kept.
    expect(next.queued.map((q) => q.id)).toEqual(['q']);

    const unknown = dismissRecent(next, 'missing');
    expect(unknown.visible.map((v) => v.id)).toEqual(next.visible.map((v) => v.id));
    expect(unknown.recent.map((r) => r.id)).toEqual(next.recent.map((r) => r.id));
    expect(unknown.queued.map((q) => q.id)).toEqual(next.queued.map((q) => q.id));
  });
});

describe('widgetWindowSize', () => {
  it('returns idle size when no visible rows (even if queued)', () => {
    const state = {
      occluded: true,
      visible: [] as WidgetStackItem[],
      queued: [item({ id: 'q' })],
      recent: [item({ id: 'q' })],
    };
    expect(widgetWindowSize(state)).toEqual({
      width: WIDGET_IDLE_WIDTH,
      height: WIDGET_IDLE_HEIGHT,
    });
  });

  it('sizes for N rows and adds message expand headroom', () => {
    const one = {
      ...emptyWidgetStack(),
      visible: [item({ id: '1', type: 'share' })],
    };
    // 43 + 12 + 30 + 0 + 10 = 95
    expect(widgetWindowSize(one)).toEqual({ width: WIDGET_STACK_WIDTH, height: 95 });

    const twoMsg = {
      ...emptyWidgetStack(),
      visible: [
        item({ id: '1', type: 'message' }),
        item({ id: '2', type: 'share' }),
      ],
    };
    // 43 + 12 + 60 + 6 + 10 + 110 = 241
    expect(widgetWindowSize(twoMsg)).toEqual({
      width: WIDGET_STACK_WIDTH,
      height: 95 + 30 + 6 + WIDGET_MESSAGE_EXPAND_HEADROOM,
    });
  });
});

describe('addItem → recent', () => {
  it('populates recent with unread=true, dedupes by id, caps at WIDGET_RECENT_MAX', () => {
    let state = emptyWidgetStack();
    state = addItem(state, item({ id: 'a', text: 'a' }));
    expect(state.recent).toHaveLength(1);
    expect(state.recent[0]).toMatchObject({ id: 'a', unread: true });

    // Dedupe: re-adding same id moves it to front, no duplicate.
    state = addItem(state, item({ id: 'b', text: 'b' }));
    state = addItem(state, item({ id: 'a', text: 'a-again' }));
    expect(state.recent.map((r) => r.id)).toEqual(['a', 'b']);
    expect(state.recent[0]?.unread).toBe(true);

    // Cap at WIDGET_RECENT_MAX (newest first; oldest drop).
    state = emptyWidgetStack();
    for (let i = 0; i < WIDGET_RECENT_MAX + 3; i++) {
      state = addItem(state, item({ id: `r${i}`, text: `${i}` }));
    }
    expect(state.recent).toHaveLength(WIDGET_RECENT_MAX);
    expect(state.recent[0]?.id).toBe(`r${WIDGET_RECENT_MAX + 2}`);
    expect(state.recent.every((r) => r.unread === true)).toBe(true);
  });

  it('also records recent while occluded (queued path)', () => {
    let state = setOccluded(emptyWidgetStack(), true, 0);
    state = addItem(state, item({ id: 'q1', text: 'q' }));
    expect(state.visible).toEqual([]);
    expect(state.queued.map((q) => q.id)).toEqual(['q1']);
    expect(state.recent.map((r) => r.id)).toEqual(['q1']);
    expect(state.recent[0]?.unread).toBe(true);
  });
});

describe('markQueueSeen / markRecentRead', () => {
  it('markQueueSeen clears queued but keeps recent; no-op when empty', () => {
    let state = setOccluded(emptyWidgetStack(), true, 0);
    state = addItem(state, item({ id: 'a' }));
    state = addItem(state, item({ id: 'b' }));
    expect(state.queued).toHaveLength(2);
    expect(state.recent).toHaveLength(2);

    const next = markQueueSeen(state);
    expect(next.queued).toEqual([]);
    expect(next.recent.map((r) => r.id)).toEqual(['b', 'a']);
    expect(markQueueSeen(next)).toBe(next);
  });

  it('markRecentRead flips unread to false; no-op when none unread', () => {
    let state = emptyWidgetStack();
    state = addItem(state, item({ id: 'a' }));
    state = addItem(state, item({ id: 'b' }));
    expect(state.recent.every((r) => r.unread === true)).toBe(true);

    const next = markRecentRead(state);
    expect(next.recent.every((r) => r.unread === false)).toBe(true);
    expect(markRecentRead(next)).toBe(next);
  });
});

describe('unreadRecentCount', () => {
  it('counts recent items with unread === true', () => {
    let state = emptyWidgetStack();
    expect(unreadRecentCount(state)).toBe(0);

    state = addItem(state, item({ id: 'a' }));
    state = addItem(state, item({ id: 'b' }));
    expect(unreadRecentCount(state)).toBe(2);

    // Mix of read/unread after partial mark.
    state = {
      ...state,
      recent: [
        { ...state.recent[0]!, unread: true },
        { ...state.recent[1]!, unread: false },
      ],
    };
    expect(unreadRecentCount(state)).toBe(1);
  });

  it('returns 0 after markRecentRead', () => {
    let state = emptyWidgetStack();
    state = addItem(state, item({ id: 'a' }));
    state = addItem(state, item({ id: 'b' }));
    expect(unreadRecentCount(state)).toBe(2);

    state = markRecentRead(state);
    expect(unreadRecentCount(state)).toBe(0);
  });
});

describe('hoverItems', () => {
  it('returns recent newest-first capped at WIDGET_HOVER_MAX', () => {
    let state = emptyWidgetStack();
    for (let i = 0; i < WIDGET_HOVER_MAX + 4; i++) {
      state = addItem(state, item({ id: `h${i}`, text: `${i}` }));
    }
    const items = hoverItems(state);
    expect(items).toHaveLength(WIDGET_HOVER_MAX);
    expect(items[0]?.id).toBe(`h${WIDGET_HOVER_MAX + 3}`);
    expect(items.map((i) => i.id)).toEqual(
      state.recent.slice(0, WIDGET_HOVER_MAX).map((r) => r.id),
    );
  });

  it('includes read items — unread does not filter inclusion (US-015)', () => {
    let state = emptyWidgetStack();
    state = addItem(state, item({ id: 'a', text: 'a' }));
    state = addItem(state, item({ id: 'b', text: 'b' }));
    state = markRecentRead(state);
    expect(state.recent.every((r) => r.unread === false)).toBe(true);
    expect(hoverItems(state).map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('serializeRecent / deserializeRecent (US-015)', () => {
  it('round-trips order and unread flags', () => {
    const state = {
      ...emptyWidgetStack(),
      recent: [
        item({ id: 'n1', text: 'first', unread: true, actor: 'Ada', type: 'message', kind: 'dm' }),
        item({
          id: 'n2',
          text: 'second',
          unread: false,
          actionLabel: 'Open',
          actionId: 'open-share',
        }),
      ],
    };
    const raw = serializeRecent(state);
    const restored = deserializeRecent(raw);
    expect(restored.map((r) => r.id)).toEqual(['n1', 'n2']);
    expect(restored[0]?.unread).toBe(true);
    expect(restored[1]?.unread).toBe(false);
    expect(restored[0]).toMatchObject({
      id: 'n1',
      text: 'first',
      actor: 'Ada',
      type: 'message',
      kind: 'dm',
    });
    // Display-only restore: the action surface is stripped from untrusted
    // storage so a tampered entry can never drive banner_action.
    expect(restored[1]).toMatchObject({
      id: 'n2',
      text: 'second',
      clickActionId: '',
      data: null,
    });
    expect(restored[1]?.actionId).toBeUndefined();
    expect(restored[1]?.actionLabel).toBeUndefined();
  });

  it('never rehydrates an action surface from tampered storage', () => {
    const raw = JSON.stringify([
      {
        id: 'evil',
        text: 'tampered',
        ts: 1,
        clickActionId: 'install-update',
        actionId: 'install-update',
        actionLabel: 'Update now',
        data: { url: 'https://evil.example' },
      },
    ]);
    const restored = deserializeRecent(raw);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: 'evil',
      clickActionId: '',
      data: null,
    });
    expect(restored[0]?.actionId).toBeUndefined();
    expect(restored[0]?.actionLabel).toBeUndefined();
  });

  it('returns [] for null, undefined, empty, and invalid JSON', () => {
    expect(deserializeRecent(null)).toEqual([]);
    expect(deserializeRecent(undefined)).toEqual([]);
    expect(deserializeRecent('')).toEqual([]);
    expect(deserializeRecent('not-json')).toEqual([]);
    expect(deserializeRecent('{"not":"array"}')).toEqual([]);
    expect(deserializeRecent('42')).toEqual([]);
  });

  it('filters junk entries and fills defaults', () => {
    const raw = JSON.stringify([
      null,
      'skip',
      42,
      { text: 'no-id', ts: 1 },
      { id: 'no-text', ts: 1 },
      { id: 'no-ts', text: 'x' },
      { id: 'ok', text: 'hello', ts: 5_000 },
    ]);
    const restored = deserializeRecent(raw);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: 'ok',
      text: 'hello',
      ts: 5_000,
      type: 'system',
      kind: 'system',
      clickActionId: '',
      data: null,
      expiresAt: 0,
      unread: false,
    });
  });

  it('caps at WIDGET_RECENT_MAX', () => {
    const many = Array.from({ length: WIDGET_RECENT_MAX + 5 }, (_, i) =>
      item({ id: `c${i}`, text: `${i}`, ts: 1_000 + i }),
    );
    const raw = serializeRecent({ ...emptyWidgetStack(), recent: many });
    const restored = deserializeRecent(raw);
    expect(restored).toHaveLength(WIDGET_RECENT_MAX);
    expect(restored[0]?.id).toBe('c0');
    expect(restored[WIDGET_RECENT_MAX - 1]?.id).toBe(`c${WIDGET_RECENT_MAX - 1}`);
  });

  it('coerces unread to boolean (truthy non-true → false)', () => {
    const raw = JSON.stringify([
      { id: 'a', text: 't', ts: 1, unread: 1 },
      { id: 'b', text: 't', ts: 2, unread: true },
      { id: 'c', text: 't', ts: 3, unread: false },
    ]);
    const restored = deserializeRecent(raw);
    expect(restored.map((r) => r.unread)).toEqual([false, true, false]);
  });
});

describe('dayLabel', () => {
  // Fixed "now": 2026-03-15 15:00 local
  const now = new Date(2026, 2, 15, 15, 0, 0).getTime();

  it('returns null for the same calendar day (TODAY implied)', () => {
    const morning = new Date(2026, 2, 15, 8, 0, 0).getTime();
    expect(dayLabel(morning, now)).toBeNull();
    expect(dayLabel(now, now)).toBeNull();
  });

  it('returns YESTERDAY for the previous calendar day', () => {
    const y = new Date(2026, 2, 14, 20, 0, 0).getTime();
    expect(dayLabel(y, now)).toBe('YESTERDAY');
  });

  it('returns uppercase short date for older days', () => {
    const older = new Date(2026, 2, 10, 12, 0, 0).getTime();
    expect(dayLabel(older, now)).toBe('MAR 10');
  });
});

describe('hoverRows', () => {
  const now = new Date(2026, 2, 15, 15, 0, 0).getTime();

  it('same-day list has no separators', () => {
    const items = [
      item({ id: 'n1', ts: now }),
      item({ id: 'n2', ts: now - 60_000 }),
    ];
    const rows = hoverRows(items, now);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.separator === null)).toBe(true);
  });

  it('spanning yesterday inserts one YESTERDAY separator', () => {
    const yTs = new Date(2026, 2, 14, 10, 0, 0).getTime();
    const items = [
      item({ id: 'today', ts: now }),
      item({ id: 'yest', ts: yTs }),
    ];
    const rows = hoverRows(items, now);
    expect(rows[0]).toMatchObject({ separator: null, item: { id: 'today' } });
    expect(rows[1]).toMatchObject({ separator: 'YESTERDAY', item: { id: 'yest' } });
  });
});

describe('widgetHoverWindowSize', () => {
  it('returns idle 66×43 for empty items', () => {
    expect(widgetHoverWindowSize([], 0)).toEqual({
      width: WIDGET_IDLE_WIDTH,
      height: WIDGET_IDLE_HEIGHT,
    });
    expect(WIDGET_IDLE_WIDTH).toBe(66);
    expect(WIDGET_IDLE_HEIGHT).toBe(43);
  });

  it('computes height from constants for N items and separators', () => {
    const one = [item({ id: '1' })];
    // mark + margin + headroom + padding + 1*row + 0*gap + 0*sep
    const h1 =
      WIDGET_MARK_AREA +
      WIDGET_STACK_MARGIN_BOTTOM +
      WIDGET_TOP_HEADROOM +
      WIDGET_HOVER_LIST_PADDING +
      WIDGET_HOVER_ROW_HEIGHT;
    expect(widgetHoverWindowSize(one, 0)).toEqual({
      width: WIDGET_HOVER_PANEL_WIDTH + 20,
      height: h1,
    });

    const two = [item({ id: '1' }), item({ id: '2' })];
    const h2 =
      WIDGET_MARK_AREA +
      WIDGET_STACK_MARGIN_BOTTOM +
      WIDGET_TOP_HEADROOM +
      WIDGET_HOVER_LIST_PADDING +
      2 * WIDGET_HOVER_ROW_HEIGHT +
      WIDGET_HOVER_ROW_GAP +
      WIDGET_HOVER_SEPARATOR_HEIGHT;
    expect(widgetHoverWindowSize(two, 1)).toEqual({
      width: WIDGET_HOVER_PANEL_WIDTH + 20,
      height: h2,
    });
  });

  it('adds message expand headroom when any item is a message (quick-reply never clips)', () => {
    const withMessage = [item({ id: '1', type: 'message' }), item({ id: '2' })];
    const base =
      WIDGET_MARK_AREA +
      WIDGET_STACK_MARGIN_BOTTOM +
      WIDGET_TOP_HEADROOM +
      WIDGET_HOVER_LIST_PADDING +
      2 * WIDGET_HOVER_ROW_HEIGHT +
      WIDGET_HOVER_ROW_GAP;
    expect(widgetHoverWindowSize(withMessage, 0)).toEqual({
      width: WIDGET_HOVER_PANEL_WIDTH + 20,
      height: base + WIDGET_MESSAGE_EXPAND_HEADROOM,
    });
  });
});

describe('widgetEmptyHoverWindowSize', () => {
  it('is strictly larger than idle 66×43 and matches one-item hover width', () => {
    const empty = widgetEmptyHoverWindowSize();
    const oneItem = widgetHoverWindowSize([item({ id: '1' })], 0);

    expect(empty.width).toBeGreaterThan(WIDGET_IDLE_WIDTH);
    expect(empty.height).toBeGreaterThan(WIDGET_IDLE_HEIGHT);
    expect(empty.width).toBe(oneItem.width);
    expect(empty).toEqual({
      width: WIDGET_HOVER_PANEL_WIDTH + 20,
      height:
        WIDGET_MARK_AREA +
        WIDGET_STACK_MARGIN_BOTTOM +
        WIDGET_TOP_HEADROOM +
        WIDGET_HOVER_LIST_PADDING +
        WIDGET_HOVER_ROW_HEIGHT,
    });
  });
});

describe('historyFeedItemToStackItem', () => {
  const lastRead = 1_000;

  it('maps dm → message with openable body + data', () => {
    const dm = {
      eventId: 'e1',
      fromPersonUid: 'prs_1',
      fromEmail: 'c@x.com',
      fromDisplayName: 'Corey',
      body: 'can you work on a d…',
      createdAt: '2026-07-11T09:39:00Z',
    };
    const row = historyFeedItemToStackItem(
      {
        id: 'dm:e1',
        kind: 'dm',
        actor: 'Corey',
        summary: dm.body,
        ts: 5_000,
        dm,
      },
      lastRead,
    );
    expect(row).toMatchObject({
      id: 'dm:e1',
      type: 'message',
      actor: 'Corey',
      text: dm.body,
      kind: 'dm',
      clickActionId: 'open',
      data: dm,
      unread: true,
    });
  });

  it('maps share → share with path basename preview', () => {
    const share = {
      eventId: 's1',
      issuerEmail: 'y@x.com',
      issuerDisplayName: 'Yousuf',
      paths: ['reports/q2-metrics.xlsx'],
      note: null,
      permission: 'read',
      createdAt: '2026-07-11T08:00:00Z',
    };
    const row = historyFeedItemToStackItem(
      {
        id: 'share:s1',
        kind: 'share',
        actor: 'Yousuf',
        summary: 'Shared a file: reports/q2-metrics.xlsx',
        ts: 4_000,
        share,
      },
      lastRead,
    );
    expect(row).toMatchObject({
      type: 'share',
      actor: 'Yousuf',
      text: 'q2-metrics.xlsx',
      kind: 'share',
      clickActionId: 'open',
      data: share,
      unread: true,
    });
  });

  it('maps new-file → sync with path basename + company data', () => {
    const row = historyFeedItemToStackItem(
      {
        id: 'file:1',
        kind: 'new-file',
        actor: 'Brand Honey',
        summary: 'New file in brand-honey: notes/sync.md',
        ts: 500,
        file: { company: 'brand-honey', path: 'notes/sync.md' },
      },
      lastRead,
    );
    expect(row).toMatchObject({
      type: 'sync',
      kind: 'new-file',
      text: 'sync.md',
      clickActionId: 'open',
      data: { company: 'brand-honey', path: 'notes/sync.md' },
      unread: false,
    });
  });
});

describe('mergeRecentWithHistory', () => {
  it('prefers openable history over display-only local twin', () => {
    const local: WidgetStackItem[] = [
      item({
        id: 'dm:e1',
        type: 'message',
        kind: 'dm',
        text: 'stale',
        clickActionId: '',
        data: null,
        ts: 2_000,
        unread: true,
      }),
      item({
        id: 'wn-update',
        kind: 'update',
        text: 'New version — 0.10.8',
        clickActionId: '',
        data: null,
        ts: 9_000,
      }),
    ];
    const history: WidgetStackItem[] = [
      historyFeedItemToStackItem(
        {
          id: 'dm:e1',
          kind: 'dm',
          actor: 'Corey',
          summary: 'hello',
          ts: 2_000,
          dm: { eventId: 'e1', body: 'hello', fromPersonUid: 'prs' },
        },
        0,
      ),
      historyFeedItemToStackItem(
        {
          id: 'share:s1',
          kind: 'share',
          actor: 'Yousuf',
          summary: 'q2.xlsx',
          ts: 3_000,
          share: { paths: ['q2.xlsx'] },
        },
        0,
      ),
    ];

    const merged = mergeRecentWithHistory(local, history);
    expect(merged.map((r) => r.id)).toEqual(['wn-update', 'share:s1', 'dm:e1']);
    expect(merged.find((r) => r.id === 'dm:e1')).toMatchObject({
      clickActionId: 'open',
      data: { eventId: 'e1' },
      unread: true,
    });
    expect(merged.find((r) => r.id === 'wn-update')?.kind).toBe('update');
  });

  it('caps at WIDGET_RECENT_MAX newest-first', () => {
    const history = Array.from({ length: WIDGET_RECENT_MAX + 5 }, (_, i) =>
      historyFeedItemToStackItem(
        {
          id: `h${i}`,
          kind: 'dm',
          actor: 'A',
          summary: `${i}`,
          ts: 1_000 + i,
          dm: { body: `${i}` },
        },
        0,
      ),
    );
    const merged = mergeRecentWithHistory([], history);
    expect(merged).toHaveLength(WIDGET_RECENT_MAX);
    expect(merged[0]?.id).toBe(`h${WIDGET_RECENT_MAX + 4}`);
  });

  it('hover list surfaces up to WIDGET_HOVER_MAX after merge', () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      historyFeedItemToStackItem(
        {
          id: `h${i}`,
          kind: 'share',
          actor: 'A',
          summary: `f${i}.xlsx`,
          ts: 10_000 - i,
          share: { paths: [`f${i}.xlsx`] },
        },
        0,
      ),
    );
    const state = {
      ...emptyWidgetStack(),
      recent: mergeRecentWithHistory([], history),
    };
    expect(hoverItems(state)).toHaveLength(WIDGET_HOVER_MAX);
    expect(hoverItems(state)[0]?.id).toBe('h0');
  });
});
