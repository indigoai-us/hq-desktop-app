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

function defaultInvoke(command: string): unknown {
  if (failedCommands.has(command)) {
    throw new Error(`${command} unavailable`);
  }
  if (command === 'fetch_notification_history') return history;
  if (command === 'get_activity_log') return [];
  if (command === 'get_pending_update') return pendingUpdate;
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
  tauri.invoke.mockImplementation(async (command: string) =>
    defaultInvoke(command),
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
    {
      theme: 'light',
      page: '#eeeeee',
      popDivider: 'rgba(0,0,0,0.08)',
      popIcon: 'rgba(0,0,0,0.5)',
      rowBg: 'rgba(250, 250, 250, 0.6)',
      rowFg: '#1d1d1d',
      replyBg: 'rgba(0, 0, 0, 0.05)',
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
      rowBg: 'rgba(30, 30, 30, 0.55)',
      rowFg: '#fff',
      replyBg: 'rgba(255, 255, 255, 0.08)',
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
    expect([...unlisteners.values()]).toHaveLength(7);
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

  it('opens Inbox and the full desktop from the native context menu', async () => {
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
        tauri.invoke.mock.calls.some(([command]) => command === 'open_inbox_window'),
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
      tauri.invoke.mock.calls.some(([command]) => command === 'open_inbox_window'),
    ).toBe(true);

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
    expect(
      tauri.invoke.mock.calls.some(([command]) => command === 'open_inbox_window'),
    ).toBe(true);

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

    await openVisibleNotification(
      notification({
        kind: 'update',
        title: 'HQ 0.10.34',
        body: 'Release notes',
        clickActionId: 'open',
      }),
    );
    expect(
      tauri.invoke.mock.calls.some(([command]) => command === 'open_inbox_window'),
    ).toBe(true);

    await openVisibleNotification(
      notification({
        kind: 'meeting',
        title: 'Standup',
        body: 'Starting now',
      }),
    );
    expect(
      tauri.invoke.mock.calls.some(([command]) => command === 'show_main_window'),
    ).toBe(true);

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
      tauri.invoke.mock.calls.some(([command]) => command === 'open_inbox_window'),
    ).toBe(true);
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
      expect(
        tauri.invoke.mock.calls.some(([command]) => command === 'open_inbox_window'),
      ).toBe(true);
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
});
