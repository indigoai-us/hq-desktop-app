import { describe, it, expect, vi } from 'vitest';
import { safeUnlisten, ListenerRegistry } from './listener-registry';

/**
 * Reproduce Tauri's stale-map teardown crash (Sentry HQ-DESKTOP-39): an
 * unlisten handle that throws the exact `listeners[eventId].handlerId` TypeError
 * when the registration is already gone.
 */
function staleUnlisten(): () => never {
  return () => {
    throw new TypeError(
      "undefined is not an object (evaluating 'listeners[eventId].handlerId')",
    );
  };
}

/**
 * Tauri's event API types an unlisten handle as returning void, but the actual
 * handle delegates to its async `_unlisten` implementation. A stale-map error
 * therefore arrives as a rejected promise rather than a synchronous throw.
 */
function asyncStaleUnlisten(): () => Promise<never> {
  return async () => {
    throw new TypeError(
      "undefined is not an object (evaluating 'listeners[eventId].handlerId')",
    );
  };
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
