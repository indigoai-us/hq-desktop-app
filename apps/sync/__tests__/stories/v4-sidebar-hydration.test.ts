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
import V4Sidebar from '../../src/desktop-alt/v4/V4Sidebar.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let listeners: Map<string, (event: { payload: unknown }) => void>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  listeners = new Map();
  tauri.listen.mockImplementation(
    async (event: string, callback: (event: { payload: unknown }) => void) => {
      listeners.set(event, callback);
      return vi.fn();
    },
  );
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'list_syncable_workspaces') {
      return { workspaces: [], cloudReachable: false };
    }
    if (command === 'fetch_notification_history') {
      return { dms: [], shares: [], files: [] };
    }
    if (command === 'get_activity_log') return [];
    if (command === 'get_pending_update') return { status: 'absent' };
    return [];
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('V4Sidebar hydration ownership', () => {
  it('treats an explicitly empty company list as authoritative instead of self-loading', async () => {
    component = mount(V4Sidebar, {
      target: host,
      props: {
        route: { kind: 'home' },
        companies: [],
        cloudReachable: false,
      },
    });
    flushSync();
    await Promise.resolve();

    expect(tauri.invoke).not.toHaveBeenCalledWith('list_syncable_workspaces');
    expect(host.querySelectorAll('.v4-company-row')).toHaveLength(0);
  });

  it('keeps a cleared Inbox badge cleared when an older refresh resolves last', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    let pendingCalls = 0;
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'fetch_notification_history') {
        return Promise.resolve({ dms: [], shares: [], files: [] });
      }
      if (command === 'get_activity_log') return Promise.resolve([]);
      if (command === 'get_pending_update') {
        pendingCalls += 1;
        return pendingCalls === 1 ? older.promise : newer.promise;
      }
      return Promise.resolve([]);
    });

    component = mount(V4Sidebar, {
      target: host,
      props: {
        route: { kind: 'home' },
        companies: [],
        cloudReachable: true,
      },
    });
    flushSync();
    await vi.waitFor(() =>
      expect(listeners.get('update:cleared')).toBeTypeOf('function'),
    );

    listeners.get('update:cleared')!({ payload: undefined });
    await vi.waitFor(() => expect(pendingCalls).toBe(2));
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

    expect(host.querySelector('.v4-unread-badge')).toBeNull();
  });

  it('registers native listeners before mount hydration closes the event gap', async () => {
    const listenerGate = deferred<void>();
    let pendingCalls = 0;
    let pendingState: unknown = { status: 'absent' };
    tauri.listen.mockImplementation(() =>
      listenerGate.promise.then(() => vi.fn()),
    );
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'fetch_notification_history') {
        return Promise.resolve({ dms: [], shares: [], files: [] });
      }
      if (command === 'get_activity_log') return Promise.resolve([]);
      if (command === 'get_pending_update') {
        pendingCalls += 1;
        return Promise.resolve(pendingState);
      }
      return Promise.resolve([]);
    });

    component = mount(V4Sidebar, {
      target: host,
      props: {
        route: { kind: 'home' },
        companies: [],
        cloudReachable: true,
      },
    });
    flushSync();
    await Promise.resolve();
    expect(pendingCalls).toBe(0);

    pendingState = {
      status: 'pending',
      update: {
        version: '0.10.36-beta.1',
        detectedAt: '2026-07-27T15:00:00Z',
      },
    };
    listenerGate.resolve(undefined);

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.v4-unread-badge')?.textContent).toBe('1');
    });
    expect(pendingCalls).toBe(1);
  });
});
