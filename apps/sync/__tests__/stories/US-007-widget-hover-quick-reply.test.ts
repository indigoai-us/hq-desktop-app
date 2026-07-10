// @vitest-environment happy-dom
//
// US-007: Widget hover recent-list + quick-reply focusable command
// Behavioral mounts (no Tauri) + source contracts for set_widget_focusable
// registration and Widget.svelte hover/focus wiring.

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
  type WidgetStackItem,
} from '../../src/stores/widgetNotifications';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);

const widgetSource = readFileSync(root('src/components/Widget.svelte'), 'utf8');
const widgetRs = readFileSync(root('src-tauri/src/commands/widget.rs'), 'utf8');
const mainRs = readFileSync(root('src-tauri/src/main.rs'), 'utf8');

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

describe('US-007: widget hover list + quick-reply focusable', () => {
  describe('hover opens recent list', () => {
    it('hovering the wordmark renders widget-hover-list with seeded rows newest first', () => {
      const now = Date.now();
      const older = stackItem(
        { id: 'older', type: 'share', kind: 'share', actor: 'Yousuf', text: 'q2.xlsx' },
        now - 1000,
      );
      const newer = stackItem(
        { id: 'newer', type: 'message', kind: 'dm', actor: 'Corey', text: 'ship it' },
        now,
      );
      // Seed newest-first (matches store order).
      mountWidget({ initialItems: [newer, older] });

      const wm = host.querySelector('.wm');
      expect(wm).toBeTruthy();
      wm!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      flushSync();

      const list = host.querySelector('[data-testid="widget-hover-list"]');
      expect(list).toBeTruthy();

      const rows = list!.querySelectorAll('[data-testid="notification-row"]');
      expect(rows.length).toBe(2);
      // Newest first
      expect(rows[0]?.textContent).toMatch(/ship it|Corey/);
      expect(rows[1]?.textContent).toMatch(/q2\.xlsx|Yousuf/);

      // Transient stack hidden while hover list is open
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    });

    it('queued superscript clears after hover open (prop seed + hoverSeen)', () => {
      // Seed recent as already-read so the badge falls through to the queued
      // prop (US-010: unread count takes priority when > 0).
      mountWidget({
        queued: 3,
        initialItems: [stackItem({ id: 'a', text: 'one', unread: false }, Date.now())],
      });

      expect(host.querySelector('.qd')?.textContent).toBe('3');

      host.querySelector('.wm')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      flushSync();

      expect(host.querySelector('.qd')).toBeNull();
    });

    it('pointer leave of .wg collapses the list after the delay', () => {
      vi.useFakeTimers();
      const now = Date.now();
      mountWidget({
        initialItems: [stackItem({ id: 'a', text: 'row' }, now)],
      });

      host.querySelector('.wm')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      flushSync();
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();

      host.querySelector('.wg')!.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      flushSync();
      // Still open before delay
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();

      vi.advanceTimersByTime(500);
      flushSync();
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
    });

    it("day separator renders YESTERDAY when seeded items span days", () => {
      const now = Date.now();
      const today = stackItem({ id: 't', text: 'today row' }, now);
      const yesterday = stackItem(
        { id: 'y', text: 'yesterday row' },
        now - 26 * 60 * 60 * 1000,
      );
      mountWidget({ initialItems: [today, yesterday] });

      host.querySelector('.wm')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      flushSync();

      const sep = host.querySelector('.hl-sep');
      expect(sep).toBeTruthy();
      expect(sep?.textContent).toBe('YESTERDAY');
    });
  });

  describe('source contracts', () => {
    it('widget.rs defines set_widget_focusable with set_focusable + set_focus', () => {
      expect(widgetRs).toContain('pub async fn set_widget_focusable');
      expect(widgetRs).toContain('set_focusable(');
      expect(widgetRs).toContain('set_focus(');
    });

    it('main.rs registers commands::widget::set_widget_focusable', () => {
      expect(mainRs).toContain('commands::widget::set_widget_focusable');
    });

    it('Widget.svelte invokes set_widget_focusable and wires onpointerleave', () => {
      expect(widgetSource).toContain('set_widget_focusable');
      expect(widgetSource).toContain('onpointerleave');
    });
  });
});
