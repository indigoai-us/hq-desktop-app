import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { registerChannelUnreadListeners, type ListenPayload } from './channelUnreadListeners';

describe('channel unread event listeners', () => {
  function setup() {
    const handlers = new Map<string, (payload: unknown) => void>();
    const listen: ListenPayload = async (eventName, handler) => {
      handlers.set(eventName, handler);
      return () => {};
    };
    const applyChannelUnread = vi.fn();
    const refreshSnapshot = vi.fn();
    return { handlers, listen, applyChannelUnread, refreshSnapshot };
  }

  it('wires App.svelte through the guarded channel unread listeners', () => {
    const appSource = readFileSync(new URL('../App.svelte', import.meta.url), 'utf8');

    expect(appSource).toContain('registerChannelUnreadListeners(');
    expect(appSource).not.toContain('applyChannelUnread(e.payload.channelId, e.payload.unread)');
  });

  it('unlistens the unread handler if channel:updated registration fails', async () => {
    const deps = setup();
    const unlistenUnreadChanged = vi.fn();
    deps.listen = async (eventName, handler) => {
      if (eventName === 'channel:updated') {
        throw new Error('channel:updated registration failed');
      }
      deps.handlers.set(eventName, handler);
      return unlistenUnreadChanged;
    };

    await expect(registerChannelUnreadListeners(deps)).rejects.toThrow(
      'channel:updated registration failed',
    );
    expect(unlistenUnreadChanged).toHaveBeenCalledTimes(1);
  });

  it('refetches the unread snapshot for a payload-less invalidation instead of leaving a stale badge', async () => {
    const deps = setup();
    await registerChannelUnreadListeners(deps);

    const unreadChanged = deps.handlers.get('channel:unread-changed');
    expect(unreadChanged).toBeDefined();
    unreadChanged?.(null);

    expect(deps.refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.applyChannelUnread).not.toHaveBeenCalled();
  });

  it('refetches when an unread update omits its channel id or count', async () => {
    const deps = setup();
    await registerChannelUnreadListeners(deps);

    const unreadChanged = deps.handlers.get('channel:unread-changed');
    expect(unreadChanged).toBeDefined();
    unreadChanged?.({ unread: 2 });
    unreadChanged?.({ channelId: 'chn_eng', unread: -1 });

    expect(deps.refreshSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.applyChannelUnread).not.toHaveBeenCalled();
  });

  it('applies a valid unread update without a snapshot fetch', async () => {
    const deps = setup();
    await registerChannelUnreadListeners(deps);

    const unreadChanged = deps.handlers.get('channel:unread-changed');
    expect(unreadChanged).toBeDefined();
    unreadChanged?.({ channelId: 'chn_eng', unread: 4 });

    expect(deps.applyChannelUnread).toHaveBeenCalledWith('chn_eng', 4);
    expect(deps.refreshSnapshot).not.toHaveBeenCalled();
  });

  it('refetches for malformed channel:updated events and applies complete updates', async () => {
    const deps = setup();
    await registerChannelUnreadListeners(deps);

    const channelUpdated = deps.handlers.get('channel:updated');
    expect(channelUpdated).toBeDefined();
    channelUpdated?.(null);
    channelUpdated?.({ channelId: 'chn_eng' });
    channelUpdated?.({ channelId: 'chn_eng', unread: 1 });

    expect(deps.refreshSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.applyChannelUnread).toHaveBeenCalledWith('chn_eng', 1);
  });
});
