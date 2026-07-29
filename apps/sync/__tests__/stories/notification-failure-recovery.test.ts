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
const feedData = vi.hoisted(() => ({
  loadTimeline: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('../../src/lib/notificationFeedData', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/lib/notificationFeedData')>();
  return {
    ...actual,
    loadNotificationTimeline: feedData.loadTimeline,
  };
});

import { flushSync, mount, unmount } from 'svelte';
import NotificationFeed from '../../src/components/NotificationFeed.svelte';
import NotificationRow from '../../src/components/NotificationRow.svelte';

type MountedComponent = ReturnType<typeof mount>;
type FeedExports = { reload(): void };

interface TimelineItem {
  id: string;
  kind: 'new-file';
  actor: string;
  summary: string;
  ts: number;
  file: { company: string; path: string };
}

function item(id: string, summary: string): TimelineItem {
  return {
    id,
    kind: 'new-file',
    actor: 'Indigo',
    summary,
    ts: Date.now(),
    file: { company: 'indigo', path: `${id}.md` },
  };
}

function timeline(
  items: TimelineItem[],
  states: Partial<{
    historyState: 'resolved' | 'failed';
    activityState: 'resolved' | 'failed';
    updateState: 'resolved' | 'unchecked' | 'failed' | 'not-requested';
  }> = {},
) {
  return {
    items,
    historyState: states.historyState ?? 'resolved',
    activityState: states.activityState ?? 'resolved',
    updateState: states.updateState ?? 'resolved',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let host: HTMLDivElement;
let component: MountedComponent | null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
  tauri.listen.mockResolvedValue(vi.fn());
  feedData.loadTimeline.mockReset();
  vi.stubGlobal('localStorage', {
    length: 0,
    clear: vi.fn(),
    getItem: vi.fn(() => null),
    key: vi.fn(() => null),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  } satisfies Storage);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('NotificationFeed failure recovery', () => {
  it('renders an initial skeleton until the first notification timeline resolves', async () => {
    const hydration = deferred<ReturnType<typeof timeline>>();
    feedData.loadTimeline.mockReturnValueOnce(hydration.promise);

    component = mount(NotificationFeed, { target: host });
    flushSync();

    expect(
      host.querySelector('[aria-label="Loading notifications"]'),
    ).toBeTruthy();
    expect(host.querySelectorAll('.notif-skeleton-row')).toHaveLength(5);

    await vi.waitFor(() => {
      expect(feedData.loadTimeline).toHaveBeenCalledOnce();
    });
    hydration.resolve(timeline([item('initial', 'Initial retained activity')]));

    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Initial retained activity');
      expect(
        host.querySelector('[aria-label="Loading notifications"]'),
      ).toBeNull();
    });
  });

  it('retains rendered content and exposes Retry when a refresh rejects', async () => {
    feedData.loadTimeline
      .mockResolvedValueOnce(timeline([item('retained', 'Retained activity')]))
      .mockRejectedValueOnce(new Error('refresh unavailable'))
      .mockResolvedValueOnce(timeline([item('recovered', 'Recovered activity')]));

    component = mount(NotificationFeed, { target: host });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Retained activity');
    });

    (component as unknown as FeedExports).reload();

    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Retained activity');
      expect(host.textContent).toContain(
        'Could not refresh notifications. Showing the last available activity.',
      );
    });

    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    );
    expect(retry).toBeTruthy();
    retry!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(feedData.loadTimeline).toHaveBeenCalledTimes(3);
      expect(host.textContent).toContain('Recovered activity');
      expect(host.textContent).not.toContain('Could not refresh notifications.');
    });
  });

  it('keeps available notifications visible beside a retryable partial-load warning', async () => {
    feedData.loadTimeline
      .mockResolvedValueOnce(
        timeline([item('trusted', 'Trusted local activity')], {
          historyState: 'failed',
        }),
      )
      .mockResolvedValueOnce(timeline([item('trusted', 'Trusted local activity')]));

    component = mount(NotificationFeed, { target: host });

    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Trusted local activity');
      expect(host.textContent).toContain(
        'cloud notifications could not be loaded',
      );
    });

    const alert = host.querySelector<HTMLElement>('.notif-partial-error');
    const retry = alert?.querySelector<HTMLButtonElement>('button');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(retry?.textContent?.trim()).toBe('Retry');
    retry!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(feedData.loadTimeline).toHaveBeenCalledTimes(2);
      expect(host.querySelector('.notif-partial-error')).toBeNull();
      expect(host.textContent).toContain('Trusted local activity');
    });
  });
});

describe('NotificationRow reaction failure recovery', () => {
  it('exposes and runs a message secondary action from the expanded footer', async () => {
    const onaction = vi.fn().mockResolvedValue(undefined);

    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'message',
        actor: 'Maya',
        text: 'Use the attached prompt.',
        ts: Date.now(),
        onopen: vi.fn(),
        onaction,
        actionLabel: 'Copy prompt',
      },
    });
    flushSync();

    const row = host.querySelector<HTMLElement>(
      '[data-testid="notification-row"]',
    )!;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();

    const action = row.querySelector<HTMLButtonElement>(
      '[data-testid="notification-message-action"]',
    );
    expect(action?.textContent?.trim()).toBe('Copy prompt');
    action!.click();

    await vi.waitFor(() => {
      expect(onaction).toHaveBeenCalledOnce();
    });
  });

  it('exposes Retry after rejection and retries the same emoji', async () => {
    const onreact = vi
      .fn()
      .mockRejectedValueOnce(new Error('reaction unavailable'))
      .mockResolvedValueOnce(undefined);

    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'message',
        actor: 'Maya',
        text: 'Ready to ship?',
        ts: Date.now(),
        onreact,
      },
    });
    flushSync();

    const row = host.querySelector<HTMLElement>(
      '[data-testid="notification-row"]',
    )!;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();
    row.querySelector<HTMLButtonElement>('[aria-label="React with 👍"]')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(row.querySelector('[role="alert"]')?.textContent).toContain(
        'Couldn’t add that reaction.',
      );
    });

    const retry = row.querySelector<HTMLButtonElement>(
      '[role="alert"] .nr-retry',
    );
    expect(retry?.textContent?.trim()).toBe('Retry');
    retry!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(onreact).toHaveBeenCalledTimes(2);
      expect(onreact).toHaveBeenNthCalledWith(1, '👍');
      expect(onreact).toHaveBeenNthCalledWith(2, '👍');
      expect(row.querySelector('[role="alert"]')).toBeNull();
    });
  });
});
