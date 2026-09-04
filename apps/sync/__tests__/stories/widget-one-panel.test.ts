// @vitest-environment happy-dom
//
// One panel: the HQ mark toggles the Messages popover. Meeting needs-action
// rows live in Activity. The live stack is a short-lived toast, never a
// second persistent window.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import Widget from '../../src/components/Widget.svelte';
import {
  WIDGET_RECENT_STORAGE_KEY,
  WIDGET_STACK_HIDDEN_STORAGE_KEY,
  bannerToStackItem,
  type WidgetStackItem,
  WIDGET_ROW_TIMEOUT_MS,
} from '../../src/stores/widgetNotifications';

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

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

function needsActionItem(now = 1_000): WidgetStackItem {
  return bannerToStackItem(
    {
      kind: 'meeting',
      title: 'Weekly sync',
      body: '"Weekly sync" isn\'t filed to a company yet.',
      clickActionId: 'assign',
      actionId: 'assign',
      actionLabel: 'Assign',
      data: { meetingId: 'bot_1', meetingTitle: 'Weekly sync' },
    },
    now,
    'wn-1',
  );
}

function mountWidget(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(Widget, { target: host, props });
  flushSync();
  return host;
}

function clickMark(): void {
  host.querySelector('.wm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
}

beforeEach(() => {
  try {
    globalThis.localStorage?.removeItem(WIDGET_RECENT_STORAGE_KEY);
    globalThis.localStorage?.removeItem(WIDGET_STACK_HIDDEN_STORAGE_KEY);
  } catch {
    // Node runtimes without a configured localStorage file expose a throwing shim.
  }
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);

describe('one widget panel — HQ mark toggles Messages', () => {
  it('three clicks toggle the Messages panel open, closed, open and never restore the toast', () => {
    mountWidget({
      initialItems: [needsActionItem(Date.now())],
    });
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();

    clickMark();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();

    clickMark();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();

    clickMark();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
  });

  it('Escape closes the Messages panel', () => {
    mountWidget({
      initialItems: [stackItem({ id: 'a', text: 'row' }, Date.now())],
    });
    clickMark();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
  });

  it('clicking outside closes the Messages panel', () => {
    mountWidget({
      initialItems: [stackItem({ id: 'a', text: 'row' }, Date.now())],
    });
    clickMark();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
  });

  it('a new needs-action item toasts, auto-hides, and remains in Activity', () => {
    vi.useFakeTimers();
    const now = Date.now();
    mountWidget({
      initialItems: [needsActionItem(now)],
      autoHideSeconds: 1,
    });

    const toast = host.querySelector('[data-testid="widget-stack"]');
    expect(toast).toBeTruthy();
    expect(toast?.textContent).toContain('Weekly sync');
    expect(toast?.querySelector('[data-testid="notification-resolve-trigger"]')?.textContent?.trim()).toBe(
      'File to company',
    );

    vi.advanceTimersByTime(WIDGET_ROW_TIMEOUT_MS + 2000);
    flushSync();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();

    clickMark();
    const list = host.querySelector('[data-testid="widget-hover-list"]');
    expect(list).toBeTruthy();
    expect(list?.textContent).toContain('Activity');
    expect(list?.textContent).toContain('Weekly sync');
    expect(
      list?.querySelector('[data-testid="notification-resolve-trigger"]')?.textContent?.trim(),
    ).toBe('File to company');
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
  });

  it('widget-off and missing stack-window contracts stay pinned', () => {
    const widgetUi = readFileSync(root('src/components/Widget.svelte'), 'utf8');
    const widgetRs = readFileSync(root('src-tauri/src/commands/widget.rs'), 'utf8');
    const mainTs = readFileSync(root('src/main.ts'), 'utf8');
    const capabilities = readFileSync(root('src-tauri/capabilities/widget.json'), 'utf8');
    const settings = readFileSync(root('src/components/WidgetSettings.svelte'), 'utf8');

    expect(widgetRs).toContain('pub const WINDOW_LABEL: &str = "widget"');
    expect(widgetRs).toContain('There is no separate `widget-stack` window.');
    expect(widgetRs).not.toMatch(/"widget-stack"/);
    expect(widgetRs).toContain('apply_widget_settings: disabled — window closed');
    expect(capabilities).toContain('"windows": ["widget"]');
    expect(capabilities).not.toContain('widget-stack');
    expect(mainTs).toMatch(/windowLabel === 'widget'/);
    expect(mainTs).not.toMatch(/windowLabel === 'widget-stack'/);
    expect(widgetUi).toContain('function togglePinned');
    expect(widgetUi).toContain('clearLiveOverlay');
    expect(widgetUi).toContain('liveOverlay: !hoverOpen && !pinned');
    expect(widgetUi).toContain('widgetBadgeCount');
    expect(settings).toContain('data-testid="widget-toggle"');
    expect(settings).toContain('Off hides both');
  });
});
