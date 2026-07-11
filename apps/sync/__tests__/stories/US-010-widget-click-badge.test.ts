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

    it('clicking .wm with empty stack shows empty-state panel; re-click closes', () => {
      mountWidget();

      const wm = host.querySelector('.wm')!;
      wm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();

      const list = host.querySelector('[data-testid="widget-hover-list"]');
      expect(list).toBeTruthy();
      expect(list?.querySelector('[data-testid="widget-empty-state"]')).toBeTruthy();
      expect(list?.textContent).toContain('No recent notifications');

      wm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
    });

    it('hover alone on .wm with empty stack does not render hover list', () => {
      mountWidget();

      host.querySelector('.wm')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      flushSync();

      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
      expect(host.querySelector('[data-testid="widget-empty-state"]')).toBeNull();
    });

    it('click-away on document.body closes pinned empty state', () => {
      mountWidget();

      host.querySelector('.wm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSync();
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="widget-empty-state"]')).toBeTruthy();

      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      flushSync();

      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
      expect(host.querySelector('[data-testid="widget-empty-state"]')).toBeNull();
    });
  });

  describe('anchor regression (source contracts + store size)', () => {
    it('Widget.svelte resize $effect still calls resize_widget with hover/idle sizes', () => {
      expect(widgetSource).toContain("invoke('resize_widget'");
      expect(widgetSource).toContain('widgetHoverWindowSize');
      expect(widgetSource).toContain('widgetWindowSize');
    });

    it('native click-away monitor is wired: Rust global mouse monitor + frontend listener', () => {
      // The non-focusable widget window never blurs and outside clicks never
      // reach its document — Rust must run a global NSEvent monitor and the
      // frontend must close a pinned list on widget:click-away.
      expect(widgetRs).toContain('addGlobalMonitorForEventsMatchingMask');
      expect(widgetRs).toContain('widget:click-away');
      expect(widgetRs).toContain('register_click_away_monitor');
      // Monitor must ignore clicks inside the widget frame so the opening
      // click can never be misread as click-away and dismiss the popup it
      // pinned (defense-in-depth — own-window event routing for an inactive
      // Accessory app is not a contract we control across macOS releases).
      expect(widgetRs).toContain('mouse_location_inside_widget');
      expect(widgetRs).toContain('point_in_frame');
      expect(widgetSource).toContain("listen('widget:click-away'");
    });

    it('closePinned restores non-activating mode (setWidgetFocusable(false))', () => {
      const closeBody = widgetSource.slice(
        widgetSource.indexOf('function closePinned'),
        widgetSource.indexOf('function togglePinned'),
      );
      expect(closeBody).toContain('setWidgetFocusable(false)');
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
