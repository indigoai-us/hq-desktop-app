// @vitest-environment happy-dom

// US-020: the sidebar must paint instantly — cache-first render from
// localStorage with a background refresh. This is a measurable perf
// assertion, not a vibe: with the conversation cache seeded and EVERY
// backend invoke left permanently pending, a synchronous mount+flush must
// produce the full conversation list in under the 200ms budget. If someone
// reintroduces an awaited backend call (or any async gate) ahead of first
// paint, the rows never appear and this fails loudly — the timing assertion
// then guards against synchronous-but-slow regressions on the mount path.

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
import { CONVERSATION_CACHE_KEY } from './sidebar-model';
import ChatSidebar from './ChatSidebar.svelte';

const FIRST_PAINT_BUDGET_MS = 200;

/** A pending promise that never settles — the backend never answers. */
const NEVER = new Promise(() => {});

function seedConversationCache(count: number): void {
  const now = Date.now();
  const channels = Array.from({ length: count }, (_, i) => ({
    channelId: `ch-${i}`,
    name: `channel-${i}`,
    scope: 'company',
    companyUid: 'org_test',
    companyName: 'Testco',
    unread: i % 3 === 0 ? 2 : 0,
    lastActivityAt: new Date(now - i * 60_000).toISOString(),
    lastMessageAt: new Date(now - i * 60_000).toISOString(),
  }));
  const contacts = Array.from({ length: count }, (_, i) => ({
    personUid: `prs_${i}`,
    email: `person${i}@example.com`,
    displayName: `Person ${i}`,
    lastMessageAt: new Date(now - i * 45_000).toISOString(),
  }));
  window.localStorage.setItem(
    CONVERSATION_CACHE_KEY,
    JSON.stringify({ channels, contacts, cachedAt: now }),
  );
}

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

// happy-dom in this repo does not expose window.localStorage — provide a real
// in-memory Storage so the component's cache-first path runs unmodified.
function installMemoryStorage(): void {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  installMemoryStorage();
  // Backend is unreachable-slow: every command hangs forever. First paint
  // must not depend on any of them resolving.
  invokeMock.mockReturnValue(NEVER);
  listenMock.mockReturnValue(NEVER);
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) {
    unmount(component);
    component = null;
  }
  host.remove();
});

describe('sidebar first paint (US-020 instant sidebar)', () => {
  it(`renders cached conversations synchronously in under ${FIRST_PAINT_BUDGET_MS}ms with the backend hung`, () => {
    seedConversationCache(25);

    const started = performance.now();
    component = mount(ChatSidebar, {
      target: host,
      props: { companies: [], accountLabel: 'corey@example.com' },
    });
    flushSync();
    const elapsed = performance.now() - started;

    const rows = host.querySelectorAll('.chat-row[data-conversation-id]');
    // 25 channels + 25 DM contacts seeded; grouping may fold some into the
    // collapsed last-week bucket, but the cache-first paint must show a
    // substantial list, not a skeleton.
    expect(rows.length).toBeGreaterThanOrEqual(25);
    // No loading/empty state may gate the cached paint.
    expect(host.textContent).not.toContain('Loading…');
    expect(elapsed).toBeLessThan(FIRST_PAINT_BUDGET_MS);
  });

  it('paints from cache and still kicks off the background refresh', () => {
    seedConversationCache(5);

    component = mount(ChatSidebar, { target: host, props: { companies: [] } });
    flushSync();

    // Cache painted…
    expect(host.querySelectorAll('.chat-row[data-conversation-id]').length).toBeGreaterThan(0);
    // …and the background refresh was issued (list_contacts / list_channels),
    // even though it will never resolve in this test.
    const commands = invokeMock.mock.calls.map((call) => call[0]);
    expect(commands).toContain('list_contacts');
    expect(commands).toContain('list_channels');
  });

  it('shows the loading state only when there is no cache to paint from', () => {
    component = mount(ChatSidebar, { target: host, props: { companies: [] } });
    flushSync();

    expect(host.querySelectorAll('.chat-row[data-conversation-id]').length).toBe(0);
    expect(host.textContent).toContain('Loading…');
  });
});
