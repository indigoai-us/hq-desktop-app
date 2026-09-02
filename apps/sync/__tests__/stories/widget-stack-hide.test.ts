// @vitest-environment happy-dom
//
// Stack dismiss: Esc / hide control, unfocused auto-hide of needs-action rows,
// and persisted hidden so wake cannot pin the overlay again.

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

describe('widget stack hide / Esc / unfocused auto-hide', () => {
  it('hides the live stack on the hide control', () => {
    mountWidget({
      initialItems: [stackItem({ id: 'a', text: 'hello' })],
    });
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();
    const hide = host.querySelector<HTMLButtonElement>('[data-testid="widget-stack-hide"]');
    expect(hide).toBeTruthy();
    hide!.click();
    flushSync();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    try {
      expect(localStorage.getItem(WIDGET_STACK_HIDDEN_STORAGE_KEY)).toBe('1');
    } catch {
      // Node without --localstorage-file exposes a throwing shim.
    }
  });

  it('hides the live stack on Escape', () => {
    mountWidget({
      initialItems: [stackItem({ id: 'a', text: 'hello' })],
    });
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
  });

  it('needs-action rows do not keep the window shown when unfocused after the auto-hide delay', () => {
    vi.useFakeTimers();
    mountWidget({
      initialItems: [needsActionItem(Date.now())],
      appFocused: false,
      autoHideSeconds: 1,
    });
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();
    vi.advanceTimersByTime(1000);
    flushSync();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
  });

  it('keeps needs-action rows visible while the app is focused', () => {
    vi.useFakeTimers();
    mountWidget({
      initialItems: [needsActionItem(Date.now())],
      appFocused: true,
      autoHideSeconds: 1,
    });
    vi.advanceTimersByTime(2000);
    flushSync();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();
  });

  it('source contract: Esc, hide control, tray Hide notifications, and unfocused auto-hide are wired', () => {
    const widgetUi = readFileSync(root('src/components/Widget.svelte'), 'utf8');
    const widgetRs = readFileSync(root('src-tauri/src/commands/widget.rs'), 'utf8');
    const trayRs = readFileSync(root('src-tauri/src/tray.rs'), 'utf8');
    const helper = readFileSync(
      root('src-tauri/helper/hq-tray-helper.swift'),
      'utf8',
    );
    expect(widgetUi).toContain('data-testid="widget-stack-hide"');
    expect(widgetUi).toContain('handleGlobalEscape');
    expect(widgetUi).toContain("listen('widget:hide'");
    expect(widgetUi).toContain("listen('widget:escape'");
    expect(widgetUi).toContain('stackAutoHideDue');
    expect(widgetRs).toContain('hide_widget_stack_now');
    expect(widgetRs).toContain('widget:app-active');
    expect(trayRs).toContain('Hide notifications');
    expect(helper).toContain('Hide notifications');
    expect(helper).toContain('widget-peek');
  });
});
