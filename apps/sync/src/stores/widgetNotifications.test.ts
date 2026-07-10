import { describe, expect, it } from 'vitest';
import {
  WIDGET_IDLE_HEIGHT,
  WIDGET_IDLE_WIDTH,
  WIDGET_MESSAGE_EXPAND_HEADROOM,
  WIDGET_ROW_TIMEOUT_MS,
  WIDGET_STACK_MAX,
  WIDGET_STACK_WIDTH,
  addItem,
  bannerToStackItem,
  dismissItem,
  emptyWidgetStack,
  expireItems,
  setOccluded,
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
    };
    const next = dismissItem(state, 'v');
    expect(next.visible).toEqual([]);
    expect(next.queued.map((q) => q.id)).toEqual(['q']);
  });
});

describe('widgetWindowSize', () => {
  it('returns idle size when no visible rows (even if queued)', () => {
    const state = {
      occluded: true,
      visible: [] as WidgetStackItem[],
      queued: [item({ id: 'q' })],
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
