import { describe, expect, it, vi } from 'vitest';

import {
  ListenerRegistry,
  safeUnlisten,
  subscribeWindowFocus,
} from '../../src/lib/listener-registry';

describe('HQ-DESKTOP-39: late main-window listener cleanup', () => {
  it('unlistens handles that resolve after the surface is disposed', () => {
    const registry = new ListenerRegistry();
    registry.dispose();
    const late = vi.fn();

    registry.push(late);

    expect(late).toHaveBeenCalledTimes(1);
  });

  it('tears every handle down through a throw-safe, idempotent unlisten', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inner = vi.fn(() => {
      throw new TypeError(
        "undefined is not an object (evaluating 'listeners[eventId].handlerId')",
      );
    });
    const safe = safeUnlisten(inner);

    expect(() => safe()).not.toThrow();
    expect(() => safe()).not.toThrow();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('contains a rejected unlisten promise instead of throwing it to the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const safe = safeUnlisten(async () => {
      throw new Error('stale map');
    });

    expect(() => safe()).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('registers focus and blur itself and tears both handles down once', async () => {
    const unlistens = { focus: vi.fn(), blur: vi.fn() };
    const events: string[] = [];
    const win = {
      onFocusChanged() {
        throw new Error('composite onFocusChanged must not be used');
      },
      listen: vi.fn(async (event: string) => {
        events.push(event);
        return event.endsWith('focus') ? unlistens.focus : unlistens.blur;
      }),
    };

    const teardown = await subscribeWindowFocus(win, () => {});
    teardown();
    teardown();

    expect(events).toEqual(['tauri://focus', 'tauri://blur']);
    expect(unlistens.focus).toHaveBeenCalledTimes(1);
    expect(unlistens.blur).toHaveBeenCalledTimes(1);
  });
});
