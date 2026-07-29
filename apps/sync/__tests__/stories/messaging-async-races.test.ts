// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { flushSync, mount, tick, unmount } from 'svelte';
import DmThreadPane from '../../src/components/DmThreadPane.svelte';
import MessagesShell from '../../src/components/messaging/MessagesShell.svelte';
import DmThreadPaneRaceHarness from './DmThreadPaneRaceHarness.svelte';
import ThreadPanelRaceHarness from './ThreadPanelRaceHarness.svelte';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

type EventHandler = (event: { payload: any }) => void;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function contact(personUid: string, displayName: string) {
  return {
    personUid,
    email: `${personUid}@example.com`,
    displayName,
    source: 'contact',
    lastMessageAt: null,
  };
}

function dmMessage(eventId: string, body: string, rootEventId?: string) {
  return {
    eventId,
    rootEventId,
    replyCount: rootEventId ? 1 : 0,
    fromPersonUid: 'peer',
    fromEmail: 'peer@example.com',
    fromDisplayName: 'Peer',
    body,
    details: null,
    prompt: null,
    createdAt: '2026-07-28T12:00:00.000Z',
    direction: 'in',
  };
}

function dmEvent(eventId: string, body: string, createdAt: string) {
  return {
    eventId,
    fromPersonUid: 'peer',
    fromEmail: 'peer@example.com',
    fromDisplayName: 'Peer',
    body,
    details: null,
    prompt: null,
    createdAt,
  };
}

function channel(channelId: string, name: string, membership = 'joined') {
  return {
    channelId,
    name,
    scope: 'personal',
    membership,
    memberCount: 2,
    unread: 0,
  };
}

let host: HTMLDivElement;
let component: Record<string, unknown> | null;
let listeners: Map<string, EventHandler[]>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function baseFixture(command: string): unknown {
  if (command === 'list_contacts') return { contacts: [] };
  if (command === 'fetch_notification_history') return { dms: [], shares: [] };
  if (command === 'get_unread_summary') return { unreadDms: 0, pendingRequests: 0 };
  if (command === 'list_dm_requests') return { requests: [] };
  if (command === 'list_channels') return { channels: [] };
  if (command === 'meetings_list_memberships') return [];
  if (command === 'get_config') return {};
  if (command === 'fetch_reactions') return [];
  return undefined;
}

function emit(event: string, payload: unknown): void {
  for (const handler of listeners.get(event) ?? []) handler({ payload });
  flushSync();
}

function railButton(provenance: string, label: string): HTMLButtonElement {
  const match = [
    ...host.querySelectorAll<HTMLButtonElement>(
      `.contact-row[data-provenance="${provenance}"]`,
    ),
  ].find((button) => button.textContent?.includes(label));
  if (!match) throw new Error(`Missing ${provenance} rail row for ${label}`);
  return match;
}

function typeReply(text: string): HTMLButtonElement {
  const input = host.querySelector<HTMLTextAreaElement>('.dm-reply-input');
  if (!input) throw new Error('Missing reply input');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  const send = host.querySelector<HTMLButtonElement>('.btn-send');
  if (!send) throw new Error('Missing send button');
  return send;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
  listeners = new Map();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
  tauri.invoke.mockImplementation(async (command: string) => baseFixture(command));
  tauri.listen.mockImplementation(
    async (event: string, handler: EventHandler): Promise<() => void> => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
      return vi.fn();
    },
  );
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  consoleErrorSpy.mockRestore();
  host.remove();
  vi.clearAllMocks();
});

describe('DmThreadPane hydration ownership', () => {
  it('preserves live and optimistic messages appended while hydration is in flight', async () => {
    const hydration = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();

    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'fetch_dm_thread') return hydration.promise;
      if (command === 'send_dm') return Promise.resolve();
      return Promise.resolve(baseFixture(command));
    });

    component = mount(DmThreadPane, {
      target: host,
      props: {
        event: dmEvent(
          'opening-event',
          'Opening message',
          '2026-07-28T12:01:00.000Z',
        ),
      },
    });
    await vi.waitFor(() => expect(listeners.has('dm:new-events')).toBe(true));

    emit('dm:new-events', [
      dmEvent(
        'live-event',
        'Arrived while loading',
        '2026-07-28T12:02:00.000Z',
      ),
    ]);
    typeReply('Sent while loading').click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Sent while loading');
    });

    hydration.resolve({
      messages: [dmMessage('history-event', 'Earlier history')],
    });
    await hydration.promise;
    await tick();
    flushSync();

    const bodyText = [...host.querySelectorAll<HTMLElement>('.dm-bubble-body')].map(
      (node) => node.textContent?.trim(),
    );
    expect(bodyText).toEqual([
      'Earlier history',
      'Opening message',
      'Arrived while loading',
      'Sent while loading',
    ]);
  });

  it('ignores a stale Alice hydration success after switching the pane to Bob', async () => {
    const alice = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();
    const bob = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'fetch_dm_thread') {
        return args?.withPersonUid === 'person-alice' ? alice.promise : bob.promise;
      }
      return Promise.resolve(baseFixture(command));
    });

    component = mount(DmThreadPaneRaceHarness, { target: host });
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('fetch_dm_thread', {
        withPersonUid: 'person-alice',
      });
    });

    host.querySelector<HTMLButtonElement>('[data-testid="select-bob"]')?.click();
    flushSync();
    expect(host.textContent).not.toContain('Alice opening');

    bob.resolve({ messages: [dmMessage('bob-history', 'Bob history')] });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Bob history');
      expect(host.textContent).toContain('Bob opening');
    });

    alice.resolve({ messages: [dmMessage('alice-history', 'Alice private history')] });
    await alice.promise;
    await tick();
    flushSync();

    expect(host.textContent).toContain('Bob history');
    expect(host.textContent).toContain('Bob opening');
    expect(host.textContent).not.toContain('Alice private history');
    expect(host.textContent).not.toContain('Alice opening');
  });

  it('ignores a stale Alice hydration failure after switching the pane to Bob', async () => {
    const alice = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();
    const bob = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'fetch_dm_thread') {
        return args?.withPersonUid === 'person-alice' ? alice.promise : bob.promise;
      }
      return Promise.resolve(baseFixture(command));
    });

    component = mount(DmThreadPaneRaceHarness, { target: host });
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('fetch_dm_thread', {
        withPersonUid: 'person-alice',
      });
    });

    host.querySelector<HTMLButtonElement>('[data-testid="select-bob"]')?.click();
    flushSync();
    bob.resolve({ messages: [dmMessage('bob-history', 'Bob remains current')] });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Bob remains current');
      expect(host.querySelector('.dm-thread')?.getAttribute('aria-busy')).toBe('false');
    });

    alice.reject(new Error('Alice thread unavailable'));
    await alice.promise.catch(() => undefined);
    await tick();
    flushSync();

    expect(host.textContent).toContain('Bob remains current');
    expect(host.textContent).toContain('Bob opening');
    expect(host.textContent).not.toContain('Alice thread unavailable');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('.dm-thread')?.getAttribute('aria-busy')).toBe('false');
  });
});

describe('MessagesShell async ownership', () => {
  it('ignores an A success that resolves after B has already loaded', async () => {
    const a = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();
    const b = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();
    const contacts = [contact('person-a', 'Alice'), contact('person-b', 'Bob')];

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'list_contacts') return Promise.resolve({ contacts });
      if (command === 'fetch_dm_thread') {
        return args?.withPersonUid === 'person-a' ? a.promise : b.promise;
      }
      return Promise.resolve(baseFixture(command));
    });

    component = mount(MessagesShell, { target: host, props: { embedded: true } });
    await vi.waitFor(() => expect(railButton('direct-message', 'Alice')).toBeTruthy());

    railButton('direct-message', 'Alice').click();
    flushSync();
    railButton('direct-message', 'Bob').click();
    flushSync();

    b.resolve({ messages: [dmMessage('b-1', 'Bob loaded first')] });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Bob loaded first');
    });

    a.resolve({ messages: [dmMessage('a-1', 'Stale Alice success')] });
    await a.promise;
    await tick();
    flushSync();

    expect(host.querySelector('.pane-title-stack h2')?.textContent).toBe('Bob');
    expect(host.textContent).toContain('Bob loaded first');
    expect(host.textContent).not.toContain('Stale Alice success');
  });

  it('keeps B visible and busy while A resolves late, then ignores A failure and finally', async () => {
    const a = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();
    const b = deferred<{ messages: ReturnType<typeof dmMessage>[] }>();
    const contacts = [contact('person-a', 'Alice'), contact('person-b', 'Bob')];

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'list_contacts') return Promise.resolve({ contacts });
      if (command === 'fetch_dm_thread') {
        return args?.withPersonUid === 'person-a' ? a.promise : b.promise;
      }
      return Promise.resolve(baseFixture(command));
    });

    component = mount(MessagesShell, { target: host, props: { embedded: true } });
    await vi.waitFor(() => expect(railButton('direct-message', 'Alice')).toBeTruthy());

    railButton('direct-message', 'Alice').click();
    flushSync();
    railButton('direct-message', 'Bob').click();
    flushSync();

    a.reject(new Error('Alice offline'));
    await a.promise.catch(() => undefined);
    await tick();
    flushSync();

    const titleWhileBPending = host.querySelector('.pane-title-stack h2')?.textContent;
    const busyWhileBPending = host.querySelector('.dm-thread')?.getAttribute('aria-busy');
    const staleAlertWhileBPending = host.querySelector('[role="alert"]')?.textContent ?? null;

    b.resolve({ messages: [dmMessage('b-1', 'Bob is current')] });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Bob is current');
    });
    expect(titleWhileBPending).toBe('Bob');
    expect(busyWhileBPending).toBe('true');
    expect(staleAlertWhileBPending).toBeNull();
    expect(host.textContent).not.toContain('Alice offline');
    expect(host.querySelector('.dm-thread')?.getAttribute('aria-busy')).toBe('false');
  });

  it('does not append or report a completed A send inside B after the selection changes', async () => {
    const sendA = deferred<void>();
    const contacts = [contact('person-a', 'Alice'), contact('person-b', 'Bob')];

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'list_contacts') return Promise.resolve({ contacts });
      if (command === 'fetch_dm_thread') return Promise.resolve({ messages: [] });
      if (command === 'send_dm' && args?.toPersonUid === 'person-a') return sendA.promise;
      return Promise.resolve(baseFixture(command));
    });

    component = mount(MessagesShell, { target: host, props: { embedded: true } });
    await vi.waitFor(() => expect(railButton('direct-message', 'Alice')).toBeTruthy());

    railButton('direct-message', 'Alice').click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.dm-thread')?.getAttribute('aria-busy')).toBe('false');
    });

    const send = typeReply('for Alice only');
    send.click();
    flushSync();
    expect(send.getAttribute('aria-busy')).toBe('true');

    railButton('direct-message', 'Bob').click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.pane-title-stack h2')?.textContent).toBe('Bob');
    });
    expect(host.querySelector<HTMLButtonElement>('.btn-send')?.getAttribute('aria-busy')).toBe(
      'false',
    );

    sendA.resolve();
    await sendA.promise;
    await tick();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('send_dm', {
      toPersonUid: 'person-a',
      body: 'for Alice only',
    });
    expect(host.querySelector('.pane-title-stack h2')?.textContent).toBe('Bob');
    expect(host.textContent).not.toContain('for Alice only');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not surface an A send failure or finally state after switching to B', async () => {
    const sendA = deferred<void>();
    const contacts = [contact('person-a', 'Alice'), contact('person-b', 'Bob')];

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'list_contacts') return Promise.resolve({ contacts });
      if (command === 'fetch_dm_thread') return Promise.resolve({ messages: [] });
      if (command === 'send_dm' && args?.toPersonUid === 'person-a') return sendA.promise;
      return Promise.resolve(baseFixture(command));
    });

    component = mount(MessagesShell, { target: host, props: { embedded: true } });
    await vi.waitFor(() => expect(railButton('direct-message', 'Alice')).toBeTruthy());
    railButton('direct-message', 'Alice').click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.dm-thread')?.getAttribute('aria-busy')).toBe('false');
    });

    typeReply('will fail for Alice').click();
    flushSync();
    railButton('direct-message', 'Bob').click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.pane-title-stack h2')?.textContent).toBe('Bob');
    });

    sendA.reject(new Error('Alice send failed'));
    await sendA.promise.catch(() => undefined);
    await tick();
    flushSync();

    expect(host.querySelector('.pane-title-stack h2')?.textContent).toBe('Bob');
    expect(host.querySelector<HTMLButtonElement>('.btn-send')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('Alice send failed');
  });

  it('merges realtime people, request, and channel mutations over late initial snapshots', async () => {
    const contactsSnapshot = deferred<{ contacts: ReturnType<typeof contact>[] }>();
    const requestsSnapshot = deferred<{ requests: any[] }>();
    const channelsSnapshot = deferred<{ channels: any[] }>();
    let contactLoads = 0;

    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'list_contacts') {
        contactLoads += 1;
        return contactLoads === 1
          ? contactsSnapshot.promise
          : Promise.resolve({
              contacts: [
                contact('person-alice', 'Alice'),
                contact('person-maya', 'Maya'),
              ],
            });
      }
      if (command === 'list_dm_requests') return requestsSnapshot.promise;
      if (command === 'list_channels') return channelsSnapshot.promise;
      return Promise.resolve(baseFixture(command));
    });

    component = mount(MessagesShell, { target: host, props: { embedded: true } });
    await vi.waitFor(() => expect(listeners.has('dm:new-events')).toBe(true));

    emit('dm:new-events', [
      {
        eventId: 'dm-maya',
        fromPersonUid: 'person-maya',
        fromEmail: 'maya@example.com',
        fromDisplayName: 'Maya',
        body: 'Realtime hello',
        createdAt: '2026-07-28T14:00:00.000Z',
      },
    ]);
    emit('dm:request-new', {
      pairKey: 'pair-richard',
      fromPersonUid: 'person-richard',
      fromEmail: 'richard@example.com',
      fromDisplayName: 'Richard',
      message: 'Let’s connect',
      state: 'pending',
      createdAt: '2026-07-28T14:01:00.000Z',
    });
    emit('channel:updated', channel('channel-launch', 'launch'));

    contactsSnapshot.resolve({ contacts: [contact('person-alice', 'Alice')] });
    requestsSnapshot.resolve({ requests: [] });
    channelsSnapshot.resolve({ channels: [] });

    await vi.waitFor(() => {
      flushSync();
      expect(railButton('direct-message', 'Maya')).toBeTruthy();
      expect(railButton('connection-request', 'Richard')).toBeTruthy();
      expect(railButton('channel', 'launch')).toBeTruthy();
    });
  });
});

describe('ThreadPanel async ownership', () => {
  it('keeps root B busy while root A resolves late and ignores A success/finally', async () => {
    const a = deferred<any>();
    const b = deferred<any>();

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'fetch_thread') {
        return args?.rootEventId === 'root-a' ? a.promise : b.promise;
      }
      return Promise.resolve(baseFixture(command));
    });

    component = mount(ThreadPanelRaceHarness, { target: host });
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="root-b"]')!.click();
    flushSync();

    a.resolve({
      root: dmMessage('root-a', 'Stale root A'),
      replies: [],
      replyCount: 0,
    });
    await a.promise;
    await tick();
    flushSync();

    const titleWhileBPending = host.querySelector('.thread-title')?.textContent ?? '';
    const staleRootVisible = host.textContent?.includes('Stale root A') ?? false;
    const busyWhileBPending = host.querySelector('.dm-thread')?.getAttribute('aria-busy');

    b.resolve({
      root: dmMessage('root-b', 'Current root B'),
      replies: [],
      replyCount: 0,
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Current root B');
    });
    expect(titleWhileBPending).toContain('root-b');
    expect(staleRootVisible).toBe(false);
    expect(busyWhileBPending).toBe('true');
    expect(host.querySelector('.dm-thread')?.getAttribute('aria-busy')).toBe('false');
  });

  it('posts to the captured root/person and never appends that reply after switching roots', async () => {
    const sendA = deferred<void>();

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'fetch_thread') {
        return Promise.resolve({
          root: dmMessage(args.rootEventId, `Loaded ${args.rootEventId}`),
          replies: [],
          replyCount: 0,
        });
      }
      if (command === 'send_thread_reply') return sendA.promise;
      return Promise.resolve(baseFixture(command));
    });

    component = mount(ThreadPanelRaceHarness, { target: host });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Loaded root-a');
    });

    typeReply('reply for root A').click();
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="root-b"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Loaded root-b');
    });

    sendA.resolve();
    await sendA.promise;
    await tick();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('send_thread_reply', {
      scope: 'dm',
      rootEventId: 'root-a',
      body: 'reply for root A',
      channelId: null,
      toPersonUid: 'person-a',
    });
    expect(host.textContent).not.toContain('reply for root A');
    expect(host.querySelector('.thread-title')?.textContent).toContain('root-b');
  });

  it('does not surface an old-root send failure or finally state in the new root', async () => {
    const sendA = deferred<void>();

    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'fetch_thread') {
        return Promise.resolve({
          root: dmMessage('root', 'Loaded root'),
          replies: [],
          replyCount: 0,
        });
      }
      if (command === 'send_thread_reply') return sendA.promise;
      return Promise.resolve(baseFixture(command));
    });

    component = mount(ThreadPanelRaceHarness, { target: host });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Loaded root');
    });

    typeReply('old-root failure').click();
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="root-b"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.thread-title')?.textContent).toContain('root-b');
    });

    sendA.reject(new Error('root A unavailable'));
    await sendA.promise.catch(() => undefined);
    await tick();
    flushSync();

    expect(host.querySelector('.thread-title')?.textContent).toContain('root-b');
    expect(host.querySelector<HTMLButtonElement>('.btn-send')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('root A unavailable');
  });

  it('unsubscribes listeners whose registration resolves after unmount', async () => {
    const pendingListeners: Array<{
      resolve: (unlisten: () => void) => void;
      unlisten: ReturnType<typeof vi.fn>;
    }> = [];
    tauri.listen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          pendingListeners.push({ resolve, unlisten: vi.fn() });
        }),
    );
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'fetch_thread') {
        return Promise.resolve({
          root: dmMessage('root-a', 'Root'),
          replies: [],
          replyCount: 0,
        });
      }
      return Promise.resolve(baseFixture(command));
    });

    component = mount(ThreadPanelRaceHarness, { target: host });
    flushSync();
    expect(pendingListeners).toHaveLength(2);

    const unmounting = unmount(component);
    component = null;
    for (const pending of pendingListeners) pending.resolve(pending.unlisten);
    await unmounting;

    await vi.waitFor(() => {
      for (const pending of pendingListeners) {
        expect(pending.unlisten).toHaveBeenCalledOnce();
      }
    });
  });
});

describe('Channel join async ownership', () => {
  it('keeps B joining when A fails late and never shows A failure in B', async () => {
    const joinA = deferred<any>();
    const joinB = deferred<any>();
    const channels = [
      channel('channel-a', 'alpha', 'invited'),
      channel('channel-b', 'beta', 'invited'),
    ];

    tauri.invoke.mockImplementation((command: string, args?: any) => {
      if (command === 'list_channels') return Promise.resolve({ channels });
      if (command === 'fetch_channel') {
        const selected = channels.find((item) => item.channelId === args.channelId)!;
        return Promise.resolve({ channel: selected, messages: [] });
      }
      if (command === 'join_channel') {
        if (args?.channelId === 'channel-a') return joinA.promise;
        return joinB.promise.then((updated) => {
          channels[1] = updated;
          return updated;
        });
      }
      return Promise.resolve(baseFixture(command));
    });

    component = mount(MessagesShell, { target: host, props: { embedded: true } });
    await vi.waitFor(() => expect(railButton('channel', 'alpha')).toBeTruthy());

    railButton('channel', 'alpha').click();
    await vi.waitFor(() => expect(host.querySelector('.channel-title h2')?.textContent).toBe('alpha'));
    host.querySelector<HTMLButtonElement>('.btn-join')!.click();
    flushSync();

    railButton('channel', 'beta').click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.channel-title h2')?.textContent).toBe('beta');
    });
    const betaEnabledImmediately =
      host.querySelector<HTMLButtonElement>('.btn-join')?.disabled === false;
    if (betaEnabledImmediately) {
      host.querySelector<HTMLButtonElement>('.btn-join')!.click();
      flushSync();
    }

    joinA.reject(new Error('Alpha invite expired'));
    await joinA.promise.catch(() => undefined);
    await tick();
    flushSync();

    const betaBusyAfterAlphaFinally =
      host.querySelector<HTMLButtonElement>('.btn-join')?.getAttribute('aria-busy');
    if (!betaEnabledImmediately) {
      host.querySelector<HTMLButtonElement>('.btn-join')!.click();
      flushSync();
    }

    expect(host.querySelector('.channel-title h2')?.textContent).toBe('beta');
    expect(betaEnabledImmediately).toBe(true);
    expect(betaBusyAfterAlphaFinally).toBe('true');
    expect(host.textContent).not.toContain('Alpha invite expired');

    joinB.resolve({ ...channels[1], membership: 'joined' });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.dm-reply-input')).toBeTruthy();
    });
  });
});
