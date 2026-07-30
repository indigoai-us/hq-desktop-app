// @vitest-environment happy-dom
//
// HQ-DESKTOP-39 artifact E2E: mount the real popover, then tear it down against
// a Tauri handle that rejects exactly as the stale event-plugin map does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const STALE_MAP_ERROR =
  "undefined is not an object (evaluating 'listeners[eventId].handlerId')";

type TeardownMode = 'async-reject' | 'sync-throw';

const unlistenHandles: Array<ReturnType<typeof vi.fn>> = [];
let teardownMode: TeardownMode = 'async-reject';

function staleUnlisten(): ReturnType<typeof vi.fn> {
  const unlisten = vi.fn(() => {
    const error = new TypeError(STALE_MAP_ERROR);
    if (teardownMode === 'sync-throw') throw error;
    return Promise.reject(error);
  });
  unlistenHandles.push(unlisten);
  return unlisten;
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'get_sync_status') {
      return {
        lastSyncAt: null,
        pendingFiles: 0,
        conflicts: 0,
        daemonRunning: true,
        source: 'test',
      };
    }
    return undefined;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => staleUnlisten()),
}));

vi.mock('@tauri-apps/api/window', () => ({
  LogicalSize: class LogicalSize {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
  },
  getCurrentWindow: () => ({
    onFocusChanged: async () => staleUnlisten(),
    setSize: vi.fn(),
  }),
}));

let host: HTMLElement;
let component: Record<string, unknown> | null = null;
let originalResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  unlistenHandles.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  originalResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
  });
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: originalResizeObserver,
    });
  } else {
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
  vi.restoreAllMocks();
});

describe('HQ-DESKTOP-39: popover stale Tauri listener teardown', () => {
  it.each([
    ['an async rejection', 'async-reject'],
    ['a synchronous throw', 'sync-throw'],
  ] as const)(
    'contains %s across repeated real popover mount/unmount churn',
    async (_label, mode) => {
      teardownMode = mode;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        const { default: Popover } = await import('../../src/components/Popover.svelte');
        for (let cycle = 0; cycle < 3; cycle += 1) {
          component = mount(Popover, {
            target: host,
            props: {
              syncState: 'idle',
              config: null,
              onsync: vi.fn(),
            },
          });
          flushSync();
          await Promise.resolve();
          await Promise.resolve();

          await unmount(component);
          component = null;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        // Popover owns two listeners and its real NotificationFeed child owns
        // additional native listeners. Every mounted handle must be released.
        expect(unlistenHandles.length).toBeGreaterThanOrEqual(6);
        for (const unlisten of unlistenHandles) {
          expect(unlisten).toHaveBeenCalledTimes(1);
        }
        expect(unhandled).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(unlistenHandles.length);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        warn.mockRestore();
      }
    },
  );
});
