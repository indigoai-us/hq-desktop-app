import { describe, expect, it } from 'vitest';
import {
  WIDGET_HOVER_MAX,
  WIDGET_ROW_TIMEOUT_MS,
  addItem,
  emptyWidgetStack,
  hoverItems,
  markQueueSeen,
  setOccluded,
  type WidgetStackItem,
} from '../../src/stores/widgetNotifications';
import { readRepoFile } from './harness';

/**
 * US-007 — Widget hover recent-list + quick-reply focusable (source contracts
 * + pure reducer checks). Headless e2e cannot drive a real NSWindow; locks the
 * Rust command registration, Widget hover markup, and store helpers.
 */

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

describe('US-007: set_widget_focusable command registration', () => {
  const widget = readRepoFile('src-tauri/src/commands/widget.rs');
  const main = readRepoFile('src-tauri/src/main.rs');
  const widgetUi = readRepoFile('src/components/Widget.svelte');

  it('widget.rs exposes set_widget_focusable with set_focusable + set_focus', () => {
    expect(widget).toContain('pub async fn set_widget_focusable');
    expect(widget).toContain('set_focusable(');
    expect(widget).toContain('set_focus(');
  });

  it('main.rs registers the command next to resize_widget', () => {
    expect(main).toContain('commands::widget::set_widget_focusable');
    const resizeIdx = main.indexOf('commands::widget::resize_widget');
    const focusIdx = main.indexOf('commands::widget::set_widget_focusable');
    expect(resizeIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeGreaterThan(resizeIdx);
  });

  it('Widget.svelte invokes set_widget_focusable and restores on pointer leave', () => {
    expect(widgetUi).toContain('set_widget_focusable');
    expect(widgetUi).toContain('onpointerleave');
  });
});

describe('US-007: hover list markup + markQueueSeen wiring', () => {
  const widgetUi = readRepoFile('src/components/Widget.svelte');
  const store = readRepoFile('src/stores/widgetNotifications.ts');

  it('Widget renders data-testid="widget-hover-list" and uses markQueueSeen', () => {
    expect(widgetUi).toContain('data-testid="widget-hover-list"');
    expect(widgetUi).toContain('markQueueSeen');
    expect(widgetUi).toContain('openHoverList');
  });

  it('store exports markQueueSeen and hoverItems', () => {
    expect(store).toContain('export function markQueueSeen');
    expect(store).toContain('export function hoverItems');
    expect(store).toContain('export function markRecentRead');
  });
});

describe('US-007: pure reducers — markQueueSeen / hoverItems', () => {
  it('markQueueSeen clears queued while preserving recent', () => {
    let state = setOccluded(emptyWidgetStack(), true, 0);
    state = addItem(state, item({ id: 'a', text: 'a' }));
    state = addItem(state, item({ id: 'b', text: 'b' }));
    expect(state.queued.map((q) => q.id)).toEqual(['b', 'a']);
    expect(state.recent.map((r) => r.id)).toEqual(['b', 'a']);

    const next = markQueueSeen(state);
    expect(next.queued).toEqual([]);
    expect(next.recent.map((r) => r.id)).toEqual(['b', 'a']);
    expect(markQueueSeen(next)).toBe(next);
  });

  it('hoverItems returns newest-first recent capped at WIDGET_HOVER_MAX', () => {
    let state = emptyWidgetStack();
    for (let i = 0; i < WIDGET_HOVER_MAX + 3; i++) {
      state = addItem(state, item({ id: `i${i}`, text: `${i}` }));
    }
    const items = hoverItems(state);
    expect(items).toHaveLength(WIDGET_HOVER_MAX);
    expect(items[0]?.id).toBe(`i${WIDGET_HOVER_MAX + 2}`);
    expect(items.every((r) => r.unread === true)).toBe(true);
  });
});
