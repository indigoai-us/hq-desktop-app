import { describe, expect, it, vi } from 'vitest';
import { BannerActionRouter, type BannerActionEvent } from './bannerActionRouter';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('BannerActionRouter', () => {
  it('registers the listener before readiness and retries setup failures', async () => {
    const order: string[] = [];
    const unlistenAfterFailedReady = vi.fn();
    const liveUnlisten = vi.fn();
    let listenAttempts = 0;
    let readyAttempts = 0;
    const listen = vi.fn(async () => {
      listenAttempts += 1;
      order.push(`listen:${listenAttempts}`);
      if (listenAttempts === 1) throw new Error('webview warming up');
      return listenAttempts === 2 ? unlistenAfterFailedReady : liveUnlisten;
    });
    const invoke = vi.fn(async (command: string) => {
      order.push(command);
      if (command === 'banner_action_router_ready') {
        readyAttempts += 1;
        if (readyAttempts === 1) throw new Error('backend warming up');
      }
    });
    const router = new BannerActionRouter({
      listen,
      invoke,
      execute: vi.fn(),
      retryDelay: async () => {},
    });

    await router.start();

    expect(listen).toHaveBeenCalledTimes(3);
    expect(unlistenAfterFailedReady).toHaveBeenCalledOnce();
    expect(order.indexOf('listen:3')).toBeLessThan(
      order.lastIndexOf('banner_action_router_ready'),
    );

    await router.dispose();
    expect(invoke).toHaveBeenCalledWith('banner_action_router_not_ready');
    expect(liveUnlisten).toHaveBeenCalledOnce();
  });

  it('ACKs concurrent out-of-order actions with their original request ids', async () => {
    let listener:
      | ((event: { payload: BannerActionEvent }) => void | Promise<void>)
      | undefined;
    const first = deferred<void>();
    const second = deferred<void>();
    const execute = vi.fn((event: BannerActionEvent) =>
      event.requestId === 'request-1' ? first.promise : second.promise,
    );
    const invoke = vi.fn().mockResolvedValue(undefined);
    const router = new BannerActionRouter({
      listen: async (_event, handler) => {
        listener = handler;
        return () => {};
      },
      invoke,
      execute,
      retryDelay: async () => {},
    });
    await router.start();

    const event1: BannerActionEvent = {
      requestId: 'request-1',
      kind: 'meeting',
      action: 'record',
      data: { windowId: 'window-1' },
    };
    const event2: BannerActionEvent = {
      requestId: 'request-2',
      kind: 'dm',
      action: 'open',
      data: { eventId: 'dm-2' },
    };
    const firstHandled = Promise.resolve(listener?.({ payload: event1 }));
    const secondHandled = Promise.resolve(listener?.({ payload: event2 }));

    second.resolve();
    await secondHandled;
    expect(invoke).toHaveBeenCalledWith('banner_action_result', {
      requestId: 'request-2',
      success: true,
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'banner_action_result',
      expect.objectContaining({ requestId: 'request-1' }),
    );

    first.resolve();
    await firstHandled;
    expect(invoke).toHaveBeenCalledWith('banner_action_result', {
      requestId: 'request-1',
      success: true,
    });
  });

  it('reports authoritative action failures without dropping the router', async () => {
    let listener:
      | ((event: { payload: BannerActionEvent }) => void | Promise<void>)
      | undefined;
    const invoke = vi.fn().mockResolvedValue(undefined);
    const router = new BannerActionRouter({
      listen: async (_event, handler) => {
        listener = handler;
        return () => {};
      },
      invoke,
      execute: vi.fn().mockRejectedValue(new Error('recording failed')),
      retryDelay: async () => {},
    });
    await router.start();

    await listener?.({
      payload: {
        requestId: 'request-1',
        kind: 'meeting',
        action: 'record',
        data: { windowId: 'window-1' },
      },
    });

    expect(invoke).toHaveBeenCalledWith('banner_action_result', {
      requestId: 'request-1',
      success: false,
    });
  });
});
