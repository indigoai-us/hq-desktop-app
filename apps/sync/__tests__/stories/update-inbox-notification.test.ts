// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import NotificationFeed from '../../src/components/NotificationFeed.svelte';
import InboxPage from '../../src/desktop-alt/pages/InboxPage.svelte';

type UpdateInfo = {
  version: string;
  body?: string;
  date?: string;
};

type Listener = (event: { payload: unknown }) => void;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let pendingUpdate: UpdateInfo | null;
let listeners: Map<string, Listener>;
let unlisteners: Map<string, ReturnType<typeof vi.fn>>;
let installShouldFail: boolean;
let historyShouldFail: boolean;
let openShouldFail: boolean;
let storageValues: Map<string, string>;

function mountFeed(onloadstatechange?: (loaded: boolean) => void): HTMLElement {
  component = mount(NotificationFeed, {
    target: host,
    props: { density: 'comfortable', onloadstatechange },
  });
  flushSync();
  return host;
}

async function waitForUpdateRow(): Promise<HTMLElement> {
  await vi.waitFor(() => {
    flushSync();
    expect(
      host.querySelector('[data-testid="notification-row"][data-type="system"]'),
    ).toBeTruthy();
  });
  return host.querySelector<HTMLElement>(
    '[data-testid="notification-row"][data-type="system"]',
  )!;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  pendingUpdate = {
    version: '0.10.36-beta.1',
    body: 'Inbox update notification repair',
    date: '2026-07-27T15:00:00Z',
  };
  listeners = new Map();
  unlisteners = new Map();
  installShouldFail = false;
  historyShouldFail = false;
  openShouldFail = false;
  storageValues = new Map();
  vi.stubGlobal('localStorage', {
    get length() {
      return storageValues.size;
    },
    clear: () => storageValues.clear(),
    getItem: (key: string) => storageValues.get(key) ?? null,
    key: (index: number) => [...storageValues.keys()][index] ?? null,
    removeItem: (key: string) => storageValues.delete(key),
    setItem: (key: string, value: string) => storageValues.set(key, String(value)),
  } satisfies Storage);

  tauri.listen.mockImplementation(
    async (event: string, callback: Listener) => {
      listeners.set(event, callback);
      const unlisten = vi.fn();
      unlisteners.set(event, unlisten);
      return unlisten;
    },
  );
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'fetch_notification_history') {
      if (historyShouldFail) throw new Error('cloud history unavailable');
      return { dms: [], shares: [], files: [] };
    }
    if (command === 'get_activity_log') return [];
    if (command === 'get_pending_update') return pendingUpdate;
    if (command === 'open_desktop_alt_window') {
      if (openShouldFail) throw new Error('window route unavailable');
      return undefined;
    }
    if (command === 'install_update') {
      if (installShouldFail) throw new Error('signature rejected');
      return undefined;
    }
    throw new Error(`Unexpected invoke: ${command}`);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Inbox app-update notification', () => {
  it('renders a pending update, opens Updates from the row, and installs only from Update now', async () => {
    mountFeed();

    const row = await waitForUpdateRow();
    expect(row.textContent).toContain('0.10.36-beta.1');
    expect(row.textContent).toContain('Update now');

    row.querySelector<HTMLButtonElement>('.nr-primary-action')!.click();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('open_desktop_alt_window', {
        route: 'settings:updates',
      });
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith('install_update');

    row.querySelector<HTMLButtonElement>('.nr-open')!.click();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('install_update');
    });
  });

  it('refreshes an already-open Inbox when update:available arrives', async () => {
    vi.useFakeTimers();
    pendingUpdate = null;
    mountFeed();

    await vi.waitFor(() => {
      expect(listeners.get('update:available')).toBeTypeOf('function');
    });
    expect(
      host.querySelector('[data-testid="notification-row"][data-type="system"]'),
    ).toBeNull();

    pendingUpdate = {
      version: '0.10.37',
      date: '2026-07-27T16:00:00Z',
    };
    listeners.get('update:available')!({ payload: pendingUpdate });
    await vi.advanceTimersByTimeAsync(400);

    const row = await waitForUpdateRow();
    expect(row.textContent).toContain('0.10.37');
  });

  it('removes an update when native state clears', async () => {
    mountFeed();
    await waitForUpdateRow();
    await vi.waitFor(() => {
      expect(listeners.get('update:cleared')).toBeTypeOf('function');
    });

    pendingUpdate = null;
    vi.useFakeTimers();
    listeners.get('update:cleared')!({ payload: undefined });
    await vi.advanceTimersByTimeAsync(400);
    flushSync();

    expect(
      host.querySelector('[data-testid="notification-row"][data-type="system"]'),
    ).toBeNull();
  });

  it('surfaces install failure accessibly and allows retry', async () => {
    installShouldFail = true;
    mountFeed();
    const row = await waitForUpdateRow();
    row.querySelector<HTMLButtonElement>('.nr-open')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Couldn’t complete that action.',
      );
    });
    expect(row.querySelector<HTMLButtonElement>('.nr-retry')).not.toBeNull();
    expect(row.querySelector<HTMLButtonElement>('.nr-open')!.disabled).toBe(false);

    listeners.get('update:cleared')!({ payload: undefined });
    flushSync();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps failed notification navigation retryable in the row', async () => {
    openShouldFail = true;
    mountFeed();
    const row = await waitForUpdateRow();
    row.querySelector<HTMLButtonElement>('.nr-primary-action')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(row.querySelector('[role="alert"]')?.textContent).toContain(
        'Couldn’t open this item.',
      );
    });
    expect(row.querySelector<HTMLButtonElement>('.nr-primary-action')!.disabled).toBe(false);

    openShouldFail = false;
    row.querySelector<HTMLButtonElement>('.nr-retry')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(row.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it('keeps a trusted update visible when cloud notification history fails', async () => {
    historyShouldFail = true;
    const onloadstatechange = vi.fn();
    mountFeed(onloadstatechange);
    const row = await waitForUpdateRow();

    expect(row.textContent).toContain('0.10.36-beta.1');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'cloud notifications could not be loaded',
    );
    expect(onloadstatechange).toHaveBeenLastCalledWith(false);
  });

  it('does not mark omitted notifications read when a partial load is left before recovery', async () => {
    historyShouldFail = true;
    component = mount(InboxPage, { target: host });
    flushSync();
    await waitForUpdateRow();
    expect(host.querySelector('[role="alert"]')).toBeTruthy();

    await unmount(component);
    component = null;
    expect(localStorage.getItem('hq-sync:notifications-last-read')).toBeNull();

    historyShouldFail = false;
    component = mount(InboxPage, { target: host });
    flushSync();
    await waitForUpdateRow();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    await unmount(component);
    component = null;
    expect(Number(localStorage.getItem('hq-sync:notifications-last-read'))).toBeGreaterThan(0);
  });

  it('does not mark a post-hydration update read when leaving before its debounce refresh', async () => {
    component = mount(InboxPage, { target: host });
    flushSync();
    await waitForUpdateRow();
    await vi.waitFor(() => {
      expect(listeners.get('update:available')).toBeTypeOf('function');
    });

    vi.useFakeTimers();
    pendingUpdate = {
      version: '0.10.37-beta.2',
      date: '2026-07-27T17:00:00Z',
    };
    listeners.get('update:available')!({ payload: pendingUpdate });

    await unmount(component);
    component = null;
    expect(localStorage.getItem('hq-sync:notifications-last-read')).toBeNull();
  });

  it('unregisters the update listener with the rest of the feed listeners', async () => {
    mountFeed();
    await vi.waitFor(() => {
      expect(listeners.get('update:available')).toBeTypeOf('function');
    });

    await unmount(component!);
    component = null;

    expect(unlisteners.get('update:available')).toHaveBeenCalledOnce();
    expect(unlisteners.get('update:cleared')).toHaveBeenCalledOnce();
  });
});
