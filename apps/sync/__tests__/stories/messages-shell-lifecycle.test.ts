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
import MessagesShell from '../../src/components/messaging/MessagesShell.svelte';

type Listener = (event: { payload: unknown }) => void;

interface DeferredListener {
  event: string;
  resolve: (unlisten: () => void) => void;
  unlisten: ReturnType<typeof vi.fn>;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let deferredListeners: DeferredListener[];

function deferredUnlisten(
  event: string,
  _callback: Listener,
): Promise<() => void> {
  const unlisten = vi.fn();
  return new Promise((resolve) => {
    deferredListeners.push({ event, resolve, unlisten });
  });
}

function invokeFixture(command: string): unknown {
  if (command === 'list_contacts') return { contacts: [] };
  if (command === 'fetch_notification_history') return { dms: [], shares: [] };
  if (command === 'get_unread_summary') {
    return { unreadDms: 0, pendingRequests: 0 };
  }
  if (command === 'list_dm_requests') return { requests: [] };
  if (command === 'list_channels') return { channels: [] };
  if (command === 'meetings_list_memberships') return [];
  if (command === 'get_config') return {};
  return undefined;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  deferredListeners = [];
  tauri.listen.mockImplementation(deferredUnlisten);
  tauri.invoke.mockImplementation(async (command: string) =>
    invokeFixture(command),
  );
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('MessagesShell mount lifecycle', () => {
  it('unsubscribes listeners that resolve after the embedded route has already unmounted', async () => {
    component = mount(MessagesShell, {
      target: host,
      props: { embedded: true },
    });
    flushSync();

    expect(deferredListeners.map(({ event }) => event)).toEqual([
      'dm:new-events',
      'dm:request-new',
      'dm:request-update',
      'channel:new-message',
      'message:reaction',
      'messages:open-conversation',
      'channel:updated',
    ]);

    await unmount(component);
    component = null;

    for (const listener of deferredListeners) {
      listener.resolve(listener.unlisten);
    }

    await vi.waitFor(() => {
      for (const listener of deferredListeners) {
        expect(listener.unlisten, listener.event).toHaveBeenCalledOnce();
      }
    });

    expect(tauri.invoke).toHaveBeenCalledWith('mark_messages_viewed');
    expect(tauri.invoke).not.toHaveBeenCalledWith('messages_window_ready');
  });

  it('keeps the standalone ready handshake for the native Messages window', () => {
    component = mount(MessagesShell, { target: host });
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('messages_window_ready');
    expect(tauri.invoke).not.toHaveBeenCalledWith('mark_messages_viewed');
  });
});
