// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { flushSync, mount, unmount } from 'svelte';
import Widget from '../../src/components/Widget.svelte';
import { WIDGET_RECENT_STORAGE_KEY } from '../../src/stores/widgetNotifications';

type BannerPayload = {
  kind: string;
  title: string;
  body: string;
  clickActionId: string;
  data: unknown;
  actionId?: string | null;
  actionLabel?: string | null;
};

type Listener = (event: { payload: unknown }) => void;

type NotificationHistory = {
  dms: Array<Record<string, unknown>>;
  shares: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
};

type PendingUpdateWire =
  | { status: 'unchecked' }
  | { status: 'absent' }
  | {
      status: 'pending';
      update: {
        version: string;
        body?: string;
        date?: string;
        detectedAt?: string;
      };
    };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const originalGlobalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'localStorage',
);

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let listeners: Map<string, Listener>;
let unlisteners: Map<string, ReturnType<typeof vi.fn>>;
let history: NotificationHistory;
let pendingUpdate: {
  version: string;
  body?: string;
  date?: string;
  detectedAt?: string;
} | null;
let failedCommands: Set<string>;
let designSystemStyle: HTMLStyleElement;
let popoverStyle: HTMLStyleElement;
let widgetMaterialStyle: HTMLStyleElement;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

function installLocalStorage(): void {
  const storage = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  });
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  });
}

function installTauriWindow(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: {
      invoke: (command: string, args?: Record<string, unknown>) =>
        tauri.invoke(command, args),
    },
  });
}

function defaultInvoke(command: string, args?: Record<string, unknown>): unknown {
  if (failedCommands.has(command)) {
    throw new Error(`${command} unavailable`);
  }
  if (command === 'fetch_notification_history') return history;
  if (command === 'get_activity_log') return [];
  if (command === 'get_pending_update') return pendingUpdate;
  if (command === 'list_channels') return { channels: [] };
  if (command === 'meetings_list_memberships') {
    return [
      { companyUid: 'cmp_indigo', companyName: 'Indigo', status: 'active' },
      { companyUid: 'cmp_alive', companyName: 'Alive', status: 'active' },
    ];
  }
  if (command === 'meetings_set_company') {
    return {
      ok: true,
      meetingId: args?.meetingId ?? 'bot_1',
      companyId: args?.companyId ?? 'cmp_indigo',
    };
  }
  if (command === 'open_meetings_window') return null;
  return undefined;
}

function mountWidget(): HTMLElement {
  component = mount(Widget, { target: host });
  flushSync();
  return host;
}

async function waitForNativeReady(): Promise<void> {
  await vi.waitFor(() => {
    expect([...listeners.keys()].sort()).toEqual(
      [
        'channel:new-message',
        'channel:updated',
        'dm:unread-summary',
        'sync:complete',
        'update:available',
        'update:cleared',
        'widget:click-away',
        'widget:notification',
        'widget:occlusion',
      ].sort(),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('widget_ready');
    expect(tauri.invoke).toHaveBeenCalledWith('fetch_notification_history', {
      limit: 200,
    });
  });
  flushSync();
}

function emitNative(event: string, payload: unknown = undefined): void {
  const listener = listeners.get(event);
  expect(listener, `native listener ${event}`).toBeTypeOf('function');
  listener!({ payload });
  flushSync();
}

function notification(overrides: Partial<BannerPayload> = {}): BannerPayload {
  return {
    kind: 'update',
    title: 'HQ update',
    body: 'Ready to install',
    clickActionId: 'open',
    data: null,
    ...overrides,
  };
}

async function openVisibleNotification(payload: BannerPayload): Promise<void> {
  emitNative('widget:notification', payload);
  const row = host.querySelector<HTMLElement>(
    '[data-testid="widget-stack"] [data-testid="notification-row"]',
  );
  expect(row).toBeTruthy();
  const open = row!.querySelector<HTMLButtonElement>(
    '.nr-primary-action, .nr-open',
  );
  expect(open, `open action for ${payload.kind}`).toBeTruthy();
  open!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
  });
}

beforeEach(() => {
  designSystemStyle = document.createElement('style');
  designSystemStyle.textContent = readFileSync(
    resolve(process.cwd(), 'src/styles/design-system.css'),
    'utf8',
  );
  document.head.appendChild(designSystemStyle);
  popoverStyle = document.createElement('style');
  popoverStyle.textContent = readFileSync(
    resolve(process.cwd(), 'src/styles/popover.css'),
    'utf8',
  );
  document.head.appendChild(popoverStyle);
  widgetMaterialStyle = document.createElement('style');
  const widgetSource = readFileSync(
    resolve(process.cwd(), 'src/components/Widget.svelte'),
    'utf8',
  );
  widgetMaterialStyle.textContent =
    widgetSource
      .match(/<style>([\s\S]*?)<\/style>\s*$/)?.[1]
      ?.replace(/:global\(([^)]+)\)/g, '$1') ?? '';
  document.head.appendChild(widgetMaterialStyle);

  host = document.createElement('div');
  document.body.appendChild(host);
  listeners = new Map();
  unlisteners = new Map();
  history = { dms: [], shares: [], files: [] };
  pendingUpdate = null;
  failedCommands = new Set();
  installLocalStorage();
  installTauriWindow();

  tauri.listen.mockImplementation(
    async (event: string, callback: Listener) => {
      listeners.set(event, callback);
      const unlisten = vi.fn();
      unlisteners.set(event, unlisten);
      return unlisten;
    },
  );
  tauri.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) =>
      defaultInvoke(command, args),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host.remove();
  widgetMaterialStyle.remove();
  popoverStyle.remove();
  designSystemStyle.remove();
  delete document.documentElement.dataset.forceTheme;
  delete document.documentElement.dataset.desktopZoom;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

afterAll(() => {
  if (originalGlobalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalGlobalStorage);
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

describe('Widget restored native standalone behavior', () => {
  it.each([
    { zoom: 0.8, width: 53, height: 35 },
    { zoom: 1, width: 66, height: 43 },
    { zoom: 1.6, width: 106, height: 69 },
  ])(
    'resizes its fixed native viewport with the initial $zoom zoom',
    async ({ zoom, width, height }) => {
      document.documentElement.dataset.desktopZoom = String(zoom * 100);
      mountWidget();
      await waitForNativeReady();

      expect(tauri.invoke).toHaveBeenCalledWith('resize_widget', {
        width,
        height,
        zoom,
      });
    },
  );

  it('resizes an already-mounted widget when the global zoom changes', async () => {
    document.documentElement.dataset.desktopZoom = '100';
    mountWidget();
    await waitForNativeReady();
    tauri.invoke.mockClear();

    window.dispatchEvent(
      new CustomEvent('hq:desktop-zoom-change', {
        detail: { zoom: 1.6 },
      }),
    );

    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('resize_widget', {
        width: 106,
        height: 69,
        zoom: 1.6,
      });
    });
  });

  it.each([
    {
      theme: 'light',
      page: '#eeeeee',
      popDivider: 'rgba(0,0,0,0.08)',
      popIcon: 'rgba(0,0,0,0.5)',
      rowBg:
        'rgb(245 245 245 / clamp(0.82, calc(1 - 0.65 * 0.277), 1))',
      rowFg: '#171717',
      replyBg: 'rgba(0, 0, 0, 0.07)',
      qdFg: '#333333',
      danger: '#dc2626',
      segment: '#ffffff',
      menu: 'rgba(255, 255, 255, 0.9)',
      glyph: '#e5484d',
      switchOn: '#34c759',
    },
    {
      theme: 'dark',
      page: '#101010',
      popDivider: 'rgba(255,255,255,0.1)',
      popIcon: 'rgba(255,255,255,0.55)',
      rowBg:
        'rgb(24 24 24 / clamp(0.78, calc(1 - 0.65 * 0.338), 1))',
      rowFg: '#fff',
      replyBg: 'rgba(255, 255, 255, 0.12)',
      qdFg: '#d4d4d4',
      danger: '#ef4444',
      segment: 'rgba(120, 120, 120, 0.5)',
      menu: 'rgba(66, 66, 66, 0.94)',
      glyph: '#ff453a',
      switchOn: '#30d158',
    },
  ])(
    'forces the complete shared and populated widget material token set in $theme mode',
    async ({
      theme,
      page,
      popDivider,
      popIcon,
      rowBg,
      rowFg,
      replyBg,
      qdFg,
      danger,
      segment,
      menu,
      glyph,
      switchOn,
    }) => {
      document.documentElement.dataset.forceTheme = theme;
      mountWidget();
      await waitForNativeReady();
      emitNative('widget:notification', notification());

      const wordmark = host.querySelector<HTMLElement>('.wm')!;
      wordmark.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      flushSync();

      const rootStyle = getComputedStyle(document.documentElement);
      const widgetStyle = getComputedStyle(host.querySelector<HTMLElement>('.wg')!);
      const muted = rootStyle.getPropertyValue('--pop-muted').trim();
      expect(rootStyle.getPropertyValue('--page-bg').trim()).toBe(page);
      expect(rootStyle.getPropertyValue('--pop-divider').trim()).toBe(popDivider);
      expect(rootStyle.getPropertyValue('--pop-icon').trim()).toBe(popIcon);
      expect(rootStyle.getPropertyValue('--popover-danger').trim()).toBe(danger);
      expect(rootStyle.getPropertyValue('--popover-status-busy').trim()).toBe(muted);
      expect(rootStyle.getPropertyValue('--popover-status-paused').trim()).toBe(muted);
      expect(rootStyle.getPropertyValue('--seg-sel').trim()).toBe(segment);
      expect(rootStyle.getPropertyValue('--menu-bg').trim()).toBe(menu);
      expect(rootStyle.getPropertyValue('--glyph-alert-fg').trim()).toBe(glyph);
      expect(rootStyle.getPropertyValue('--switch-on').trim()).toBe(switchOn);
      expect(widgetStyle.getPropertyValue('--row-bg').trim()).toBe(rowBg);
      expect(widgetStyle.getPropertyValue('--row-fg').trim()).toBe(rowFg);
      expect(widgetStyle.getPropertyValue('--reply-bg').trim()).toBe(replyBg);
      expect(widgetStyle.getPropertyValue('--qd-fg').trim()).toBe(qdFg);
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeTruthy();
    },
  );

  it('handshakes with the native window, queues while occluded, flushes visibly, and cleans up', async () => {
    mountWidget();
    await waitForNativeReady();

    emitNative('widget:occlusion', { visible: false });
    emitNative(
      'widget:notification',
      notification({
        kind: 'share',
        title: 'Maya',
        body: 'Shared launch-plan.md',
        data: { eventId: 'share-1' },
      }),
    );

    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="widget-unread-badge"]')?.textContent,
    ).toBe('1');

    emitNative('widget:occlusion', { visible: true });
    const stack = host.querySelector('[data-testid="widget-stack"]');
    expect(stack).toBeTruthy();
    expect(stack?.textContent).toContain('Shared launch-plan.md');

    stack
      ?.querySelector<HTMLButtonElement>('.nr-dismiss')
      ?.click();
    flushSync();
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();

    await unmount(component!);
    component = null;
    expect([...unlisteners.values()]).toHaveLength(9);
    for (const unlisten of unlisteners.values()) {
      expect(unlisten).toHaveBeenCalledOnce();
    }
  });

  it('supports keyboard pinning and native click-away, plus Escape for the context menu', async () => {
    mountWidget();
    await waitForNativeReady();
    emitNative('widget:notification', notification());

    const wordmark = host.querySelector<HTMLElement>('.wm')!;
    wordmark.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    flushSync();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();

    emitNative('widget:click-away');
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();

    wordmark.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeTruthy();

    wordmark.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    flushSync();
    expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeNull();
  });

  it('opens the mini communications window and full desktop from the native context menu', async () => {
    mountWidget();
    await waitForNativeReady();
    const wordmark = host.querySelector<HTMLElement>('.wm')!;

    wordmark.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    flushSync();
    host
      .querySelector<HTMLButtonElement>('[data-testid="widget-menu-inbox"]')!
      .click();
    await vi.waitFor(() => {
      expect(
        tauri.invoke.mock.calls.some(
          ([command]) => command === 'open_communications_window',
        ),
      ).toBe(true);
    });
    expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeNull();

    wordmark.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    flushSync();
    host
      .querySelector<HTMLButtonElement>('[data-testid="widget-menu-desktop"]')!
      .click();
    await vi.waitFor(() => {
      expect(
        tauri.invoke.mock.calls.some(
          ([command]) => command === 'open_desktop_alt_window',
        ),
      ).toBe(true);
    });
    expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeNull();
  });

  it('falls back to the main window when the desktop window cannot open', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failedCommands.add('open_desktop_alt_window');
    mountWidget();
    await waitForNativeReady();

    const wordmark = host.querySelector<HTMLElement>('.wm')!;
    wordmark.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    flushSync();
    host
      .querySelector<HTMLButtonElement>('[data-testid="widget-menu-desktop"]')!
      .click();

    await vi.waitFor(() => {
      expect(
        tauri.invoke.mock.calls.some(([command]) => command === 'show_main_window'),
      ).toBe(true);
    });
    expect(consoleError).toHaveBeenCalledWith(
      'widget: open_desktop_alt_window failed',
      expect.any(Error),
    );
  });

  it('routes every visible Open action to its restored destination', async () => {
    mountWidget();
    await waitForNativeReady();

    const dm = { eventId: 'dm-1', fromPersonUid: 'person-1' };
    await openVisibleNotification(
      notification({
        kind: 'dm',
        title: 'Maya',
        body: 'Can you review this?',
        data: dm,
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('open_dm_detail', { event: dm });

    const share = { eventId: 'share-1', paths: ['launch-plan.md'] };
    await openVisibleNotification(
      notification({
        kind: 'share',
        title: 'Maya',
        body: 'Shared launch-plan.md',
        data: share,
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('open_share_detail', {
      events: [share],
    });

    const channel = {
      channelId: 'channel-design',
      name: 'design',
      scope: 'company',
      companyUid: 'company-indigo',
      companyName: 'Indigo',
      membership: 'joined',
      unread: 3,
    };
    tauri.invoke.mockClear();
    await openVisibleNotification(
      notification({
        kind: 'channel',
        title: '#design',
        body: '3 unread · Indigo',
        clickActionId: 'open-channel',
        data: channel,
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('open_communications_window', {
      channel,
    });

    tauri.invoke.mockClear();
    await openVisibleNotification(
      notification({
        kind: 'new-file',
        title: 'Indigo',
        body: 'roadmap.md',
        data: { company: 'indigo', path: 'roadmap.md' },
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('open_desktop_alt_window', {
      route: 'company:indigo:activity',
    });

    await openVisibleNotification(
      notification({
        kind: 'new-file',
        title: 'Sync',
        body: 'roadmap.md',
        data: null,
      }),
    );
    expect(
      tauri.invoke.mock.calls.some(
        ([command]) => command === 'open_communications_window',
      ),
    ).toBe(true);

    tauri.invoke.mockClear();
    await openVisibleNotification(
      notification({
        kind: 'update',
        title: 'HQ 0.10.34',
        body: 'Ready',
        clickActionId: 'open',
        actionId: 'update',
        actionLabel: 'Update now',
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('open_desktop_alt_window', {
      route: 'settings:updates',
    });

    emitNative(
      'widget:notification',
      notification({
        kind: 'update',
        title: 'HQ 0.10.34',
        body: 'Ready',
        clickActionId: 'open',
        actionId: 'update',
        actionLabel: 'Update now',
      }),
    );
    const updateAction = host.querySelector<HTMLButtonElement>(
      '[data-testid="widget-stack"] .nr-open',
    );
    expect(updateAction?.textContent?.trim()).toBe('Update now');
    updateAction!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    });
    expect(tauri.invoke).toHaveBeenCalledWith(
      'banner_action',
      expect.objectContaining({
        action: 'update',
        payload: expect.objectContaining({
          kind: 'update',
          clickActionId: 'open',
        }),
      }),
    );

    tauri.invoke.mockClear();
    await openVisibleNotification(
      notification({
        kind: 'update',
        title: 'HQ 0.10.34',
        body: 'Release notes',
        clickActionId: 'open',
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('open_desktop_alt_window', {
      route: 'settings:updates',
    });

    tauri.invoke.mockClear();
    await openVisibleNotification(
      notification({
        kind: 'meeting',
        title: 'Standup',
        body: 'Starting now',
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('open_meetings_window', {
      focusMeetingId: null,
    });
    expect(
      tauri.invoke.mock.calls.some(([command]) => command === 'show_main_window'),
    ).toBe(false);

    await openVisibleNotification(
      notification({
        kind: 'system',
        title: 'Review requested',
        body: 'Open request',
        clickActionId: 'review',
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith(
      'banner_action',
      expect.objectContaining({ action: 'review' }),
    );

    await openVisibleNotification(
      notification({
        kind: 'system',
        title: 'FYI',
        body: 'Display-only notice',
        clickActionId: '',
      }),
    );
    expect(
      tauri.invoke.mock.calls.some(
        ([command]) => command === 'open_communications_window',
      ),
    ).toBe(true);
  });

  it('routes an explicit click action before the notification kind fallback', async () => {
    mountWidget();
    await waitForNativeReady();

    await openVisibleNotification(
      notification({
        kind: 'meeting',
        title: 'Meeting needs a company',
        body: 'Assign it so the transcript files correctly.',
        clickActionId: 'assign',
        actionId: 'assign',
        actionLabel: 'Assign',
        data: { meetingId: 'meeting-1', calendarEventId: 'evt-1' },
      }),
    );

    expect(tauri.invoke).toHaveBeenCalledWith('open_meetings_window', {
      focusMeetingId: 'evt-1',
    });
    expect(
      tauri.invoke.mock.calls.some(([command]) => command === 'banner_action'),
    ).toBe(false);
    expect(
      tauri.invoke.mock.calls.some(([command]) => command === 'show_main_window'),
    ).toBe(false);

    tauri.invoke.mockClear();
    await openVisibleNotification(
      notification({
        kind: 'share',
        title: 'Couldn’t open Claude',
        body: 'The shared item is still available.',
        clickActionId: 'claude',
        actionId: 'claude',
        actionLabel: 'Retry',
        data: { paths: ['launch-plan.md'] },
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith(
      'banner_action',
      expect.objectContaining({ action: 'claude' }),
    );
    expect(
      tauri.invoke.mock.calls.some(([command]) => command === 'open_share_detail'),
    ).toBe(false);
  });

  it('files a meeting to a company inline and resolves the row', async () => {
    mountWidget();
    await waitForNativeReady();
    emitNative(
      'widget:notification',
      notification({
        kind: 'meeting',
        title: 'Meeting needs a company',
        body: '"Standup" isn’t filed to a company yet.',
        clickActionId: 'assign',
        actionId: 'assign',
        data: { meetingId: 'bot_1', meetingTitle: 'Standup' },
      }),
    );

    const trigger = host.querySelector<HTMLButtonElement>(
      '[data-testid="notification-resolve-trigger"]',
    )!;
    expect(trigger.textContent?.trim()).toBe('File to company');
    trigger.click();
    flushSync();

    const select = await vi.waitFor(() => {
      const node = host.querySelector<HTMLSelectElement>(
        '[data-testid="notification-resolve-select"]',
      );
      expect(node).toBeTruthy();
      expect([...node!.options].some((option) => option.value === 'cmp_indigo')).toBe(
        true,
      );
      return node!;
    });

    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
      select,
      'cmp_indigo',
    );
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    host.querySelector<HTMLButtonElement>('[data-testid="notification-resolve-save"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(tauri.invoke).toHaveBeenCalledWith(
        'meetings_set_company',
        expect.objectContaining({
          meetingId: 'bot_1',
          companyId: 'cmp_indigo',
        }),
      );
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    });
  });

  it('keeps the meeting row and surfaces an error toast when filing fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tauri.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'meetings_set_company') {
          return { ok: false, error: 'Company is unavailable.' };
        }
        return defaultInvoke(command, args);
      },
    );
    mountWidget();
    await waitForNativeReady();
    emitNative(
      'widget:notification',
      notification({
        kind: 'meeting',
        title: 'Meeting needs a company',
        body: '"Standup" isn’t filed to a company yet.',
        clickActionId: 'assign',
        actionId: 'assign',
        data: { meetingId: 'bot_1', meetingTitle: 'Standup' },
      }),
    );

    host.querySelector<HTMLButtonElement>('[data-testid="notification-resolve-trigger"]')!.click();
    flushSync();
    const select = await vi.waitFor(() => {
      const node = host.querySelector<HTMLSelectElement>(
        '[data-testid="notification-resolve-select"]',
      );
      expect(node).toBeTruthy();
      expect([...node!.options].some((option) => option.value === 'cmp_indigo')).toBe(
        true,
      );
      return node!;
    });
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
      select,
      'cmp_indigo',
    );
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="notification-resolve-save"]')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="widget-filing-error"]')?.textContent).toContain(
        'Company is unavailable',
      );
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();
      expect(
        host.querySelector('[data-testid="notification-resolve-error"]')?.textContent,
      ).toContain('Couldn’t save');
    });
    consoleError.mockRestore();
  });

  it('neutralizes a successful one-shot action in the mini panel', async () => {
    mountWidget();
    await waitForNativeReady();
    emitNative(
      'widget:notification',
      notification({
        kind: 'update',
        title: 'HQ 0.10.36',
        body: 'Ready to install',
        clickActionId: 'open',
        actionId: 'update',
        actionLabel: 'Update now',
        data: { version: '0.10.36' },
      }),
    );

    host.querySelector<HTMLElement>('.wm')!.click();
    flushSync();
    const list = host.querySelector<HTMLElement>(
      '[data-testid="widget-hover-list"]',
    )!;
    const oneShotAction = [...list.querySelectorAll<HTMLButtonElement>('.nr-open')]
      .find((button) => button.textContent?.trim() === 'Update now');
    expect(oneShotAction).toBeTruthy();
    oneShotAction!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(
        tauri.invoke.mock.calls.filter(([command]) => command === 'banner_action'),
      ).toHaveLength(1);
      const actionAfter = [...list.querySelectorAll<HTMLButtonElement>('.nr-open')]
        .map((button) => button.textContent?.trim());
      expect(actionAfter).not.toContain('Update now');
      expect(actionAfter).toContain('Open');
    });

    const retainedRow = list.querySelector<HTMLElement>(
      '[data-testid="notification-row"]',
    )!;
    const open = [...retainedRow.querySelectorAll<HTMLButtonElement>('.nr-open')]
      .find((button) => button.textContent?.trim() === 'Open');
    expect(open).toBeTruthy();
    open!.click();

    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('open_desktop_alt_window', {
        route: 'settings:updates',
      });
    });
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'banner_action'),
    ).toHaveLength(1);
  });

  it('retains a failed open with accessible retry and dismisses only after success', async () => {
    failedCommands.add('open_communications_window');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mountWidget();
    await waitForNativeReady();

    emitNative(
      'widget:notification',
      notification({
        kind: 'system',
        title: 'Needs attention',
        body: 'Open the communications window',
        clickActionId: '',
      }),
    );
    const row = host.querySelector<HTMLElement>(
      '[data-testid="widget-stack"] [data-testid="notification-row"]',
    )!;
    row.querySelector<HTMLButtonElement>('.nr-primary-action')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(row.querySelector('.nr-action-error')?.textContent).toContain(
        'Couldn’t open this item.',
      );
    });
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();
    expect(row.querySelector('.nr-primary-action')?.getAttribute('aria-busy')).toBe(
      'false',
    );

    failedCommands.delete('open_communications_window');
    row.querySelector<HTMLButtonElement>('.nr-action-error .nr-retry')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    });
    expect(
      tauri.invoke.mock.calls.filter(
        ([command]) => command === 'open_communications_window',
      ),
    ).toHaveLength(2);

    consoleError.mockRestore();
  });

  it('retains a failed custom action and retries it with a fresh request id', async () => {
    failedCommands.add('banner_action');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mountWidget();
    await waitForNativeReady();

    emitNative(
      'widget:notification',
      notification({
        kind: 'update',
        title: 'HQ 0.10.35',
        body: 'Ready to install',
        actionId: 'update',
        actionLabel: 'Update now',
      }),
    );
    const row = host.querySelector<HTMLElement>(
      '[data-testid="widget-stack"] [data-testid="notification-row"]',
    )!;
    row.querySelector<HTMLButtonElement>('.nr-open')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(row.querySelector('.nr-action-error')?.textContent).toContain(
        'Couldn’t complete that action.',
      );
    });
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();

    const firstRequest = (
      tauri.invoke.mock.calls.find(([command]) => command === 'banner_action')?.[1] as
        | { requestId?: string }
        | undefined
    )?.requestId;
    expect(firstRequest).toEqual(expect.any(String));

    failedCommands.delete('banner_action');
    row.querySelector<HTMLButtonElement>('.nr-action-error .nr-retry')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();
    });

    const actionCalls = tauri.invoke.mock.calls.filter(
      ([command]) => command === 'banner_action',
    );
    expect(actionCalls).toHaveLength(2);
    expect((actionCalls[1]?.[1] as { requestId?: string }).requestId).not.toBe(
      firstRequest,
    );

    consoleError.mockRestore();
  });

  it('rehydrates a persisted update from trusted pending state with separate actions', async () => {
    const detectedAt = '2026-07-27T15:00:00Z';
    pendingUpdate = {
      version: '0.10.36-beta.1',
      body: 'Inbox notification repair',
      date: '2026-07-27T14:00:00Z',
      detectedAt,
    };
    localStorage.setItem(
      WIDGET_RECENT_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'wn-restored-update',
          type: 'system',
          text: 'HQ 0.10.36-beta.1 — Ready',
          ts: Date.parse(detectedAt),
          kind: 'update',
          clickActionId: 'update',
          data: { version: 'untrusted' },
          actionId: 'update',
          actionLabel: 'Update now',
          expiresAt: 0,
          unread: true,
        },
      ]),
    );

    mountWidget();
    await waitForNativeReady();

    host
      .querySelector<HTMLElement>('.wm')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    const rows = [
      ...host.querySelectorAll<HTMLElement>(
        '[data-testid="widget-hover-list"] [data-testid="notification-row"]',
      ),
    ].filter((row) => row.textContent?.includes('0.10.36-beta.1'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.querySelector<HTMLButtonElement>('.nr-open')?.textContent?.trim()).toBe(
      'Update now',
    );

    row.querySelector<HTMLButtonElement>('.nr-primary-action')!.click();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('open_desktop_alt_window', {
        route: 'settings:updates',
      });
    });

    row.querySelector<HTMLButtonElement>('.nr-open')!.click();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        'banner_action',
        expect.objectContaining({
          action: 'update',
          payload: expect.objectContaining({
            data: expect.objectContaining({ version: '0.10.36-beta.1' }),
          }),
        }),
      );
    });
  });

  it('preserves a safe persisted update while native state is still unchecked', async () => {
    localStorage.setItem(
      WIDGET_RECENT_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'wn-persisted-update',
          type: 'system',
          actor: 'HQ',
          text: 'Version 0.10.36-beta.1 is ready to install.',
          ts: Date.parse('2026-07-27T15:00:00Z'),
          kind: 'update',
          clickActionId: 'open',
          data: null,
          expiresAt: 0,
          unread: true,
        },
      ]),
    );
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') {
        return { status: 'unchecked' } satisfies PendingUpdateWire;
      }
      return defaultInvoke(command);
    });

    mountWidget();
    await waitForNativeReady();
    host.querySelector<HTMLButtonElement>('.wm')!.click();
    flushSync();

    expect(
      host.querySelector('[data-testid="widget-hover-list"]')?.textContent,
    ).toContain('0.10.36-beta.1');
    expect(
      host
        .querySelector('[data-testid="widget-hover-list"] .nr-open')
        ?.textContent?.trim(),
    ).toBe('Open');
    expect(
      host.querySelector('[data-testid="widget-hover-list"]')?.textContent,
    ).not.toContain('Update now');
  });

  it('does not resurrect a cleared update when an older refresh resolves last', async () => {
    const older = deferred<PendingUpdateWire>();
    const newer = deferred<PendingUpdateWire>();
    let pendingCalls = 0;
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_update') {
        pendingCalls += 1;
        return pendingCalls === 1 ? older.promise : newer.promise;
      }
      return Promise.resolve(defaultInvoke(command));
    });

    mountWidget();
    await waitForNativeReady();
    vi.useFakeTimers();
    emitNative('update:cleared');
    await vi.advanceTimersByTimeAsync(300);
    expect(pendingCalls).toBe(2);

    newer.resolve({ status: 'absent' });
    await Promise.resolve();
    older.resolve({
      status: 'pending',
      update: {
        version: '0.10.99',
        detectedAt: '2026-07-27T15:00:00Z',
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    host.querySelector<HTMLButtonElement>('.wm')!.click();
    flushSync();
    expect(
      host.querySelector('[data-testid="widget-hover-list"]')?.textContent ?? '',
    ).not.toContain('0.10.99');
  });

  it('sends a trimmed DM quick reply and emoji reaction through the native bridge', async () => {
    mountWidget();
    await waitForNativeReady();
    emitNative(
      'widget:notification',
      notification({
        kind: 'dm',
        title: 'Maya',
        body: 'Ready to ship?',
        data: { eventId: 'dm-1', fromPersonUid: 'person-1' },
      }),
    );

    const row = host.querySelector<HTMLElement>(
      '[data-testid="widget-stack"] [data-testid="notification-row"]',
    )!;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();
    const input = row.querySelector<HTMLInputElement>('.nr-reply')!;
    expect(input).toBeTruthy();
    input.focus();
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith('set_widget_focusable', {
        focusable: true,
      }),
    );

    input.value = '  Ship it  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith('send_dm', {
        toPersonUid: 'person-1',
        body: 'Ship it',
      }),
    );
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith('set_widget_focusable', {
        focusable: false,
      }),
    );

    row
      .querySelector<HTMLButtonElement>('[aria-label="React with 👍"]')!
      .click();
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith('send_dm', {
        toPersonUid: 'person-1',
        body: '👍',
      }),
    );
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeTruthy();
  });

  it('keeps a failed widget quick-reply draft focusable and retries without false success', async () => {
    failedCommands.add('send_dm');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mountWidget();
    await waitForNativeReady();
    emitNative(
      'widget:notification',
      notification({
        kind: 'dm',
        title: 'Maya',
        body: 'Can you retry this?',
        data: { eventId: 'dm-failed', fromPersonUid: 'person-1' },
      }),
    );

    const row = host.querySelector<HTMLElement>(
      '[data-testid="widget-stack"] [data-testid="notification-row"]',
    )!;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();
    const input = row.querySelector<HTMLInputElement>('.nr-reply')!;
    input.focus();
    input.value = 'Do not lose me';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );

    await vi.waitFor(() => {
      flushSync();
      expect(row.querySelector('[data-testid="notification-reply-error"]')).toBeTruthy();
    });
    expect(input.value).toBe('Do not lose me');
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'set_widget_focusable' &&
          (args as { focusable?: boolean } | undefined)?.focusable === false,
      ),
    ).toBe(false);

    failedCommands.delete('send_dm');
    row
      .querySelector<HTMLButtonElement>('[data-testid="notification-reply-retry"]')!
      .click();
    await vi.waitFor(() => {
      flushSync();
      expect(input.value).toBe('');
      expect(row.querySelector('[data-testid="notification-reply-error"]')).toBeNull();
      expect(
        tauri.invoke.mock.calls.filter(([command]) => command === 'send_dm'),
      ).toHaveLength(2);
      expect(
        tauri.invoke.mock.calls.some(
          ([command, args]) =>
            command === 'set_widget_focusable' &&
            (args as { focusable?: boolean } | undefined)?.focusable === false,
        ),
      ).toBe(true);
    });

    consoleError.mockRestore();
  });

  it('keeps a draft hold active when opening its message fails', async () => {
    failedCommands.add('open_dm_detail');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mountWidget();
    await waitForNativeReady();
    emitNative(
      'widget:notification',
      notification({
        kind: 'dm',
        title: 'Maya',
        body: 'Keep this draft safe.',
        data: { eventId: 'dm-open-failed', fromPersonUid: 'person-1' },
      }),
    );

    host
      .querySelector<HTMLElement>('.wm')!
      .dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();
    const list = host.querySelector<HTMLElement>(
      '[data-testid="widget-hover-list"]',
    )!;
    const row = list.querySelector<HTMLElement>(
      '[data-testid="notification-row"]',
    )!;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();
    const input = row.querySelector<HTMLInputElement>('.nr-reply')!;
    input.focus();
    input.value = 'Unsent context';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    vi.useFakeTimers();
    row.querySelector<HTMLButtonElement>('.nr-primary-action')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(row.querySelector('.nr-action-error')?.textContent).toContain(
        'Couldn’t open this item.',
      );
    });

    host
      .querySelector<HTMLElement>('.wg')!
      .dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);
    flushSync();

    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeTruthy();
    expect(
      host.querySelector<HTMLInputElement>(
        '[data-testid="widget-hover-list"] input.nr-reply',
      )?.value,
    ).toBe('Unsent context');

    consoleError.mockRestore();
  });

  it('hydrates retained notification history into the mini inbox', async () => {
    history = {
      dms: [
        {
          eventId: 'dm-history-1',
          fromPersonUid: 'person-1',
          fromDisplayName: 'Maya',
          fromEmail: 'maya@example.com',
          body: 'History survived restart',
          createdAt: new Date().toISOString(),
        },
      ],
      shares: [],
      files: [],
    };
    mountWidget();
    await waitForNativeReady();
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="widget-unread-badge"]')?.textContent,
      ).toBe('1');
    });
    expect(host.querySelector('[data-testid="widget-stack"]')).toBeNull();

    host.querySelector<HTMLButtonElement>('.wm')!.click();
    flushSync();
    const list = host.querySelector('[data-testid="widget-hover-list"]');
    expect(list).toBeTruthy();
    expect(list?.textContent).toContain('History survived restart');
  });

  it('refreshes the visible mini-inbox history after native DM and sync events', async () => {
    mountWidget();
    await waitForNativeReady();
    const initialFetches = tauri.invoke.mock.calls.filter(
      ([command]) => command === 'fetch_notification_history',
    ).length;

    history = {
      dms: [],
      shares: [
        {
          eventId: 'share-history-1',
          issuerDisplayName: 'Maya',
          issuerEmail: 'maya@example.com',
          paths: ['plans/launch.md'],
          note: null,
          createdAt: new Date().toISOString(),
        },
      ],
      files: [],
    };

    vi.useFakeTimers();
    emitNative('dm:unread-summary');
    emitNative('sync:complete');
    await vi.advanceTimersByTimeAsync(300);
    flushSync();
    expect(
      tauri.invoke.mock.calls.filter(
        ([command]) => command === 'fetch_notification_history',
      ).length,
    ).toBe(initialFetches + 1);

    host.querySelector<HTMLButtonElement>('.wm')!.click();
    flushSync();
    await vi.waitFor(() =>
      expect(
        host.querySelector('[data-testid="widget-hover-list"]')?.textContent,
      ).toContain('launch.md'),
    );
  });

  it('keeps the redesigned hierarchy when live hydration returns a noisy same-sender DM burst', async () => {
    mountWidget();
    await waitForNativeReady();
    host.querySelector<HTMLButtonElement>('.wm')!.click();
    flushSync();

    const panel = host.querySelector<HTMLElement>(
      '[data-testid="widget-hover-list"]',
    );
    expect(panel?.querySelector('.hl-header')).toBeTruthy();
    expect(panel?.textContent).toContain('You’re caught up');

    const now = Date.now();
    history = {
      dms: Array.from({ length: 10 }, (_, index) => ({
        eventId: `dogfood-dm-${index}`,
        fromPersonUid: 'prs_richard',
        fromDisplayName: 'Richard Sender',
        fromEmail: 'richard@sender.agency',
        body:
          index === 0
            ? 'Latest launch verification'
            : `Dogfood project update ${index}`,
        createdAt: new Date(now - index * 1_000).toISOString(),
      })),
      shares: [],
      files: [],
    };

    vi.useFakeTimers();
    emitNative('dm:unread-summary');
    await vi.advanceTimersByTimeAsync(300);
    flushSync();

    const hydrated = host.querySelector<HTMLElement>(
      '[data-testid="widget-hover-list"]',
    )!;
    const rows = hydrated.querySelectorAll<HTMLElement>(
      '[data-testid="notification-row"]',
    );
    expect(hydrated.querySelector('.hl-header')).toBeTruthy();
    expect(hydrated.querySelector('.hl-title')?.textContent).toBe('Messages');
    expect(
      [...hydrated.querySelectorAll('.hl-section-label')].map(
        (label) => label.textContent,
      ),
    ).toEqual(['Conversations']);
    expect(hydrated.querySelector('.hl-summary')?.textContent).toContain(
      '1 new conversation',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Richard Sender');
    expect(rows[0]?.textContent).toContain('10 recent messages');
    expect(rows[0]?.textContent).toContain('Latest launch verification');
    expect(
      rows[0]?.querySelector('[data-testid="unread-count"]')?.textContent,
    ).toBe('10');
    expect(rows[0]?.getAttribute('data-expanded')).toBe('false');
    expect(
      hydrated.querySelector('[data-testid="widget-hover-inbox"]'),
    ).toBeTruthy();
    expect(
      hydrated.querySelector('[data-testid="widget-hover-desktop"]'),
    ).toBeTruthy();

    rows[0]
      ?.querySelector<HTMLButtonElement>('.nr-primary-action')
      ?.click();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('open_dm_detail', {
        event: expect.objectContaining({
          eventId: 'dogfood-dm-0',
          fromPersonUid: 'prs_richard',
        }),
      });
    });
  });

  it('distinguishes pending native history hydration from a genuinely caught-up inbox', async () => {
    const historyRequest = deferred<NotificationHistory>();
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'fetch_notification_history') return historyRequest.promise;
      return defaultInvoke(command);
    });

    mountWidget();
    await waitForNativeReady();
    host.querySelector<HTMLElement>('.wm')!.click();
    flushSync();

    const list = host.querySelector('[data-testid="widget-hover-list"]');
    expect(list).toBeTruthy();
    expect(list?.querySelector('[data-testid="widget-history-loading"]')).toBeTruthy();
    expect(list?.textContent).toContain('Checking for messages');
    expect(list?.textContent).not.toContain('You’re caught up');

    historyRequest.resolve({ dms: [], shares: [], files: [] });
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="widget-history-loading"]'),
      ).toBeNull();
      expect(
        host.querySelector('[data-testid="widget-empty-state"]')?.textContent,
      ).toContain('You’re caught up');
    });
  });

  it('retains saved rows when history hydration fails and exposes a pending retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    localStorage.setItem(
      WIDGET_RECENT_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'saved-dm',
          type: 'message',
          actor: 'Maya',
          text: 'Saved conversation',
          ts: Date.parse('2026-07-27T15:00:00Z'),
          kind: 'dm',
          clickActionId: 'open-dm',
          data: { eventId: 'saved-dm', fromPersonUid: 'person-1' },
          expiresAt: 0,
          unread: true,
        },
      ]),
    );
    failedCommands.add('fetch_notification_history');

    mountWidget();
    await waitForNativeReady();
    host.querySelector<HTMLElement>('.wm')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="widget-history-error"]')?.textContent,
      ).toContain('Couldn’t refresh messages');
    });
    expect(
      host.querySelector('[data-testid="widget-hover-list"]')?.textContent,
    ).toContain('Saved conversation');

    const retryRequest = deferred<NotificationHistory>();
    failedCommands.delete('fetch_notification_history');
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'fetch_notification_history') return retryRequest.promise;
      return defaultInvoke(command);
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="widget-history-retry"]')!
      .click();

    await vi.waitFor(() => {
      flushSync();
      const retry = host.querySelector<HTMLButtonElement>(
        '[data-testid="widget-history-retry"]',
      );
      expect(retry).toBeTruthy();
      expect(retry?.disabled).toBe(true);
      expect(retry?.getAttribute('aria-busy')).toBe('true');
      expect(retry?.textContent).toContain('Retrying');
      expect(
        host.querySelector('[data-testid="widget-hover-list"]')?.textContent,
      ).toContain('Saved conversation');
    });

    retryRequest.resolve({ dms: [], shares: [], files: [] });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="widget-history-error"]')).toBeNull();
      expect(host.querySelector('[data-testid="widget-history-retry"]')).toBeNull();
      expect(
        host.querySelector('[data-testid="widget-hover-list"]')?.textContent,
      ).toContain('Saved conversation');
    });
    consoleError.mockRestore();
  });

  it('keeps the menu open with an accessible retry when both desktop commands fail', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failedCommands.add('open_desktop_alt_window');
    failedCommands.add('show_main_window');
    mountWidget();
    await waitForNativeReady();

    const wordmark = host.querySelector<HTMLElement>('.wm')!;
    wordmark.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    flushSync();
    host
      .querySelector<HTMLButtonElement>('[data-testid="widget-menu-desktop"]')!
      .click();

    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="widget-desktop-error"]')?.textContent,
      ).toContain('Couldn’t open HQ');
    });
    expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="widget-menu-desktop"]')?.textContent,
    ).toContain('Retry desktop');

    const desktopRequest = deferred<void>();
    failedCommands.delete('open_desktop_alt_window');
    failedCommands.delete('show_main_window');
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'open_desktop_alt_window') return desktopRequest.promise;
      return defaultInvoke(command);
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="widget-menu-desktop"]')!
      .click();

    await vi.waitFor(() => {
      flushSync();
      const retry = host.querySelector<HTMLButtonElement>(
        '[data-testid="widget-menu-desktop"]',
      );
      expect(retry).toBeTruthy();
      expect(retry?.disabled).toBe(true);
      expect(retry?.getAttribute('aria-busy')).toBe('true');
      expect(retry?.textContent).toContain('Opening desktop');
    });
    expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeTruthy();

    desktopRequest.resolve();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeNull();
    });
    consoleError.mockRestore();
  });

  it('moves focus into pinned surfaces, supports menu arrows, and restores focus on Escape', async () => {
    mountWidget();
    await waitForNativeReady();
    const wordmark = host.querySelector<HTMLElement>('.wm')!;
    wordmark.focus();
    wordmark.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    flushSync();

    const inbox = host.querySelector<HTMLButtonElement>(
      '[data-testid="widget-menu-inbox"]',
    )!;
    const desktop = host.querySelector<HTMLButtonElement>(
      '[data-testid="widget-menu-desktop"]',
    )!;
    await vi.waitFor(() => expect(document.activeElement).toBe(inbox));

    inbox.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(desktop);

    desktop.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Home',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(inbox);

    inbox.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    flushSync();
    expect(host.querySelector('[data-testid="widget-context-menu"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(wordmark));

    wordmark.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    flushSync();
    const panel = host.querySelector<HTMLElement>(
      '[data-testid="widget-hover-list"]',
    )!;
    await vi.waitFor(() => expect(document.activeElement).toBe(panel));
    panel.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    flushSync();
    expect(host.querySelector('[data-testid="widget-hover-list"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(wordmark));
  });

  it('neutralizes widget press transforms when reduced motion is requested', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/Widget.svelte'),
      'utf8',
    );
    const reducedMotion = source.slice(
      source.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    expect(reducedMotion).toMatch(
      /\.wm:active[\s\S]*?\.ctx-item:active[\s\S]*?transform:\s*none/,
    );
    expect(reducedMotion).toMatch(
      /\.hl-open-messages:active[\s\S]*?transform:\s*none/,
    );
  });
});
