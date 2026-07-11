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
  dismissItem,
  dismissRecent,
  emptyWidgetStack,
  expireItems,
  hoverItems,
  hoverRows,
  markQueueSeen,
  markRecentRead,
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
