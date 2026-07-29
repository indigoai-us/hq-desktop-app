// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  onFocusChanged: vi.fn(),
  setSize: vi.fn(),
}));
const feedData = vi.hoisted(() => ({
  loadTimeline: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: tauri.onFocusChanged,
    setSize: tauri.setSize,
  }),
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));
vi.mock('../../src/lib/notificationFeedData', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/lib/notificationFeedData')>();
  return {
    ...actual,
    loadNotificationTimeline: feedData.loadTimeline,
  };
});

import { flushSync, mount, unmount } from 'svelte';
import Popover from '../../src/components/Popover.svelte';

type MountedComponent = ReturnType<typeof mount>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let host: HTMLDivElement;
let component: MountedComponent | null;
let navigationFails: boolean;
let messageRetry: ReturnType<typeof deferred<void>> | null;

function mountPopover(
  overrides: Partial<{
    updateInstalling: boolean;
    updateInstallError: string | null;
    oninstallupdate: () => void | Promise<void>;
  }> = {},
): HTMLElement {
  component = mount(Popover, {
    target: host,
    props: {
      syncState: 'idle',
      config: null,
      onsync: vi.fn(),
      messagesUnreadCount: 3,
      updateAvailable: { version: '0.10.36' },
      updateInstalling: false,
      updateInstallError: null,
      oninstallupdate: vi.fn(),
      ...overrides,
    },
  });
  flushSync();
  return host;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
  navigationFails = true;
  messageRetry = null;
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
  tauri.unlisten.mockReset();
  tauri.onFocusChanged.mockReset();
  tauri.setSize.mockReset();
  feedData.loadTimeline.mockReset();
  tauri.listen.mockResolvedValue(tauri.unlisten);
  tauri.onFocusChanged.mockResolvedValue(tauri.unlisten);
  feedData.loadTimeline.mockResolvedValue({
    items: [],
    historyState: 'resolved',
    activityState: 'resolved',
    updateState: 'resolved',
  });
  tauri.invoke.mockImplementation(
    async (command: string, args?: { route?: string }) => {
      if (command === 'get_sync_status') {
        return {
          lastSyncAt: null,
          pendingFiles: 0,
          conflicts: 0,
          daemonRunning: true,
          source: 'test',
        };
      }
      if (command === 'open_communications_window') {
        if (navigationFails) throw new Error('offline');
        if (messageRetry) return messageRetry.promise;
        return undefined;
      }
      if (command === 'open_desktop_alt_window') {
        if (navigationFails) {
          throw new Error(args?.route ? 'updates unavailable' : 'desktop unavailable');
        }
        return undefined;
      }
      throw new Error(`Unexpected invoke: ${command}`);
    },
  );
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('Popover action recovery', () => {
  it('keeps Messages, desktop, and Updates failures visible with scoped retries', async () => {
    mountPopover();

    host.querySelector<HTMLButtonElement>('[data-testid="popover-open-messages"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-testid="popover-open-desktop"]')!.click();
    const updateNotice = host.querySelector<HTMLElement>(
      '[data-testid="popover-system-notice"][data-kind="update"]',
    )!;
    Array.from(updateNotice.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('View updates'))!
      .click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="popover-messages-error"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="popover-desktop-error"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="popover-updates-error"]')).toBeTruthy();
    });

    navigationFails = false;
    host
      .querySelector<HTMLButtonElement>('[data-testid="popover-desktop-error"] button')!
      .click();
    host
      .querySelector<HTMLButtonElement>('[data-testid="popover-updates-error"] button')!
      .click();

    messageRetry = deferred<void>();
    host
      .querySelector<HTMLButtonElement>('[data-testid="popover-messages-error"] button')!
      .click();
    flushSync();

    const messages = host.querySelector<HTMLButtonElement>(
      '[data-testid="popover-open-messages"]',
    )!;
    expect(messages.disabled).toBe(true);
    expect(messages.getAttribute('aria-busy')).toBe('true');
    expect(messages.textContent).toContain('Opening…');

    messageRetry.resolve();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="popover-messages-error"]')).toBeNull();
      expect(host.querySelector('[data-testid="popover-desktop-error"]')).toBeNull();
      expect(host.querySelector('[data-testid="popover-updates-error"]')).toBeNull();
      expect(messages.disabled).toBe(false);
    });
  });

  it('renders the App-owned install error and invokes its retry action', async () => {
    const retry = vi.fn();
    mountPopover({
      updateInstallError: 'Couldn’t install the update. Try again.',
      oninstallupdate: retry,
    });

    const alert = host.querySelector<HTMLElement>(
      '[data-testid="popover-install-error"]',
    )!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Couldn’t install the update.');

    const retryButton = alert.querySelector<HTMLButtonElement>('button')!;
    retryButton.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps install and retry controls disabled while installation is pending', async () => {
    const retry = vi.fn();
    mountPopover({
      updateInstalling: true,
      updateInstallError: 'Couldn’t install the update. Try again.',
      oninstallupdate: retry,
    });

    const retryButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="popover-install-error"] button',
    )!;
    expect(retryButton.disabled).toBe(true);
    expect(retryButton.getAttribute('aria-busy')).toBe('true');
    expect(retryButton.textContent).toContain('Retrying…');
    retryButton.click();
    expect(retry).not.toHaveBeenCalled();
  });
});
