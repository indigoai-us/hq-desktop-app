// @vitest-environment happy-dom
//
// US-012: Never hide a notification under the pointer or during reply
// Pure-store setHeld/expireItems semantics + Widget mounts (no Tauri) for
// pointer-hold and reply-hold auto-collapse suspension.

import { afterEach, describe, expect, it, vi } from 'vitest';

// Vitest resolves Svelte's public entry with the default/server condition in
// this repo's node test config, even for per-file happy-dom tests. Force the
// client entry so mount/flushSync work (same pattern as US-003 / US-007).
vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import Widget from '../../src/components/Widget.svelte';
import {
  WIDGET_ROW_TIMEOUT_MS,
  emptyWidgetStack,
  expireItems,
  setHeld,
  type WidgetStackItem,
} from '../../src/stores/widgetNotifications';

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

/** Set an input's bound value the way Svelte 5's bind:value listens for. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  proto?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('US-012: never hide under pointer or during reply', () => {
  describe('pure store: setHeld + expireItems while held', () => {
    it('setHeld enter/release semantics; expireItems no-op while held; expiresAt refreshed on release', () => {
      const t0 = 10_000;
      let state = emptyWidgetStack();
      expect(state.held).toBe(false);

      state = {
        ...state,
        visible: [
          stackItem({ id: 'a', expiresAt: t0 + WIDGET_ROW_TIMEOUT_MS }, t0),
          stackItem({ id: 'b', expiresAt: t0 + 500 }, t0),
        ],
      };

      // Enter hold — flag flips, arrays copied, expiresAt unchanged.
      const entered = setHeld(state, true, t0 + 100);
      expect(entered).not.toBe(state);
      expect(entered.held).toBe(true);
      expect(entered.visible.map((v) => v.expiresAt)).toEqual(
        state.visible.map((v) => v.expiresAt),
      );
      // Idempotent when already held.
      expect(setHeld(entered, true, t0 + 200)).toBe(entered);

      // Auto-collapse suspended while held even past every expiresAt.
      expect(expireItems(entered, t0 + WIDGET_ROW_TIMEOUT_MS + 50_000)).toBe(entered);
      expect(expireItems(entered, t0 + WIDGET_ROW_TIMEOUT_MS + 50_000).visible).toHaveLength(2);

      // Release — held false AND every visible expiresAt restarts from now.
      const releaseAt = t0 + 5_000;
      const released = setHeld(entered, false, releaseAt);
      expect(released.held).toBe(false);
      expect(released.visible.every((v) => v.expiresAt === releaseAt + WIDGET_ROW_TIMEOUT_MS)).toBe(
        true,
      );
      // Idempotent when already released.
      expect(setHeld(released, false, releaseAt + 1)).toBe(released);

      // After release, expiry works again.
      const stillLive = expireItems(released, releaseAt + WIDGET_ROW_TIMEOUT_MS - 1);
      expect(stillLive.visible).toHaveLength(2);
      const gone = expireItems(released, releaseAt + WIDGET_ROW_TIMEOUT_MS + 1);
      expect(gone.visible).toEqual([]);
    });

    it('emptyWidgetStack starts with held:false', () => {
      expect(emptyWidgetStack()).toEqual({
        visible: [],
        queued: [],
        recent: [],
        occluded: false,
        held: false,
      });
    });
  });

  describe('pointer over stack row suspends auto-hide', () => {
    it('row survives past timeout while pointer is over stack; expires after leave', () => {
      vi.useFakeTimers();
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem(
            {
              id: 'm1',
              type: 'message',
              kind: 'dm',
              actor: 'Corey',
              text: 'ship it',
            },
            now,
          ),
        ],
      });

      const stackEl = host.querySelector('[data-testid="widget-stack"]');
      expect(stackEl).toBeTruthy();
      expect(host.querySelector('[data-testid="notification-row"]')).toBeTruthy();

      // Pointer over the stack suspends auto-hide.
      stackEl!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      flushSync();

      // Advance well past the original expiresAt + the 1s expiry interval.
      vi.advanceTimersByTime(WIDGET_ROW_TIMEOUT_MS + 2_000);
      flushSync();
      expect(host.querySelector('[data-testid="notification-row"]')).toBeTruthy();

      // Leave — timers restart; row should expire after a fresh timeout window.
      stackEl!.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      flushSync();

      vi.advanceTimersByTime(WIDGET_ROW_TIMEOUT_MS + 2_000);
      flushSync();
      expect(host.querySelector('[data-testid="notification-row"]')).toBeNull();
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    });
  });

  describe('reply focus + draft hold', () => {
    it('focus + draft keep the row visible through pointerleave past timeout', () => {
      vi.useFakeTimers();
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem(
            {
              id: 'dm1',
              type: 'message',
              kind: 'dm',
              actor: 'Corey',
              text: 'need a sec',
            },
            now,
          ),
        ],
      });

      const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]');
      expect(row).toBeTruthy();

      // Hover-expand to reveal the reply input.
      row!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      flushSync();
      expect(row!.getAttribute('data-expanded')).toBe('true');

      const input = host.querySelector<HTMLInputElement>('input.nr-reply');
      expect(input).toBeTruthy();

      input!.focus();
      input!.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      flushSync();
      setInputValue(input!, 'drafting a reply');
      flushSync();
      expect(input!.value).toBe('drafting a reply');

      // Pointer leaves the stack — draft/focus hold keeps the row alive.
      const stackEl = host.querySelector('[data-testid="widget-stack"]');
      expect(stackEl).toBeTruthy();
      stackEl!.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      flushSync();

      vi.advanceTimersByTime(WIDGET_ROW_TIMEOUT_MS + 2_000);
      flushSync();

      const still = host.querySelector<HTMLElement>('[data-testid="notification-row"]');
      expect(still).toBeTruthy();
      const stillInput = host.querySelector<HTMLInputElement>('input.nr-reply');
      expect(stillInput).toBeTruthy();
      expect(stillInput!.value).toBe('drafting a reply');
    });

    it('Escape clears draft and resumes normal expiry after pointer leaves', () => {
      vi.useFakeTimers();
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem(
            {
              id: 'dm2',
              type: 'message',
              kind: 'dm',
              actor: 'Corey',
              text: 'ping',
            },
            now,
          ),
        ],
      });

      const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
      row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      flushSync();

      const input = host.querySelector<HTMLInputElement>('input.nr-reply')!;
      input.focus();
      input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      flushSync();
      setInputValue(input, 'will cancel');
      flushSync();
      expect(input.value).toBe('will cancel');

      // Leave stack while still drafting.
      const stackEl = host.querySelector('[data-testid="widget-stack"]')!;
      stackEl.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      flushSync();

      // Escape clears draft and blurs — releases reply hold.
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      flushSync();
      expect(input.value).toBe('');

      // Normal collapse resumes: row expires after a fresh timeout window.
      vi.advanceTimersByTime(WIDGET_ROW_TIMEOUT_MS + 2_000);
      flushSync();
      expect(host.querySelector('[data-testid="notification-row"]')).toBeNull();
    });
  });
});
