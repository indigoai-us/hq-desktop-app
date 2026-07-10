// @vitest-environment happy-dom
//
// US-003: Notification takeover with queue-on-occlusion
// Pure-store behavioral tests + Widget mounts (no Tauri) + source contracts on
// the Rust takeover funnel, native-path gates, occlusion observer, and ready
// handshake. Native macOS banner delivery cannot run in CI — gates are asserted
// via source contracts so UN / mac_notification_sys paths stay unreachable
// while takeover is active.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Vitest resolves Svelte's public entry with the default/server condition in
// this repo's node test config, even for per-file happy-dom tests. Force the
// client entry so mount/flushSync work (same pattern as onboarding-setup.test.ts).
vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import Widget from '../../src/components/Widget.svelte';
import {
  WIDGET_ROW_TIMEOUT_MS,
  addItem,
  bannerToStackItem,
  emptyWidgetStack,
  expireItems,
  setOccluded,
  type WidgetStackItem,
} from '../../src/stores/widgetNotifications';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);

const widgetSource = readFileSync(root('src/components/Widget.svelte'), 'utf8');
const storeSource = readFileSync(root('src/stores/widgetNotifications.ts'), 'utf8');
const widgetRs = readFileSync(root('src-tauri/src/commands/widget.rs'), 'utf8');
const bannerRs = readFileSync(root('src-tauri/src/commands/banner.rs'), 'utf8');
const dmNotifyRs = readFileSync(root('src-tauri/src/commands/dm_notify.rs'), 'utf8');
const shareNotifyRs = readFileSync(root('src-tauri/src/commands/share_notify.rs'), 'utf8');
const meetingsRs = readFileSync(root('src-tauri/src/commands/meetings.rs'), 'utf8');
const updaterRs = readFileSync(root('src-tauri/src/updater.rs'), 'utf8');
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
});

describe('US-003: Notification takeover with queue-on-occlusion', () => {
  // ── 1. Takeover: no native banner; one-line row by the widget ─────────────

  describe('Given widget mode is on, when a notification arrives, then no native banner appears and a one-line row shows by the widget', () => {
    it('source contract: show_banner routes to show_widget_notification when takeover_active before any window build', () => {
      // takeover check + early return must appear before dm-banner window work
      const takeoverIdx = bannerRs.indexOf('takeover_active');
      const showWidgetIdx = bannerRs.indexOf('show_widget_notification');
      const windowBuildIdx = bannerRs.indexOf('get_webview_window(WINDOW_LABEL)');
      const setPositionIdx = bannerRs.indexOf('set_position');

      expect(takeoverIdx).toBeGreaterThan(-1);
      expect(showWidgetIdx).toBeGreaterThan(takeoverIdx);
      // Early return to widget happens before any banner window reuse/build
      expect(windowBuildIdx).toBeGreaterThan(showWidgetIdx);
      expect(setPositionIdx).toBeGreaterThan(showWidgetIdx);

      // Explicit early-return path
      expect(bannerRs).toMatch(
        /if\s+crate::commands::widget::takeover_active\(&app\)\s*\{[\s\S]*?return\s+crate::commands::widget::show_widget_notification/,
      );
    });

    it('source contract: native notify gates include takeover_active alongside custom_banner_enabled', () => {
      const gate =
        /custom_banner_enabled\(\)\s*\|\|\s*crate::commands::widget::takeover_active/;

      expect(dmNotifyRs).toMatch(gate);
      expect(shareNotifyRs).toMatch(gate);
      expect(meetingsRs).toMatch(gate);
      // updater has two call sites (download + install prompts)
      expect(updaterRs).toMatch(gate);
      expect((updaterRs.match(new RegExp(gate.source, 'g')) ?? []).length).toBeGreaterThanOrEqual(
        2,
      );
    });

    it('behavioral: Widget mounts seeded rows as one-line NotificationRows in the frost stack, newest first', () => {
      const now = 50_000;
      const older = bannerToStackItem(
        {
          kind: 'share',
          title: 'Yousuf',
          body: 'q2.xlsx',
          clickActionId: 'open',
          data: null,
        },
        now - 1000,
        'older',
      );
      const newer = bannerToStackItem(
        {
          kind: 'dm',
          title: 'Corey',
          body: 'ship it',
          clickActionId: 'open',
          data: { id: 1 },
        },
        now,
        'newer',
      );
      // Seed already newest-on-top (store prepends; tests pass visible order)
      mountWidget({ initialItems: [newer, older] });

      const stack = host.querySelector('[data-testid="widget-stack"]');
      expect(stack).toBeTruthy();

      const frostRows = stack!.querySelectorAll('.frost');
      expect(frostRows.length).toBe(2);
      // Newest first in DOM
      expect(frostRows[0]?.getAttribute('data-kind')).toBe('dm');
      expect(frostRows[1]?.getAttribute('data-kind')).toBe('share');

      const rows = stack!.querySelectorAll('[data-testid="notification-row"]');
      expect(rows.length).toBe(2);
      expect(rows[0]?.getAttribute('data-type')).toBe('message');
      expect(rows[1]?.getAttribute('data-type')).toBe('share');
      // Collapsed one-line (not expanded)
      expect(rows[0]?.getAttribute('data-expanded')).toBe('false');
      expect(rows[1]?.getAttribute('data-expanded')).toBe('false');

      // Frost wrapper present around each NotificationRow
      expect(frostRows[0]?.querySelector('[data-testid="notification-row"]')).toBeTruthy();
      expect(widgetSource).toMatch(/\.frost\s*\{/);
      expect(widgetSource).toMatch(/backdrop-filter:\s*blur/);
    });
  });

  // ── 2. Queue-on-occlusion ─────────────────────────────────────────────────

  describe('Given a fullscreen app is frontmost, when notifications arrive, then nothing shows until fullscreen exits, at which point queued rows display', () => {
    it('behavioral (pure store): addItem while occluded queues; setOccluded(false) flushes newest-on-top with refreshed expiresAt', () => {
      let state = setOccluded(emptyWidgetStack(), true, 0);
      const a = stackItem({ id: 'a', text: 'first' }, 1_000);
      const b = stackItem({ id: 'b', text: 'second' }, 2_000);
      state = addItem(state, a);
      state = addItem(state, b);

      expect(state.visible).toEqual([]);
      expect(state.queued.map((q) => q.id)).toEqual(['b', 'a']);
      expect(state.occluded).toBe(true);

      const now = 20_000;
      state = setOccluded(state, false, now);

      expect(state.occluded).toBe(false);
      expect(state.queued).toEqual([]);
      expect(state.visible.map((v) => v.id)).toEqual(['b', 'a']);
      expect(state.visible.every((v) => v.expiresAt === now + WIDGET_ROW_TIMEOUT_MS)).toBe(
        true,
      );
    });

    it('behavioral (pure store): no native fallback path in the store; expireItems drops after WIDGET_ROW_TIMEOUT_MS', () => {
      // Source contract: pure store never mentions native / UN / mac_notification
      expect(storeSource).not.toMatch(/mac_notification/i);
      expect(storeSource).not.toMatch(/UNUserNotification/i);
      expect(storeSource).not.toMatch(/native/i);
      expect(storeSource).not.toMatch(/show_banner|banner_action/);

      const now = 5_000;
      let state = emptyWidgetStack();
      state = addItem(
        state,
        stackItem({ id: 'x', expiresAt: now + WIDGET_ROW_TIMEOUT_MS }, now),
      );
      expect(state.visible).toHaveLength(1);

      // Still within window
      expect(expireItems(state, now + WIDGET_ROW_TIMEOUT_MS - 1).visible).toHaveLength(1);
      // Past timeout → auto-collapse
      const expired = expireItems(state, now + WIDGET_ROW_TIMEOUT_MS + 1);
      expect(expired.visible).toEqual([]);
    });

    it('behavioral + source: queued count shows as plain superscript numeral when items are queued', () => {
      // Seed via prop (Widget falls back to queued prop when stack.queued is empty)
      mountWidget({ queued: 2 });

      const qd = host.querySelector('.qd');
      expect(qd).toBeTruthy();
      expect(qd?.textContent).toBe('2');

      // Plain numeral — no chip chrome (US-002 also covers style; keep minimal)
      const qdBlock = widgetSource.match(/\.qd\s*\{[^}]+\}/s)?.[0] ?? '';
      expect(qdBlock).toBeTruthy();
      expect(qdBlock).not.toMatch(/background\s*:/);
      expect(qdBlock).not.toMatch(/border\s*:/);
      expect(qdBlock).not.toMatch(/border-radius/);
    });
  });

  // ── 3. Widget mode off → native path restored ─────────────────────────────

  describe('Given widget mode is toggled off, when the next notification arrives, then it is delivered as a native macOS notification', () => {
    it('source contract: takeover_active reads widget_enabled() (fresh menubar.json) so disable restores native path', () => {
      // Doc + impl: fresh widget_enabled() each call
      expect(widgetRs).toMatch(/pub fn takeover_active/);
      expect(widgetRs).toMatch(
        /pub fn takeover_active\(app: &AppHandle\)\s*->\s*bool\s*\{\s*widget_enabled\(\)/s,
      );
      expect(widgetRs).toMatch(/widget_enabled\(\)\s*&&\s*app\.get_webview_window/);
      // Fresh-read documented intent
      expect(widgetRs).toMatch(/FRESH each call|instantly restores native/i);
      expect(widgetRs).toMatch(/fn widget_enabled\(\)\s*->\s*bool/);
      expect(widgetRs).toMatch(/widgetEnabled/);
    });

    it('source contract: occlusion observer + widget_ready + resize_widget wired; Widget listens and invokes ready', () => {
      // Rust: NSWindowDidChangeOcclusionStateNotification → widget:occlusion
      expect(widgetRs).toContain('NSWindowDidChangeOcclusionStateNotification');
      expect(widgetRs).toContain('widget:occlusion');
      expect(widgetRs).toMatch(/fn register_occlusion_observer/);

      // Commands exist and are registered
      expect(widgetRs).toMatch(/pub async fn widget_ready/);
      expect(widgetRs).toMatch(/pub async fn resize_widget/);
      expect(mainRs).toContain('commands::widget::widget_ready');
      expect(mainRs).toContain('commands::widget::resize_widget');

      // Frontend: listen for both events + invoke widget_ready
      expect(widgetSource).toContain("listen<BannerPayloadLike>('widget:notification'");
      expect(widgetSource).toContain("listen<{ visible: boolean }>('widget:occlusion'");
      expect(widgetSource).toContain("invoke('widget_ready')");
    });

    it('source contract: widget.rs buffers when webview not ready and widget_ready drains pending', () => {
      // Stack channel: (ready, pending) + FIFO buffer helper
      expect(widgetRs).toMatch(/WIDGET_STACK_CHANNEL/);
      expect(widgetRs).toMatch(/route_widget_notification/);
      expect(widgetRs).toMatch(/WIDGET_PENDING_CAP/);
      expect(widgetRs).toMatch(/takeover: buffered \(webview not ready yet\)/);

      // show_widget_notification buffers when not ready
      const showIdx = widgetRs.indexOf('pub async fn show_widget_notification');
      const bufferLogIdx = widgetRs.indexOf('takeover: buffered (webview not ready yet)');
      expect(showIdx).toBeGreaterThan(-1);
      expect(bufferLogIdx).toBeGreaterThan(showIdx);

      // widget_ready sets ready=true, then drains pending (FIFO widget:notification)
      expect(widgetRs).toMatch(/widget_ready: drained/);
      const readyFnIdx = widgetRs.indexOf('pub async fn widget_ready');
      const readyTrueIdx = widgetRs.indexOf('guard.0 = true', readyFnIdx);
      const drainLogIdx = widgetRs.indexOf('widget_ready: drained', readyFnIdx);
      const setupIdx = widgetRs.indexOf('// ── Setup', readyFnIdx);
      const readySlice = widgetRs.slice(
        readyFnIdx,
        setupIdx > readyFnIdx ? setupIdx : undefined,
      );
      expect(readyTrueIdx).toBeGreaterThan(readyFnIdx);
      expect(drainLogIdx).toBeGreaterThan(readyTrueIdx);
      expect(readySlice).toContain('widget:notification');
      expect(readySlice).toMatch(/std::mem::take\(&mut guard\.1\)/);

      // setup_widget_window resets ready=false when creating a new window (keeps pending)
      expect(widgetRs).toMatch(/ch\.0\s*=\s*false/);
      expect(widgetRs).toMatch(/keep.*pending|keep ch\.1/i);
    });

    it('source contract: Widget.svelte wires onreply/onreact→send_dm for dm rows', () => {
      expect(widgetSource).toMatch(/async function replyDm/);
      expect(widgetSource).toMatch(/async function reactDm/);
      expect(widgetSource).toContain("invoke('send_dm'");
      expect(widgetSource).toMatch(/toPersonUid:\s*peer/);
      expect(widgetSource).toMatch(/fromPersonUid/);
      // Wired only for dm rows on NotificationRow
      expect(widgetSource).toMatch(
        /onreply=\{item\.kind\s*===\s*['"]dm['"]\s*\?[\s\S]*?replyDm/,
      );
      expect(widgetSource).toMatch(
        /onreact=\{item\.kind\s*===\s*['"]dm['"]\s*\?[\s\S]*?reactDm/,
      );
    });
  });
});
