// @vitest-environment happy-dom
//
// HQ-DESKTOP-39 artifact E2E: mount the real popover, then tear it down against
// a Tauri handle that rejects exactly as the stale event-plugin map does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const STALE_MAP_ERROR =
  "undefined is not an object (evaluating 'listeners[eventId].handlerId')";

const unlistenHandles: Array<() => Promise<never>> = [];

function staleUnlisten(): () => Promise<never> {
  const unlisten = async () => {
    throw new TypeError(STALE_MAP_ERROR);
  };
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
  it('does not emit an unhandled rejection when the real popover unmounts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const { default: Popover } = await import('../../src/components/Popover.svelte');
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
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Popover owns two listeners and its real NotificationFeed child owns
      // additional native listeners. Every mounted handle must be released.
      expect(unlistenHandles.length).toBeGreaterThanOrEqual(2);
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(unlistenHandles.length);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warn.mockRestore();
    }
  });
});
