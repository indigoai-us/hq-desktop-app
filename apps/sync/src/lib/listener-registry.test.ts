import { describe, it, expect, vi } from 'vitest';
// NOTE: this suite must NOT mock `@tauri-apps/api/event` — it pins the module's
// hard-coded focus/blur event names against the real package.
import { TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
import {
  safeUnlisten,
  subscribeWindowFocus,
  ListenerRegistry,
  type FocusListenableWindow,
  type WindowFocusEvent,
} from './listener-registry';

const STALE_MAP_ERROR =
  "undefined is not an object (evaluating 'listeners[eventId].handlerId')";

/**
 * Reproduce Tauri's stale-map teardown crash (Sentry HQ-DESKTOP-39): an
 * unlisten handle that throws the exact `listeners[eventId].handlerId` TypeError
 * when the registration is already gone.
 */
function staleUnlisten(): () => never {
  return () => {
    throw new TypeError(STALE_MAP_ERROR);
  };
}

/**
 * Tauri's event API types an unlisten handle as returning void, but the actual
 * handle delegates to its async `_unlisten` implementation. A stale-map error
 * therefore arrives as a rejected promise rather than a synchronous throw.
 *
 * Deliberately a plain async function, never a `vi.fn()`: vitest's spy attaches
 * its own continuation so it can record settled results, which marks a rejected
 * promise as HANDLED. An escape assertion built on a spy passes vacuously.
 */
function asyncStaleUnlisten(): () => Promise<never> {
  return async () => {
    throw new TypeError(STALE_MAP_ERROR);
  };
}

interface CountedHandle {
  (): Promise<never>;
  calls: number;
}

/** A `listen()`-shaped stale handle that counts its own invocations. */
function countedStaleHandle(): CountedHandle {
  const handle = (async () => {
    handle.calls += 1;
    throw new TypeError(STALE_MAP_ERROR);
  }) as CountedHandle;
  handle.calls = 0;
  return handle;
}

/** Drain enough turns for Node to report any genuinely unhandled rejection. */
async function drainRejections(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface FakeWindow extends FocusListenableWindow {
  registrations: string[];
  handles: CountedHandle[];
  fire(event: string): void;
}

/** A window double whose `listen()` matches @tauri-apps/api's real handle shape. */
function fakeWindow(options: { failOn?: string } = {}): FakeWindow {
  const handlers = new Map<string, (event: unknown) => void>();
  const win: FakeWindow = {
    registrations: [],
    handles: [],
    listen(event: string, handler: (event: never) => void) {
      if (options.failOn === event) {
        return Promise.reject(new Error(`listen failed: ${event}`));
      }
      win.registrations.push(event);
      handlers.set(event, handler as (event: unknown) => void);
      const handle = countedStaleHandle();
      win.handles.push(handle);
      return Promise.resolve(handle as unknown as UnlistenFn);
    },
    fire(event: string) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for ${event}`);
      handler({ event, id: 7, payload: null });
    },
  };
  return win;
}

describe('safeUnlisten', () => {
  it('absorbs the async stale-map rejection without emitting an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      safeUnlisten(asyncStaleUnlisten())();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warn.mockRestore();
    }
  });

  it('does not throw when the underlying unlisten throws the stale-map TypeError', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const safe = safeUnlisten(staleUnlisten());
    // Old behavior: this call threw and aborted the caller's teardown.
    expect(() => safe()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('invokes the underlying handle at most once (idempotent double teardown)', () => {
    const inner = vi.fn();
    const safe = safeUnlisten(inner);
    safe();
    safe();
    safe();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('shares one wrapper when the same underlying handle is registered twice', () => {
    const inner = vi.fn();
    const first = safeUnlisten(inner);
    const second = safeUnlisten(inner);

    first();
    second();

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null/undefined handle', () => {
    expect(() => safeUnlisten(null)()).not.toThrow();
    expect(() => safeUnlisten(undefined)()).not.toThrow();
  });
});

describe('ListenerRegistry', () => {
  it('releases every handle when a middle teardown rejects asynchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const reg = new ListenerRegistry();
      const before = vi.fn();
      const after = vi.fn();
      reg.push(before, asyncStaleUnlisten(), after);

      expect(() => reg.dispose()).not.toThrow();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(before).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warn.mockRestore();
    }
  });

  it('releases every handle even when one throws the stale-map TypeError', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new ListenerRegistry();
    const before = vi.fn();
    const after = vi.fn();

    // A throwing handle sits between two healthy ones. Old code did
    // `handlers.forEach((u) => u())` — the throw aborted the loop, so `after`
    // never ran and the exception escaped dispose() and crashed the surface.
    reg.push(before, staleUnlisten(), after);

    expect(() => reg.dispose()).not.toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is idempotent: dispose twice tears each handle down once', () => {
    const reg = new ListenerRegistry();
    const a = vi.fn();
    reg.push(a);
    reg.dispose();
    reg.dispose();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('unlistens immediately for a handle pushed after disposal (late-resolving registration)', () => {
    const reg = new ListenerRegistry();
    reg.dispose();
    const late = vi.fn();
    reg.push(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('does not crash when a late-pushed handle throws the stale-map TypeError', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new ListenerRegistry();
    reg.dispose();
    expect(() => reg.push(staleUnlisten())).not.toThrow();
    warn.mockRestore();
  });
});

describe('subscribeWindowFocus', () => {
  it('subscribes to the same two window events Tauri uses for focus changes', async () => {
    const win = fakeWindow();
    await subscribeWindowFocus(win, vi.fn());

    // Pinned to the real package: an upstream rename must fail here rather
    // than silently subscribing to an event that is never emitted.
    expect(win.registrations).toEqual([
      TauriEvent.WINDOW_FOCUS,
      TauriEvent.WINDOW_BLUR,
    ]);
  });

  it('registers on the passed window so a secondary window only hears itself', async () => {
    const main = fakeWindow();
    const detail = fakeWindow();
    await subscribeWindowFocus(detail, vi.fn());

    // `Window.listen` applies its own `{ kind: 'Window', label }` target, so
    // using the instance is what keeps per-window focus scoped.
    expect(detail.registrations).toHaveLength(2);
    expect(main.registrations).toEqual([]);
  });

  it('forwards focus as payload true and blur as payload false', async () => {
    const win = fakeWindow();
    const seen: WindowFocusEvent[] = [];
    await subscribeWindowFocus(win, (event) => seen.push(event));

    win.fire(TauriEvent.WINDOW_FOCUS);
    win.fire(TauriEvent.WINDOW_BLUR);

    expect(seen.map((event) => event.payload)).toEqual([true, false]);
    // The rest of the Tauri event is preserved, exactly as `onFocusChanged` did.
    expect(seen[0]).toMatchObject({ event: TauriEvent.WINDOW_FOCUS, id: 7 });
    expect(seen[1]).toMatchObject({ event: TauriEvent.WINDOW_BLUR, id: 7 });
  });

  it('contains both stale-map rejections on teardown and stays idempotent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const win = fakeWindow();
      const unlisten = await subscribeWindowFocus(win, vi.fn());

      expect(() => {
        unlisten();
        unlisten();
      }).not.toThrow();
      await drainRejections();

      expect(unhandled).toEqual([]);
      // Both inner handles ran exactly once — contained, not merely skipped.
      expect(win.handles.map((handle) => handle.calls)).toEqual([1, 1]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warn.mockRestore();
    }
  });

  it('releases the focus handle when the blur registration fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const win = fakeWindow({ failOn: TauriEvent.WINDOW_BLUR });

      await expect(subscribeWindowFocus(win, vi.fn())).rejects.toThrow(
        'listen failed',
      );
      await drainRejections();

      // Half a subscription is a leak: focus must be torn down, safely.
      expect(win.handles).toHaveLength(1);
      expect(win.handles[0].calls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warn.mockRestore();
    }
  });
});

describe('why subscribeWindowFocus exists (containment boundary)', () => {
  /**
   * `Window.onFocusChanged` resolves to a SYNCHRONOUS composite:
   *
   *   () => { unlistenFocus(); unlistenBlur(); }
   *
   * Both inner handles are async, so the arrow discards two rejecting promises
   * and evaluates to `undefined`.
   */
  function onFocusChangedComposite(inner: Array<() => Promise<never>>): () => void {
    return () => {
      for (const unlisten of inner) unlisten();
    };
  }

  it('proves safeUnlisten cannot contain a handle that discards its own promises', async () => {
    // This is the recurrence mechanism for HQ-DESKTOP-39: two shipped fixes
    // wrapped the composite in `safeUnlisten` and production kept reporting the
    // rejection, because a handle returning `undefined` gives the wrapper
    // nothing to catch. Locked in so nobody "simplifies" subscribeWindowFocus
    // back into a wrapped onFocusChanged.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const composite = onFocusChangedComposite([
        asyncStaleUnlisten(),
        asyncStaleUnlisten(),
      ]);

      // The wrapper runs, throws nothing, and logs nothing...
      expect(() => safeUnlisten(composite)()).not.toThrow();
      await drainRejections();

      // ...yet both stale-map rejections escaped the app entirely.
      expect(unhandled).toHaveLength(2);
      for (const reason of unhandled) {
        expect(reason).toBeInstanceOf(TypeError);
        expect((reason as TypeError).message).toBe(STALE_MAP_ERROR);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      warn.mockRestore();
    }
  });
});
