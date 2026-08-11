// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import MessagesShell from './MessagesShell.svelte';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let host: HTMLElement;
let component: Record<string, unknown> | null = null;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  consoleErrorSpy.mockRestore();
  host.remove();
});

describe('MessagesShell request governance (US-013)', () => {
  it('renders pending DM requests in the rail and opens the accept/decline card', async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case 'list_contacts':
          return Promise.resolve({ contacts: [] });
        case 'fetch_notification_history':
          return Promise.resolve({ dms: [], shares: [] });
        case 'list_dm_requests':
          return Promise.resolve({
            requests: [
              {
                pairKey: 'pair-1',
                fromPersonUid: 'person-ada',
                fromEmail: 'ada@example.com',
                fromDisplayName: 'Ada Lovelace',
                message: 'Hello there',
                createdAt: new Date().toISOString(),
              },
            ],
          });
        case 'get_unread_summary':
          return Promise.resolve({ unreadDms: 0, pendingRequests: 1 });
        case 'list_channels':
          return Promise.resolve({ channels: [] });
        case 'meetings_list_memberships':
          return Promise.resolve([]);
        case 'get_config':
          return Promise.resolve({});
        case 'mark_messages_viewed':
          return Promise.resolve();
        case 'set_watched_shares':
          return Promise.resolve();
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    component = mount(MessagesShell, {
      target: host,
      props: { embedded: true },
    });
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="request-rail-row"]')?.textContent,
      ).toContain('Ada Lovelace');
    });

    host
      .querySelector<HTMLButtonElement>('[data-testid="request-rail-row"]')!
      .click();
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="request-detail-pane"]')).not.toBeNull();
    });
  });
});

describe('MessagesShell channel loading recovery', () => {
  it('keeps a failed channel load visible while retrying, then clears it after recovery', async () => {
    const retryChannels = deferred<{ channels: [] }>();
    let channelAttempts = 0;

    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case 'list_contacts':
          return Promise.resolve({ contacts: [] });
        case 'fetch_notification_history':
          return Promise.resolve({ dms: [], shares: [] });
        case 'list_dm_requests':
          return Promise.resolve({ requests: [] });
        case 'get_unread_summary':
          return Promise.resolve({ unreadDms: 0, pendingRequests: 0 });
        case 'list_channels':
          channelAttempts += 1;
          return channelAttempts === 1
            ? Promise.reject(new Error('channel service unavailable'))
            : retryChannels.promise;
        case 'meetings_list_memberships':
          return Promise.resolve([]);
        case 'get_config':
          return Promise.resolve({});
        case 'mark_messages_viewed':
          return Promise.resolve();
        case 'set_watched_shares':
          return Promise.resolve();
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    component = mount(MessagesShell, {
      target: host,
      props: { embedded: true },
    });
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not load channels',
      );
    });

    const retry = host.querySelector<HTMLButtonElement>('.rail-retry')!;
    expect(retry.textContent).toContain('Retry');
    expect(retry.disabled).toBe(false);

    retry.click();
    flushSync();

    const retrying = host.querySelector<HTMLButtonElement>('.rail-retry')!;
    expect(channelAttempts).toBe(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Retrying channels…',
    );
    expect(retrying.textContent).toContain('Retrying…');
    expect(retrying.disabled).toBe(true);
    expect(retrying.getAttribute('aria-busy')).toBe('true');

    retryChannels.resolve({ channels: [] });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector('.rail-status')?.textContent).toContain(
        'No conversations yet.',
      );
    });
  });
});
