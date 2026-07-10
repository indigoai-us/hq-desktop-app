// @vitest-environment happy-dom
//
// US-010: Widget click-to-open + unread badge
// Behavioral mounts (no Tauri) + source contracts for resize_widget anchoring
// (pinned open reuses hoverOpen size path — must not regress matched size+position).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Vitest resolves Svelte's public entry with the default/server condition in
// this repo's node test config, even for per-file happy-dom tests. Force the
// client entry so mount/flushSync work (same pattern as US-003).
vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import Widget from '../../src/components/Widget.svelte';
import {
  WIDGET_ROW_TIMEOUT_MS,
  emptyWidgetStack,
  markRecentRead,
  widgetWindowSize,
  type WidgetStackItem,
} from '../../src/stores/widgetNotifications';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);

const widgetSource = readFileSync(root('src/components/Widget.svelte'), 'utf8');
const widgetRs = readFileSync(root('src-tauri/src/commands/widget.rs'), 'utf8');

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function mountWidget(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(Widget, { target: host, props });
  flushSync();
  return host;
}

function stackItem(
  overrides: Partial<WidgetStackItem> & Pick<WidgetStackItem, 'id'>,
  now = 1_000,
): WidgetStackItem {
  return {
    type: 'system',
    text: 'hello',
    ts: now,
    kind: 'update',
    clickActionId: 'open',
    data: null,
    expiresAt: now + WIDGET_ROW_TIMEOUT_MS,
    ...overrides,
  };
}

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('US-010: widget click-to-open + unread badge', () => {
  describe('unread badge', () => {
    it('shows widget-unread-badge with unread count when initialItems are seeded', () => {
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem({ id: 'a', text: 'one', unread: true }, now),
          stackItem({ id: 'b', text: 'two', unread: true }, now - 1000),
        ],
      });

      const badge = host.querySelector('[data-testid="widget-unread-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe('2');
    });
  });

  describe('click-to-open pin', () => {
    it('clicking .wm opens pinned hover list that survives pointerleave', () => {
      vi.useFakeTimers();
      const now = Date.now();
      mountWidget({
        initialItems: [stackItem({ id: 'a', text: 'row', unread: true }, now)],
      });

      const wm = host.querySelector('.wm');
      expect(wm).toBeTruthy();
      wm!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();

      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();

      host.querySelector('.wg')!.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      flushSync();
      vi.advanceTimersByTime(500);
      flushSync();

      // Pinned — list stays open past the hover collapse delay.
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();
    });

    it('click-away on document.body closes list and clears unread badge', () => {
      const now = Date.now();
      mountWidget({
        initialItems: [stackItem({ id: 'a', text: 'row', unread: true }, now)],
      });

      host.querySelector('.wm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="widget-unread-badge"]')).toBeTruthy();

      // Capture-phase pointerdown on body (outside .hover-list and .wm).
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      flushSync();

      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
      expect(host.querySelector('[data-testid="widget-unread-badge"]')).toBeNull();
    });

    it('re-click .wm toggles closed and clears badge', () => {
      const now = Date.now();
      mountWidget({
        initialItems: [stackItem({ id: 'a', text: 'row', unread: true }, now)],
      });

      const wm = host.querySelector('.wm')!;
      wm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();

      wm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
      expect(host.querySelector('[data-testid="widget-unread-badge"]')).toBeNull();
    });
  });

  describe('anchor regression (source contracts + store size)', () => {
    it('Widget.svelte resize $effect still calls resize_widget with hover/idle sizes', () => {
      expect(widgetSource).toContain("invoke('resize_widget'");
      expect(widgetSource).toContain('widgetHoverWindowSize');
      expect(widgetSource).toContain('widgetWindowSize');
    });

    it('widget.rs resize_widget uses widget_position_for and anchor_lower_right', () => {
      expect(widgetRs).toContain('pub async fn resize_widget');
      expect(widgetRs).toContain('widget_position_for');
      expect(widgetRs).toContain('anchor_lower_right');
    });

    it('widgetWindowSize returns idle 66×43 after list closes with no visible rows', () => {
      let state = emptyWidgetStack();
      // Simulate seed → open (mark queue) → close (mark recent read) with empty visible.
      state = {
        ...state,
        recent: [
          stackItem({ id: 'a', unread: true }, Date.now()),
        ],
      };
      state = markRecentRead(state);
      expect(state.visible).toHaveLength(0);
      expect(widgetWindowSize(state)).toEqual({ width: 66, height: 43 });
    });
  });
});
