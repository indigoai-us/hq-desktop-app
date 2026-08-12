// @vitest-environment happy-dom
//
// US-018: V4Sidebar retired. Hydration ownership that used to live on the
// primary nav rail now lives on ChatSidebar (companies prop is authoritative)
// and DesktopApp (workspace list load). Update-badge races live on
// VersionPopout / Settings — not the chat sidebar.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
vi.mock('@tauri-apps/api/event', () => ({
  listen: tauri.listen,
  emit: vi.fn(),
}));

import { flushSync, mount, unmount } from 'svelte';
import ChatSidebar from '../../src/desktop-alt/chat/ChatSidebar.svelte';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  const storageValues = new Map<string, string>();
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
  tauri.listen.mockImplementation(async () => vi.fn());
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'list_contacts') return { contacts: [] };
    if (command === 'list_channels') return { channels: [] };
    if (command === 'list_dm_requests') return { requests: [] };
    if (command === 'list_syncable_workspaces') {
      return { workspaces: [], cloudReachable: false };
    }
    return [];
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('US-018: V4Sidebar retired; ChatSidebar owns conversation hydration', () => {
  it('deleted the legacy V4Sidebar surface', () => {
    expect(existsSync(root('src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
    expect(existsSync(root('src/desktop-alt/pages/InboxPage.svelte'))).toBe(false);
  });

  it('treats an explicitly empty company list as authoritative instead of self-loading workspaces', async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        companies: [],
      },
    });
    flushSync();
    await Promise.resolve();
    await Promise.resolve();

    // ChatSidebar refreshes conversations (contacts/channels) but never owns
    // the workspace list — DesktopApp passes companies down.
    expect(tauri.invoke).not.toHaveBeenCalledWith('list_syncable_workspaces');
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'list_syncable_workspaces',
      expect.anything(),
    );
  });

  it('does not reintroduce the retired Inbox unread badge event bridge on the chat sidebar', async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        companies: [],
      },
    });
    flushSync();
    await Promise.resolve();

    window.dispatchEvent(
      new CustomEvent('hq:notifications-unread-count', { detail: 6 }),
    );
    flushSync();

    // V4Sidebar used to mirror hq:notifications-unread-count onto a unified
    // inbox badge. ChatSidebar only badges conversation rows from its own
    // channel/DM models — the custom event must not invent a badge.
    expect(host.querySelector('.v4-unread-badge')).toBeNull();
    expect(host.querySelector('[data-testid="chat-unread-badge"]')).toBeNull();
  });

  it('refreshes conversation lists without calling get_pending_update', async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        companies: [],
      },
    });
    flushSync();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('list_contacts');
    });

    const commands = tauri.invoke.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain('get_pending_update');
    expect(commands).not.toContain('fetch_notification_history');
    expect(commands).toContain('list_channels');
  });
});
