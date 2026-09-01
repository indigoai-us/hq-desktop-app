import { describe, expect, it, vi } from 'vitest';
import type { ChatWakeBus } from '@hq/ui';
import {
  subscribeHqWorkNativeWakes,
  type TauriEventListener,
} from './hq-work-host';

describe('subscribeHqWorkNativeWakes', () => {
  it('forwards separate id-less channel unread snapshots inside the dedupe window', async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    const listen: TauriEventListener = async (event, handler) => {
      listeners.set(event, handler as (event: { payload: unknown }) => void);
      return () => listeners.delete(event);
    };
    const emit = vi.fn();
    const onNotificationWake = vi.fn();
    const dispose = await subscribeHqWorkNativeWakes({
      listen,
      wakes: { emit, on: () => () => {} } as unknown as ChatWakeBus,
      scope: () => ({ personUid: 'prs_ada', companyUids: new Set(['cmp_indigo']) }),
      onNotificationWake,
    });

    const channelWake = listeners.get('channel:new-message');
    expect(channelWake).toBeTypeOf('function');
    const payload = { companyUid: 'cmp_indigo', channelId: 'chn_engineering', unread: 1 };
    channelWake?.({ payload });
    channelWake?.({ payload });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, 'channel:new-message', {
      channelId: 'chn_engineering',
      unread: 1,
      absoluteUnread: true,
    });
    expect(onNotificationWake).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('preserves each native channel unread total as an absolute UI update', async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    const listen: TauriEventListener = async (event, handler) => {
      listeners.set(event, handler as (event: { payload: unknown }) => void);
      return () => listeners.delete(event);
    };
    const emit = vi.fn();
    const dispose = await subscribeHqWorkNativeWakes({
      listen,
      wakes: { emit, on: () => () => {} } as unknown as ChatWakeBus,
      scope: () => ({ personUid: 'prs_ada', companyUids: new Set(['cmp_indigo']) }),
      onNotificationWake: vi.fn(),
    });

    const channelWake = listeners.get('channel:new-message');
    channelWake?.({
      payload: {
        companyUid: 'cmp_indigo',
        channelId: 'chn_engineering',
        eventId: 'evt_batch',
        unread: 4,
      },
    });
    channelWake?.({
      payload: {
        companyUid: 'cmp_indigo',
        channelId: 'chn_engineering',
        eventId: 'evt_after_read',
        unread: 1,
      },
    });

    expect(emit).toHaveBeenNthCalledWith(1, 'channel:new-message', {
      channelId: 'chn_engineering',
      eventId: 'evt_batch',
      unread: 4,
      absoluteUnread: true,
    });
    expect(emit).toHaveBeenNthCalledWith(2, 'channel:new-message', {
      channelId: 'chn_engineering',
      eventId: 'evt_after_read',
      unread: 1,
      absoluteUnread: true,
    });
    dispose();
  });
});
