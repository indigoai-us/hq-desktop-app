import { describe, expect, it, vi } from 'vitest';
import type { ChatWakeBus } from '@hq/ui';
import {
  parseHqDesktopSetupUrl,
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

describe('subscribeHqWorkNativeWakes connection requests', () => {
  function harness(overrides: Partial<Parameters<typeof subscribeHqWorkNativeWakes>[0]> = {}) {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    const listen: TauriEventListener = async (event, handler) => {
      listeners.set(event, handler as (event: { payload: unknown }) => void);
      return () => listeners.delete(event);
    };
    const emit = vi.fn();
    const onNotificationWake = vi.fn();
    const notify = vi.fn(async () => {});
    const subscribed = subscribeHqWorkNativeWakes({
      listen,
      wakes: { emit, on: () => () => {} } as unknown as ChatWakeBus,
      scope: () => ({ personUid: 'prs_ada', companyUids: new Set(['cmp_indigo']) }),
      onNotificationWake,
      notify,
      ...overrides,
    });
    return { listeners, emit, onNotificationWake, notify, subscribed };
  }

  const REQUEST = {
    pairKey: 'pk_bob_ada',
    fromPersonUid: 'prs_bob',
    fromEmail: 'bob@example.com',
    fromDisplayName: 'Bob Builder',
    message: 'Can we talk about the launch?',
    sharedCompany: null,
    createdAt: '2026-09-10T00:00:00.000Z',
  };

  it('forwards dm:request-new as a normalized wake, bumps notifications, and sends the banner', async () => {
    const { listeners, emit, onNotificationWake, notify, subscribed } = harness();
    const dispose = await subscribed;

    listeners.get('dm:request-new')?.({ payload: REQUEST });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

    expect(emit).toHaveBeenCalledWith('dm:request-new', REQUEST);
    expect(onNotificationWake).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      title: 'Bob Builder wants to connect',
      body: 'Can we talk about the launch?',
    });
    dispose();
  });

  it('labels a uid-only request from contacts before the banner and falls back to the open-Messages body', async () => {
    const listContacts = vi.fn(async () => [
      { personUid: 'prs_bob', email: 'bob@example.com', displayName: 'Bob Builder' },
    ]);
    const { listeners, emit, notify, subscribed } = harness({ listContacts });
    const dispose = await subscribed;

    listeners.get('dm:request-new')?.({
      payload: {
        pair_key: 'pk_bob_ada',
        from_person_uid: 'prs_bob',
        from_email: '',
        from_display_name: 'prs_bob',
        created_at: '2026-09-10T00:00:00.000Z',
      },
    });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

    expect(emit).toHaveBeenCalledWith(
      'dm:request-new',
      expect.objectContaining({ pairKey: 'pk_bob_ada', fromPersonUid: 'prs_bob' }),
    );
    expect(listContacts).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      title: 'Bob Builder wants to connect',
      body: 'Open Messages to accept, decline, or block this request.',
    });
    dispose();
  });

  it('does not banner once the session is gone, and swallows a failing banner', async () => {
    let authenticated = true;
    const notify = vi.fn(async () => {
      throw new Error('notification centre unavailable');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { listeners, emit, subscribed } = harness({
      notify,
      scope: () =>
        authenticated
          ? { personUid: 'prs_ada', companyUids: new Set(['cmp_indigo']) }
          : null,
      listContacts: async () => {
        authenticated = false;
        return [];
      },
    });
    const dispose = await subscribed;

    // Uid-only → contact lookup runs → session ends mid-lookup → no banner.
    listeners.get('dm:request-new')?.({
      payload: { ...REQUEST, fromEmail: '', fromDisplayName: '' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);

    // Authenticated again; a throwing banner is logged, never thrown.
    authenticated = true;
    listeners.get('dm:request-new')?.({ payload: REQUEST });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(consoleError).toHaveBeenCalledWith(
      'dm-request: banner failed',
      expect.any(Error),
    );
    consoleError.mockRestore();
    dispose();
  });

  it('forwards dm:request-update as a pairKey-only wake and bumps notifications', async () => {
    const { listeners, emit, onNotificationWake, notify, subscribed } = harness();
    const dispose = await subscribed;

    listeners.get('dm:request-update')?.({
      payload: { pairKey: 'pk_bob_ada', state: 'accepted', withPersonUid: 'prs_bob' },
    });
    expect(emit).toHaveBeenCalledWith('dm:request-update', { pairKey: 'pk_bob_ada' });
    expect(onNotificationWake).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();

    // Malformed payloads are dropped, not forwarded.
    listeners.get('dm:request-update')?.({ payload: { state: 'declined' } });
    listeners.get('dm:request-new')?.({ payload: { fromPersonUid: 'prs_x' } });
    expect(emit).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe('parseHqDesktopSetupUrl', () => {
  it('parses hq-desktop://setup?checkout=done&company={uid}', () => {
    expect(
      parseHqDesktopSetupUrl(
        'hq-desktop://setup?checkout=done&company=cmp_acme',
      ),
    ).toEqual({ companyUid: 'cmp_acme', checkout: 'done' });
  });

  it('rejects urls without a company', () => {
    expect(parseHqDesktopSetupUrl('hq-desktop://setup?checkout=done')).toBeNull();
    expect(parseHqDesktopSetupUrl('hqwork://open?channel=setup')).toBeNull();
  });
});

