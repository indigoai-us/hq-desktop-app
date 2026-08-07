import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Tauri API mocks ───────────────────────────────────────────────────────────
//
// `library-refresh.ts` wires two refresh signals:
//   - the desktop window regaining focus, and
//   - `listen('sync:complete', ...)` (a sync finished).
// We capture both registered handlers so a test can fire a synthetic focus /
// sync event straight at the real consumer, and we hand back spy unlisten fns so
// the teardown path is observable.
//
// The window double models @tauri-apps/api 2.11.1 FAITHFULLY, because the shape
// of the handle is the whole bug (Sentry HQ-DESKTOP-39):
//
//   - `listen()` resolves to `async () => _unlisten(event, eventId)` — a handle
//     that RETURNS its rejecting promise, so a caller can contain it.
//   - `onFocusChanged()` awaits two `listen()` registrations and resolves to a
//     SYNCHRONOUS composite `() => { unlistenFocus(); unlistenBlur(); }`, which
//     evaluates to `undefined` and drops both inner promises on the floor. No
//     app-side wrapper can reach them — they are created inside the framework
//     closure — so a stale-map rejection from either escapes as an unhandled
//     rejection.
//
// A previous regression suite mocked `onFocusChanged` as a handle that returned
// its own rejected promise. That double is containable, so it certified a fix
// that production kept failing against. Both shapes are provided here on
// purpose: whichever registration path the consumer picks, the teardown must
// leak nothing.

const STALE_MAP_ERROR =
  "undefined is not an object (evaluating 'listeners[eventId].handlerId')";

const WINDOW_FOCUS_EVENT = 'tauri://focus';
const WINDOW_BLUR_EVENT = 'tauri://blur';

type EventHandler = (event: { payload: unknown }) => void;
type FocusHandler = (event: { payload: boolean }) => void;

interface StaleHandle {
  (): Promise<never>;
  calls: number;
}

/**
 * A `listen()`-shaped handle whose stale-map failure arrives as a rejection.
 *
 * Deliberately NOT a `vi.fn()`. Vitest's spy attaches its own continuation to
 * whatever the implementation returns so it can record settled results, which
 * marks a rejected promise as HANDLED — `process.on('unhandledRejection')` then
 * never fires and any "leaks nothing" assertion built on a spy passes
 * vacuously. Verified on vitest 4.1.9: a discarded rejection from a plain async
 * function is reported, the identical rejection from `vi.fn(async …)` is not.
 * Call counts are tracked by hand for the same reason.
 */
function staleAsyncHandle(): StaleHandle {
  const handle = (async () => {
    handle.calls += 1;
    throw new TypeError(STALE_MAP_ERROR);
  }) as StaleHandle;
  handle.calls = 0;
  return handle;
}

const eventHandlers = new Map<string, EventHandler>();
const windowHandlers = new Map<string, EventHandler>();
/** Every handle the window double has issued, in registration order. */
let windowHandles: StaleHandle[] = [];
const unlistenEvent = vi.fn();
let focusHandler: FocusHandler | undefined;

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: EventHandler) => {
    eventHandlers.set(name, handler);
    return Promise.resolve(unlistenEvent);
  }),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    // The decomposed path the fix uses: one real registration per event.
    listen: (name: string, handler: EventHandler) => {
      windowHandlers.set(name, handler);
      const handle = staleAsyncHandle();
      windowHandles.push(handle);
      return Promise.resolve(handle);
    },
    // The composite path the framework offers — kept faithful so this suite
    // fails if the consumer ever goes back to it.
    onFocusChanged: (handler: FocusHandler) => {
      focusHandler = handler;
      const focus = staleAsyncHandle();
      const blur = staleAsyncHandle();
      windowHandles.push(focus, blur);
      return Promise.resolve(() => {
        focus();
        blur();
      });
    },
  }),
}));

import { subscribeLibraryRefresh } from './library-refresh';

function fireFocus(focused: boolean): void {
  // Prefer whichever registration path the consumer actually took.
  const decomposed = windowHandlers.get(
    focused ? WINDOW_FOCUS_EVENT : WINDOW_BLUR_EVENT,
  );
  if (decomposed) {
    decomposed({ payload: null });
    return;
  }
  if (!focusHandler) throw new Error('focus handler not registered');
  focusHandler({ payload: focused });
}

function fireSyncComplete(): void {
  const handler = eventHandlers.get('sync:complete');
  if (!handler) throw new Error('sync:complete listener not registered');
  handler({ payload: {} });
}

describe('subscribeLibraryRefresh', () => {
  beforeEach(() => {
    eventHandlers.clear();
    windowHandlers.clear();
    windowHandles = [];
    focusHandler = undefined;
    unlistenEvent.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes when the window regains focus', async () => {
    const onRefresh = vi.fn();
    await subscribeLibraryRefresh(onRefresh);

    fireFocus(true);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does NOT refresh when the window loses focus', async () => {
    const onRefresh = vi.fn();
    await subscribeLibraryRefresh(onRefresh);

    fireFocus(false);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('refreshes when a sync completes', async () => {
    const onRefresh = vi.fn();
    await subscribeLibraryRefresh(onRefresh);

    fireSyncComplete();

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes once per signal (focus + sync are independent)', async () => {
    const onRefresh = vi.fn();
    await subscribeLibraryRefresh(onRefresh);

    fireFocus(true);
    fireSyncComplete();
    fireFocus(true);

    expect(onRefresh).toHaveBeenCalledTimes(3);
  });

  it('tears down both subscriptions on unlisten', async () => {
    const onRefresh = vi.fn();
    const unlisten = await subscribeLibraryRefresh(onRefresh);

    unlisten();

    expect(windowHandles.length).toBeGreaterThanOrEqual(1);
    for (const handle of windowHandles) {
      expect(handle.calls).toBe(1);
    }
    expect(unlistenEvent).toHaveBeenCalledTimes(1);
  });

  it('leaks no unhandled rejection when a stale focus teardown fails', async () => {
    // The production failure (HQ-DESKTOP-39): the webview's per-event listener
    // map has already been reset, so Tauri's injected `unregisterListener`
    // throws `listeners[eventId].handlerId` inside the async `_unlisten`. Every
    // focus handle this surface owns must have that rejection contained.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const unlisten = await subscribeLibraryRefresh(vi.fn());

      unlisten();
      unlisten();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      // Contained, not merely never created: every stale handle ran once and
      // reported through the shared teardown boundary.
      expect(windowHandles.length).toBeGreaterThanOrEqual(1);
      for (const handle of windowHandles) {
        expect(handle.calls).toBe(1);
      }
      expect(warn).toHaveBeenCalledTimes(windowHandles.length);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warn.mockRestore();
    }
  });
});
