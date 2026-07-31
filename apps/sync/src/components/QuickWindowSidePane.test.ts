// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock, loadItemsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  loadItemsMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock('../lib/notificationFeedData', () => ({
  getLastReadTs: () => 0,
  isUnread: (item: Item, lastReadTs: number) => item.ts > lastReadTs,
  loadNotificationItems: (...args: unknown[]) => loadItemsMock(...args),
}));

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import type { Item } from '../lib/notificationGroups';
import QuickWindowSidePane from './QuickWindowSidePane.svelte';

function message(id: string, actor: string, ts: number): Item {
  return {
    id: `dm:${id}`,
    kind: 'dm',
    actor,
    summary: `Message from ${actor}`,
    ts,
    dm: {
      eventId: id,
      fromPersonUid: `prs_${id}`,
      fromEmail: `${id}@example.com`,
      fromDisplayName: actor,
      body: `Message from ${actor}`,
      createdAt: new Date(ts).toISOString(),
    },
  };
}

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  loadItemsMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
  invokeMock.mockResolvedValue({ channels: [] });
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe('QuickWindowSidePane', () => {
  it('opens the newest unread conversation instead of leaving the detail pane empty', async () => {
    const onselect = vi.fn();
    loadItemsMock.mockResolvedValue([
      message('newest', 'Maya Chen', 300),
      message('older', 'Alan Saura', 200),
    ]);

    component = mount(QuickWindowSidePane, {
      target: host,
      props: {
        selectedId: null,
        selectedChannelId: null,
        viewedIds: new Set<string>(),
        onselect,
      },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(onselect).toHaveBeenCalledTimes(1);
    });
    expect(onselect.mock.calls[0]?.[0].actor).toBe('Maya Chen');
  });

  it('filters direct messages from the compact conversation search', async () => {
    loadItemsMock.mockResolvedValue([
      message('maya', 'Maya Chen', 300),
      message('alan', 'Alan Saura', 200),
    ]);

    component = mount(QuickWindowSidePane, {
      target: host,
      props: {
        selectedId: 'dm:maya',
        selectedChannelId: null,
        viewedIds: new Set<string>(),
        onselect: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="quick-conversation-row"]')).toHaveLength(2);
    });

    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'Alan';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    const rows = host.querySelectorAll('[data-testid="quick-conversation-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Alan Saura');
  });
});
