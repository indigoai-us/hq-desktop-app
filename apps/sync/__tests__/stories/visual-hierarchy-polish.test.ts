// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
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
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { flushSync, mount, unmount } from 'svelte';
import NotificationRow from '../../src/components/NotificationRow.svelte';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let historyPayload: {
  dms: Array<{
    eventId: string;
    fromPersonUid: string;
    fromEmail: string;
    fromDisplayName: string;
    body: string;
    createdAt: string;
  }>;
  shares: unknown[];
  files: Array<{
    eventId: string;
    path: string;
    addedBy: string;
    companySlug: string;
    createdAt: string;
  }>;
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.stubGlobal('localStorage', {
    length: 0,
    clear: vi.fn(),
    getItem: vi.fn(() => null),
    key: vi.fn(() => null),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  } satisfies Storage);
  tauri.listen.mockResolvedValue(vi.fn());
  historyPayload = {
    dms: Array.from({ length: 224 }, (_, index) => ({
      eventId: `dm-${index}`,
      fromPersonUid: `person-${index}`,
      fromEmail: `person-${index}@example.com`,
      fromDisplayName: `Person ${index}`,
      body: `Notification ${index}`,
      createdAt: new Date(Date.now() - index * 1_000).toISOString(),
    })),
    shares: [],
    files: [],
  };
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'fetch_notification_history') return historyPayload;
    if (command === 'get_activity_log') return [];
    if (command === 'get_pending_update') return null;
    return undefined;
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('visual hierarchy polish: shared notification row', () => {
  it('shows a plain-text actor prefix, source/type metadata, full timestamp semantics, and truncation tooltip', () => {
    const timestamp = Date.parse('2026-07-27T15:12:00.000Z');
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'message',
        actor: 'Corey Epstein',
        sourceLabel: 'Direct message',
        text: 'A long notification summary that should remain discoverable after truncation',
        ts: timestamp,
      },
    });
    flushSync();

    const actor = host.querySelector<HTMLElement>('[data-testid="notification-actor"]');
    expect(actor?.textContent?.trim()).toBe('Corey Epstein');
    expect(actor?.getAttribute('title')).toBe('Corey Epstein');

    const metadata = host.querySelector<HTMLElement>('[data-testid="notification-source"]');
    expect(metadata?.textContent?.trim()).toBe('Direct message');

    const time = host.querySelector<HTMLTimeElement>('time.nr-ts');
    expect(time?.dateTime).toBe('2026-07-27T15:12:00.000Z');
    expect(time?.title).not.toBe('');

    expect(host.querySelector<HTMLElement>('.nr-text')?.title).toContain(
      'A long notification summary',
    );
  });

  it('immediately disables and spins an async row open action until it settles', async () => {
    let finish!: () => void;
    const onopen = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'share',
        actor: 'Alex',
        text: 'shared launch-plan.md',
        ts: Date.now(),
        onopen,
      },
    });
    flushSync();

    const open = host.querySelector<HTMLButtonElement>('.nr-primary-action')!;
    open.click();
    flushSync();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(open.disabled).toBe(true);
    expect(open.getAttribute('aria-busy')).toBe('true');
    expect(open.querySelector('[data-testid="notification-pending"]')).toBeTruthy();

    open.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => {
      flushSync();
      expect(open.disabled).toBe(false);
    });
  });

  it('shares one pending gate across row and visible actions while announcing unread count', async () => {
    let finish!: () => void;
    const onopen = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'share',
        actor: 'Alex',
        text: 'shared launch-plan.md',
        ts: Date.now(),
        unread: true,
        badgeCount: 4,
        actionLabel: 'View file',
        onopen,
      },
    });
    flushSync();

    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
    const primary = host.querySelector<HTMLButtonElement>('.nr-primary-action')!;
    const visibleAction = host.querySelector<HTMLButtonElement>('.nr-open')!;

    expect(row.getAttribute('aria-label')).toContain('4 unread');
    expect(primary.getAttribute('aria-label')).toContain('4 unread');

    visibleAction.click();
    flushSync();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(primary.disabled).toBe(true);
    expect(visibleAction.disabled).toBe(true);
    expect(primary.getAttribute('aria-busy')).toBe('true');
    expect(visibleAction.getAttribute('aria-busy')).toBe('true');
    expect(visibleAction.textContent).toContain('Working');

    primary.click();
    visibleAction.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => {
      flushSync();
      expect(primary.disabled).toBe(false);
      expect(visibleAction.disabled).toBe(false);
    });
  });

  it('prevents the row destination and secondary action from racing each other', async () => {
    let finishOpen!: () => void;
    let finishAction!: () => void;
    const onopen = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finishOpen = resolvePromise;
        }),
    );
    const onaction = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finishAction = resolvePromise;
        }),
    );
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'system',
        actor: 'HQ',
        text: 'Version 0.10.35 is ready',
        ts: Date.now(),
        actionLabel: 'Update now',
        onopen,
        onaction,
      },
    });
    flushSync();

    const primary = host.querySelector<HTMLButtonElement>('.nr-primary-action')!;
    const action = host.querySelector<HTMLButtonElement>('.nr-open')!;

    primary.click();
    flushSync();
    expect(primary.disabled).toBe(true);
    expect(action.disabled).toBe(true);
    action.click();
    expect(onaction).not.toHaveBeenCalled();

    finishOpen();
    await vi.waitFor(() => {
      flushSync();
      expect(primary.disabled).toBe(false);
      expect(action.disabled).toBe(false);
    });

    action.click();
    flushSync();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(primary.disabled).toBe(true);
    expect(action.disabled).toBe(true);
    primary.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    finishAction();
    await vi.waitFor(() => {
      flushSync();
      expect(primary.disabled).toBe(false);
      expect(action.disabled).toBe(false);
    });
  });
});

// The "bounded Inbox chronology" cases that sat here mounted the tray
// popover's NotificationFeed, deleted in PL-07. The desktop Inbox owns the
// equivalent behaviour and covers it in
// packages/ui/src/inbox/NotificationsView.test.ts (load-more paging, page
// failure + retry, dismiss-without-marking-read) and
// packages/ui/src/inbox/notifications-model.test.ts (day grouping, badge caps).

describe('visual hierarchy polish: scoped surface contracts', () => {
  const row = read('src/components/NotificationRow.svelte');
  const quickPane = read('src/components/QuickWindowSidePane.svelte');

  it('caps the quick-window side pane without changing its unread semantics', () => {
    // The pane caps rendered conversations; the attention badge counts the
    // complete input so a capped rail cannot hide attention.
    expect(quickPane).toContain('countUnreadConversations(items, unreadIds, viewedIds)');
    expect(quickPane).toContain('conversationRows(items, unreadIds, viewedIds)');
  });
});
