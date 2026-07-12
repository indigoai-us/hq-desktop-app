// @vitest-environment happy-dom
//
// US-015: Widget popup shows recent history, not just unviewed.
// Behavioral mounts (no Tauri) + localStorage hydration/persistence.
//
// e2eTests from the PRD:
// 1. Given 7 previously-viewed notifications, click wordmark → all 7 rows, no unread dots.
// 2. Mix of read/unread → all rows, dots only on unread; badge shows unread count only.
// 3. Restart persistence: seed localStorage, mount without initialItems → rows survive;
//    empty localStorage + no items → empty state.
// 4. 10-max: 12 recent items → popup renders exactly 10 rows.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force Svelte's client entry so mount/flushSync work (same pattern as US-003).
vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import Widget from '../../src/components/Widget.svelte';
import {
  WIDGET_HOVER_MAX,
  WIDGET_RECENT_STORAGE_KEY,
  WIDGET_ROW_TIMEOUT_MS,
  emptyWidgetStack,
  serializeRecent,
  type WidgetStackItem,
} from '../../src/stores/widgetNotifications';

/**
 * happy-dom in this repo's vitest setup does not expose localStorage (Node's
 * experimental localStorage is also undefined without --localstorage-file).
 * Install an in-memory Storage so Widget hydration/persist and test seeds work.
 */
function makeMemStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    setItem(k: string, v: string) {
      store.set(k, String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    key(i: number) {
      return [...store.keys()][i] ?? null;
    },
  };
}

const g = globalThis as unknown as { localStorage?: Storage };

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

/** Open the pinned popup by clicking the wordmark. */
function pinOpen(): HTMLElement {
  host.querySelector('.wm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
  const list = host.querySelector<HTMLElement>('[data-testid="widget-hover-list"]');
  expect(list).toBeTruthy();
  return list!;
}

function installLocalStorage(mem: Storage): void {
  // Node's experimental localStorage / happy-dom may expose a non-writable
  // binding — always redefine as configurable so tests can reinstall.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: mem,
  });
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: mem,
    });
  } catch {
    // ignore
  }
}

// Capture whatever binding existed before this suite so the polyfill never
// leaks into other test files sharing this environment (CI single-process).
const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  installLocalStorage(makeMemStorage());
});

afterAll(() => {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  try {
    g.localStorage?.clear();
  } catch {
    // ignore
  }
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('US-015: widget popup shows recent history (not just unviewed)', () => {
  describe('viewed history still listed', () => {
    it('7 previously-viewed notifications all render; none carries the unread dot', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
      const now = Date.now();
      const items = Array.from({ length: 7 }, (_, i) =>
        stackItem(
          {
            id: `v${i}`,
            type: 'sync',
            text: `viewed ${i}`,
            unread: false,
          },
          now - i * 1_000,
        ),
      );
      mountWidget({ initialItems: items });

      const list = pinOpen();
      const rows = list.querySelectorAll('[data-testid="notification-row"]');
      expect(rows).toHaveLength(7);
      expect(list.querySelectorAll('.nr-unread')).toHaveLength(0);
    });
  });

  describe('mixed read / unread', () => {
    it('all rows render; only unread rows carry dots; badge is unread count only', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem({ id: 'u1', text: 'unread one', unread: true }, now),
          stackItem({ id: 'r1', text: 'read one', unread: false }, now - 1_000),
          stackItem({ id: 'u2', text: 'unread two', unread: true }, now - 2_000),
          stackItem({ id: 'r2', text: 'read two', unread: false }, now - 3_000),
        ],
      });

      const list = pinOpen();
      const rows = [...list.querySelectorAll('[data-testid="notification-row"]')];
      expect(rows).toHaveLength(4);

      // Order is newest-first (seed order from initialItems).
      const dotsPerRow = rows.map((row) => row.querySelectorAll('.nr-unread').length);
      expect(dotsPerRow).toEqual([1, 0, 1, 0]);
      expect(list.querySelectorAll('.nr-unread')).toHaveLength(2);

      const badge = host.querySelector('[data-testid="widget-unread-badge"]');
      expect(badge).toBeTruthy();
      expect(badge!.textContent?.trim()).toBe('2');
    });
  });

  describe('restart persistence', () => {
    it('hydrates recent from localStorage when mounted with no initialItems', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
      const now = Date.now();
      const state = {
        ...emptyWidgetStack(),
        recent: [
          stackItem({ id: 'persisted-a', text: 'survived A', unread: false }, now),
          stackItem({ id: 'persisted-b', text: 'survived B', unread: true }, now - 5_000),
        ],
      };
      g.localStorage!.setItem(WIDGET_RECENT_STORAGE_KEY, serializeRecent(state));

      // No initialItems — simulates relaunch with only persisted history.
      mountWidget();
      const list = pinOpen();
      const rows = list.querySelectorAll('[data-testid="notification-row"]');
      expect(rows).toHaveLength(2);
      const texts = [...rows].map((r) => r.textContent ?? '');
      expect(texts.some((t) => t.includes('survived A'))).toBe(true);
      expect(texts.some((t) => t.includes('survived B'))).toBe(true);
      // Persisted items go to recent only — never the live stack.
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    });

    it('empty localStorage and no items → empty state copy', () => {
      g.localStorage!.clear();
      mountWidget();
      const list = pinOpen();
      const empty = list.querySelector('[data-testid="widget-empty-state"]');
      expect(empty).toBeTruthy();
      expect(empty!.textContent?.trim()).toBe('No recent notifications');
      expect(list.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(0);
    });

    it('persists recent to localStorage when stack changes', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem({ id: 'live', text: 'live row', unread: true }, now),
        ],
      });
      flushSync();
      const raw = g.localStorage!.getItem(WIDGET_RECENT_STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(raw!).toContain('live');
      expect(raw!).toContain('live row');
    });
  });

  describe('hover max 10', () => {
    it('seeds 12 recent items → popup renders exactly WIDGET_HOVER_MAX (10) rows', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
      const now = Date.now();
      const items = Array.from({ length: 12 }, (_, i) =>
        stackItem(
          {
            id: `m${i}`,
            text: `row ${i}`,
            unread: i % 2 === 0,
          },
          now - i * 1_000,
        ),
      );
      mountWidget({ initialItems: items });

      const list = pinOpen();
      expect(list.querySelectorAll('[data-testid="notification-row"]')).toHaveLength(
        WIDGET_HOVER_MAX,
      );
      expect(WIDGET_HOVER_MAX).toBe(10);
    });
  });

  describe('server history seed + open routing (source contracts)', () => {
    it('Widget seeds recent from notification history and routes Open by kind', () => {
      // Regression: popup only showed local update banners, and Open on
      // localStorage-hydrated rows no-op'd (stripped clickActionId).
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { resolve } = require('node:path') as typeof import('node:path');
      const src = readFileSync(
        resolve(process.cwd(), 'src/components/Widget.svelte'),
        'utf8',
      );
      expect(src).toContain('loadNotificationItems');
      expect(src).toContain('mergeRecentWithHistory');
      expect(src).toContain('historyFeedItemToStackItem');
      expect(src).toContain('refreshRecentFromHistory');
      expect(src).toContain("open_dm_detail");
      expect(src).toContain("open_share_detail");
      expect(src).toContain("show_main_window");
      expect(src).toContain("open_desktop_alt_window");
      // Must not silent-dismiss when clickActionId is empty.
      expect(src).not.toMatch(
        /if \(!hasTauri\(\) \|\| !item\.clickActionId\) \{\s*applyStack\(dismissItem/,
      );
    });

    it('update Open pins mini inbox; wordmark has Inbox + desktop context menu', () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { resolve } = require('node:path') as typeof import('node:path');
      const src = readFileSync(
        resolve(process.cwd(), 'src/components/Widget.svelte'),
        'utf8',
      );
      expect(src).toContain('function openMiniInbox');
      // Non-install update Open → mini inbox (not menubar).
      expect(src).toMatch(/kind === 'update'[\s\S]*openMiniInbox\(\)/);
      expect(src).toContain('oncontextmenu={handleWordmarkContextMenu}');
      expect(src).toContain('widget-context-menu');
      expect(src).toContain('widget-menu-inbox');
      expect(src).toContain('widget-menu-desktop');
      expect(src).toContain('Open desktop view');
    });
  });

  describe('context menu (behavioral)', () => {
    it('right-click wordmark shows Inbox + Open desktop view items', () => {
      mountWidget();
      const wm = host.querySelector('.wm')!;
      wm.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      flushSync();
      const menu = host.querySelector('[data-testid="widget-context-menu"]');
      expect(menu).toBeTruthy();
      expect(host.querySelector('[data-testid="widget-menu-inbox"]')?.textContent?.trim()).toBe(
        'Inbox',
      );
      expect(
        host.querySelector('[data-testid="widget-menu-desktop"]')?.textContent?.trim(),
      ).toBe('Open desktop view');
    });

    it('Inbox menu item pins the mini notification list', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
      const now = Date.now();
      mountWidget({
        initialItems: [
          stackItem({ id: 'n1', text: 'hello', kind: 'update', unread: true }, now),
        ],
      });
      const wm = host.querySelector('.wm')!;
      wm.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      flushSync();
      host.querySelector<HTMLButtonElement>('[data-testid="widget-menu-inbox"]')!.click();
      flushSync();
      expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeNull();
      expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();
      expect(host.querySelectorAll('[data-testid="notification-row"]').length).toBeGreaterThan(0);
    });
  });
});
