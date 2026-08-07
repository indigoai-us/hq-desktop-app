// @vitest-environment happy-dom
//
// HQ-DESKTOP-39 artifact E2E: mount the real surfaces, then tear them down
// against Tauri handles that fail exactly as the stale event-plugin map does.
//
// The window double models @tauri-apps/api 2.11.1 faithfully, because the shape
// of the handle is the entire bug:
//
//   - `listen()` resolves to `async () => _unlisten(event, eventId)`, a handle
//     that RETURNS its rejecting promise, so a caller can contain it.
//   - `onFocusChanged()` resolves to a SYNCHRONOUS composite
//     `() => { unlistenFocus(); unlistenBlur(); }` which evaluates to
//     `undefined` and drops both inner promises inside the framework closure.
//
// The previous version of this spec mocked `onFocusChanged` as
// `async () => staleUnlisten()` — a handle that returns its own rejection.
// That shape is containable by `safeUnlisten`, so the spec certified a fix that
// production kept failing against. The composite is still offered here so this
// spec goes red if a surface reaches for it again.
//
// Two harness details this spec depends on, both verified on vitest 4.1.9:
//   - stale handles are plain async functions, never `vi.fn()`. Vitest's spy
//     attaches its own continuation to record settled results, which marks a
//     rejected promise as HANDLED — `process.on('unhandledRejection')` then
//     never fires and the "leaks nothing" assertion passes vacuously.
//   - a discarded rejection is reported within one macrotask, so teardown is
//     drained with real timers before asserting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const STALE_MAP_ERROR =
  "undefined is not an object (evaluating 'listeners[eventId].handlerId')";

const WINDOW_FOCUS_EVENT = 'tauri://focus';
const WINDOW_BLUR_EVENT = 'tauri://blur';

type TeardownMode = 'async-reject' | 'sync-throw';

interface StaleHandle {
  (): Promise<never> | never;
  calls: number;
}

const unlistenHandles: StaleHandle[] = [];
/** Event names the surface registered directly on the window instance. */
const windowListenEvents: string[] = [];
/** Set when a surface reaches for the discarding framework composite. */
let compositeUsed = false;
let teardownMode: TeardownMode = 'async-reject';

/** A `listen()`-shaped handle: it hands its stale-map failure back to the caller. */
function staleUnlisten(): StaleHandle {
  const handle = (() => {
    handle.calls += 1;
    const error = new TypeError(STALE_MAP_ERROR);
    if (teardownMode === 'sync-throw') throw error;
    return Promise.reject(error);
  }) as StaleHandle;
  handle.calls = 0;
  unlistenHandles.push(handle);
  return handle;
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
    // The decomposed path the fix uses.
    listen: async (event: string) => {
      windowListenEvents.push(event);
      return staleUnlisten();
    },
    // The framework composite: returns undefined, discards both inner promises.
    onFocusChanged: async () => {
      compositeUsed = true;
      const focus = staleUnlisten();
      const blur = staleUnlisten();
      return () => {
        focus();
        blur();
      };
    },
    setSize: vi.fn(),
  }),
}));

// Compile the surfaces once during suite collection. Under full-suite parallel
// load, a cold Svelte import can exceed the per-test timeout even though the
// teardown churn itself takes only milliseconds.
const { default: Popover } = await import('../../src/components/Popover.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;
let originalResizeObserver: typeof ResizeObserver | undefined;
let unhandled: unknown[] = [];
let onUnhandledRejection: ((reason: unknown) => void) | null = null;
let warn: ReturnType<typeof vi.spyOn> | null = null;

/** Let registration promises settle, then let Node report any escaped rejection. */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  unlistenHandles.length = 0;
  windowListenEvents.length = 0;
  compositeUsed = false;
  teardownMode = 'async-reject';
  unhandled = [];
  onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
  // Drain before detaching the capture so a late rejection cannot bleed into
  // the next test's assertions.
  await drain();
  if (onUnhandledRejection) {
    process.off('unhandledRejection', onUnhandledRejection);
    onUnhandledRejection = null;
  }
  host?.remove();
  host = null;
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: originalResizeObserver,
    });
  } else {
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
  warn = null;
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
      for (let cycle = 0; cycle < 3; cycle += 1) {
        component = mount(Popover, {
          target: host!,
          props: {
            syncState: 'idle',
            config: null,
            onsync: vi.fn(),
          },
        });
        flushSync();
        // The focus subscription now awaits two registrations, so give the
        // mount a real tick to finish wiring before tearing it down.
        await drain();

        await unmount(component);
        component = null;
      }
      await drain();

      // Popover owns its focus pair plus a `popover:opened` listener, and its
      // real NotificationFeed child owns further native listeners.
      expect(unlistenHandles.length).toBeGreaterThanOrEqual(6);
      for (const handle of unlistenHandles) {
        expect(handle.calls).toBe(1);
      }
      // The point of the fix: nothing escaped, and every failure was reported
      // through the shared boundary rather than never having been produced.
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(unlistenHandles.length);
    },
  );

  it('registers focus and blur separately instead of the discarding composite', async () => {
    // Proves the containment above is structural rather than incidental: the
    // popover never asks the framework for a handle it cannot contain.
    component = mount(Popover, {
      target: host!,
      props: { syncState: 'idle', config: null, onsync: vi.fn() },
    });
    flushSync();
    await drain();

    expect(windowListenEvents).toContain(WINDOW_FOCUS_EVENT);
    expect(windowListenEvents).toContain(WINDOW_BLUR_EVENT);
    expect(compositeUsed).toBe(false);

    await unmount(component);
    component = null;
    await drain();

    expect(unhandled).toEqual([]);
  });
});
