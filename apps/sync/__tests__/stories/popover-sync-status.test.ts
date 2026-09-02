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
  windowListen: vi.fn(),
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
    listen: tauri.windowListen,
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

let host: HTMLDivElement;
let component: MountedComponent | null;

function mountPopover(props: Record<string, unknown> = {}): HTMLElement {
  component = mount(Popover, {
    target: host,
    props: {
      syncState: 'syncing',
      config: null,
      onsync: vi.fn(),
      messagesUnreadCount: 0,
      syncFilesProgressed: 97,
      syncPlanTotalFiles: 97,
      syncTotalFiles: 97,
      fanoutTotal: 1,
      fanoutDoneCount: 0,
      companies: [{ uid: 'personal', slug: 'personal', name: 'Personal' }],
      progress: { company: 'personal', path: 'notes.md', bytes: 1 },
      ...props,
    },
  });
  flushSync();
  return host;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
  tauri.unlisten.mockReset();
  tauri.windowListen.mockReset();
  tauri.onFocusChanged.mockReset();
  tauri.setSize.mockReset();
  feedData.loadTimeline.mockReset();
  tauri.listen.mockResolvedValue(tauri.unlisten);
  tauri.windowListen.mockResolvedValue(tauri.unlisten);
  tauri.onFocusChanged.mockResolvedValue(tauri.unlisten);
  feedData.loadTimeline.mockResolvedValue({
    items: [],
    historyState: 'resolved',
    activityState: 'resolved',
    updateState: 'resolved',
  });
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_sync_status') {
      return {
        lastSyncAt: new Date().toISOString(),
        pendingFiles: 0,
        conflicts: 0,
        daemonRunning: true,
        source: 'test',
      };
    }
    throw new Error(`Unexpected invoke: ${command}`);
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('popover compact sync status', () => {
  it('keeps the status + transferred counter and does not render a progress bar', () => {
    mountPopover();

    const status = host.querySelector('[data-testid="popover-status-row"]');
    expect(status).toBeTruthy();
    expect(status?.textContent).toContain('Syncing');
    expect(status?.textContent).toContain('97 of 97 transferred');
    expect(host.querySelector('[data-testid="popover-sync-sublabel"]')?.textContent).toBe(
      'Syncing Personal',
    );

    expect(host.querySelector('.mbp-progress-track')).toBeNull();
    expect(status?.querySelector('[role="progressbar"]')).toBeNull();
    expect(status?.querySelector('[style*="width:"]')).toBeNull();
  });
});
