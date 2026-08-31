// @vitest-environment happy-dom
/**
 * Embedded desktop navigation and host-lifecycle contract.
 *
 * These are intentionally mounted-shell tests: native pending/live events must
 * reach the rendered @hq/ui surface rather than merely call a route helper.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeListeners = vi.hoisted(
  () => new Map<string, (event: { payload: unknown }) => void>(),
);
const openExternal = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('svelte', async () => {
  // @ts-expect-error the client entry is intentionally used by happy-dom.
  return await import('../../node_modules/svelte/src/index-client.js');
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('tests inject invokeFn');
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    nativeListeners.set(name, handler);
    return () => {
      if (nativeListeners.get(name) === handler) nativeListeners.delete(name);
    };
  }),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.168'),
  setTheme: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({ open: openExternal }));

import { flushSync, mount, unmount } from 'svelte';
import HqWorkDesktopShell from '../../src/desktop-alt/HqWorkDesktopShell.svelte';
import type { SyncInvokeFn } from '../../src/lib/hq-work-adapter';

const WHOAMI = {
  personUid: 'prs_ada',
  email: 'ada@example.test',
  displayName: 'Ada Lovelace',
};
const MEETING_START = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const MEETING_END = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

interface Options {
  pendingRoute?: string | null;
  pendingMeetingId?: string | null;
  signedIn?: boolean;
  calls?: string[];
  workspaceFailure?: boolean;
  identityFailure?: boolean;
  directoryResponse?: Promise<unknown>;
  notificationFeed?: { current: unknown };
}

function invokeFor(options: Options = {}): SyncInvokeFn {
  return async (command, args) => {
    options.calls?.push(command);
    switch (command) {
      case 'get_auth_state':
        return { authenticated: options.signedIn ?? true, accountId: 'acct_ada' };
      case 'desktop_alt_consume_pending_route':
        return options.pendingRoute ?? null;
      case 'meetings_take_pending_focus':
        return options.pendingMeetingId ?? null;
      case 'desktop_alt_is_admin':
      case 'meetings_feature_enabled':
        return true;
      case 'is_indigo_user':
        return false;
      case 'list_syncable_workspaces':
        if (options.workspaceFailure) throw new Error('workspace service unavailable');
        return {
          workspaces: [
            {
              slug: 'indigo',
              cloudUid: 'cmp_indigo',
              role: 'owner',
              membershipStatus: 'active',
            },
          ],
        };
      case 'list_channels':
        if (options.directoryResponse) return options.directoryResponse;
        return {
          channels: [
            { channelId: 'chn_engineering', id: 'chn_engineering', name: 'engineering', scope: 'company' },
          ],
        };
      case 'list_contacts':
        return {
          contacts: [
            {
              personUid: 'prs_ada',
              displayName: 'Ada',
              email: 'ada@example.test',
              lastActivityAt: MEETING_START,
            },
          ],
        };
      case 'list_dm_requests':
        return { notifications: [] };
      case 'fetch_notifications':
        return options.notificationFeed?.current ?? {
          notifications: [],
          unreadCount: 0,
          nextCursor: null,
        };
      case 'fetch_channel':
        return { messages: [{ eventId: 'evt_root', body: 'hello' }] };
      case 'fetch_thread':
        return {
          root: { eventId: 'evt_root', body: 'root' },
          replies: [],
          replyCount: 0,
        };
      case 'list_packages':
        return { packs: [] };
      case 'meetings_list_upcoming':
        return [
          {
            id: 'mtg_focus',
            summary: 'Design review',
            start: { dateTime: MEETING_START },
            end: { dateTime: MEETING_END },
            status: 'confirmed',
            meetingUrl: 'https://meet.google.com/abc-defg-hij',
          },
        ];
      case 'meetings_list_scheduled_bots':
      case 'meetings_list_memberships':
      case 'meetings_list_accounts':
        return [];
      case 'meetings_list_calendars_for_account':
        return [];
      case 'get_settings':
      case 'get_config':
        return {};
      case 'sign_out':
        return null;
      case 'hq_pro_fetch': {
        const path = String(args?.url ?? '');
        if (path.startsWith('/v1/identity/whoami')) {
          if (options.identityFailure) {
            return {
              status: 503,
              body: JSON.stringify({ error: 'identity service unavailable' }),
            };
          }
          return { status: 200, body: JSON.stringify(WHOAMI) };
        }
        if (path.startsWith('/v1/google/connect')) {
          return {
            status: 200,
            body: JSON.stringify({
              url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=hq',
            }),
          };
        }
        return { status: 200, body: JSON.stringify({}) };
      }
      default:
        return null;
    }
  };
}

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  flushSync();
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

async function mountShell(options: Options = {}): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(HqWorkDesktopShell, {
    target: host,
    props: { invokeFn: invokeFor(options) },
  });
  await flush();
}

function warmRoute(route: string): void {
  const listener = nativeListeners.get('desktop:navigate');
  if (!listener) throw new Error('desktop:navigate listener was not registered');
  listener({ payload: route });
}

function warmMeetingFocus(meetingId: string): void {
  const listener = nativeListeners.get('meetings:focus-meeting');
  if (!listener) throw new Error('meetings:focus-meeting listener was not registered');
  listener({ payload: { meetingId } });
}

function warmAuthSessionReady(): void {
  const listener = nativeListeners.get('auth:session-ready');
  if (!listener) throw new Error('auth:session-ready listener was not registered');
  listener({ payload: { authenticated: true } });
}

function warmPackageUpdates(payload: unknown): void {
  const listener = nativeListeners.get('packages:updates');
  if (!listener) throw new Error('packages:updates listener was not registered');
  listener({ payload });
}

function nativeWake(name: string, payload: unknown): void {
  const listener = nativeListeners.get(name);
  if (!listener) throw new Error(`${name} listener was not registered`);
  listener({ payload });
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  nativeListeners.clear();
  openExternal.mockClear();
});

describe('embedded Work navigation and lifecycle', () => {
  it('shows a truthful initial loading state before identity settles', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(HqWorkDesktopShell, {
      target: host,
      props: { invokeFn: invokeFor() },
    });

    expect(host.querySelector('[data-testid="hq-work-loading"]')).toBeTruthy();
    await flush();
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
  });

  it('delivers a cold Settings subsection after DesktopApp has mounted', async () => {
    await mountShell({ pendingRoute: 'settings:updates' });

    expect(host.querySelector('[data-testid="settings-host"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="settings-nav-updates"]')?.getAttribute('aria-current'),
    ).toBe('page');
  });

  it('maps every warm native destination to a visible embedded surface', async () => {
    await mountShell();

    warmRoute('inbox');
    await flush();
    expect(host.querySelector('[data-testid="notifications-view"]')).toBeTruthy();

    warmRoute('notifications');
    await flush();
    expect(
      host.querySelector('[data-testid="notifications-view"]')?.parentElement?.classList.contains('is-active'),
    ).toBe(true);

    warmRoute('messages');
    await flush();
    expect(
      host.querySelector('[data-testid="notifications-view"]')?.parentElement?.classList.contains('is-active'),
    ).toBe(false);

    warmRoute('meetings');
    await flush();
    expect(host.querySelector('[data-testid="desktop-alt-meetings"]')).toBeTruthy();

    warmRoute('library:installed');
    await flush();
    expect(host.querySelector('[data-testid="library-overlay"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="library-nav-installed"]')?.getAttribute('aria-current'),
    ).toBe('page');

    warmRoute('library:marketplace');
    await flush();
    expect(
      host.querySelector('[data-testid="library-nav-marketplace"]')?.getAttribute('aria-current'),
    ).toBe('page');
    expect(host.querySelector('[data-testid="library-marketplace-panel"]')).toBeTruthy();

    warmRoute('library');
    await flush();
    expect(
      host.querySelector('[data-testid="library-nav-skills"]')?.getAttribute('aria-current'),
    ).toBe('page');

    warmRoute('settings');
    await flush();
    expect(
      host.querySelector('[data-testid="settings-nav-profile"]')?.getAttribute('aria-current'),
    ).toBe('page');

    warmRoute('settings:appearance');
    await flush();
    expect(host.querySelector('[data-testid="settings-host"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="settings-nav-appearance"]')?.getAttribute('aria-current'),
    ).toBe('page');

    // A second warm request for bare Settings must reset an already-mounted
    // settings view to Profile, rather than silently retaining Appearance.
    warmRoute('settings');
    await flush();
    expect(
      host.querySelector('[data-testid="settings-nav-profile"]')?.getAttribute('aria-current'),
    ).toBe('page');

    warmRoute('home');
    await flush();
    expect(host.querySelector('[data-testid="settings-host"]')).toBeNull();
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();

    // A Custom native destination with no embedded surface must be visible,
    // rather than silently leaving the stale destination selected.
    warmRoute('company:indigo:activity');
    await flush();
    expect(host.querySelector('[data-testid="embedded-navigation-error"]')?.textContent).toContain(
      'Unsupported embedded destination',
    );

    warmRoute('settings:appearance:untrusted');
    await flush();
    expect(host.querySelector('[data-testid="embedded-navigation-error"]')?.textContent).toContain(
      'settings:appearance:untrusted',
    );

    // Title-bar Marketplace is routed to discovery, never the Installed panel.
    warmRoute('home');
    await flush();
    (host.querySelector('[data-testid="titlebar-core-pill"]') as HTMLButtonElement).click();
    await flush();
    (host.querySelector('[data-testid="core-popover-open-marketplace"]') as HTMLButtonElement).click();
    await flush();
    expect(
      host.querySelector('[data-testid="library-nav-marketplace"]')?.getAttribute('aria-current'),
    ).toBe('page');
    expect(host.querySelector('[data-testid="library-installed-panel"]')).toBeNull();
  });

  it('carries a warm hqwork reply target through the mounted host into ReplyPanel', async () => {
    await mountShell();

    warmRoute('hqwork://open?channel=chn_engineering&reply=evt_root');
    await flush();

    expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toContain(
      'engineering',
    );
    expect(host.querySelector('[data-testid="reply-panel"]')).toBeTruthy();

    warmRoute('hqwork://open?person=prs_ada&reply=evt_root');
    await flush();

    expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toContain('prs_ada');
    expect(host.querySelector('[data-testid="reply-panel"]')).toBeTruthy();
  });

  it('reconciles scoped native message, reply, and notification wakes without duplicate or foreign delivery', async () => {
    const calls: string[] = [];
    const notificationFeed = {
      current: {
        notifications: [],
        unreadCount: 0,
        nextCursor: null,
      } as unknown,
    };
    await mountShell({ calls, notificationFeed });
    // Workspace membership resolves after the authenticated shell. Wait until
    // the native wake bridge has captured that tenant snapshot.
    await flush(64);
    expect(host.querySelector('[data-testid="titlebar-notifications-badge"]')).toBeNull();

    notificationFeed.current = {
      notifications: [
        {
          id: 'notif-1',
          type: 'mention',
          status: 'unread',
          title: 'mentioned you',
          companyUid: 'cmp_indigo',
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      unreadCount: 1,
      nextCursor: 'next-page',
    };
    nativeWake('share:new-events', {
      companyUid: 'cmp_indigo',
      events: [{ eventId: 'share-1' }],
    });
    await flush(64);
    expect(host.querySelector('[data-testid="titlebar-notifications-badge"]')).toBeTruthy();

    const fetchesAfterFirstWake = calls.filter((command) => command === 'fetch_notifications').length;
    nativeWake('share:new-events', {
      companyUid: 'cmp_indigo',
      events: [{ eventId: 'share-1' }],
    });
    await flush(64);
    expect(calls.filter((command) => command === 'fetch_notifications')).toHaveLength(
      fetchesAfterFirstWake,
    );

    notificationFeed.current = {
      notifications: [
        {
          id: 'foreign-notif',
          type: 'mention',
          status: 'unread',
          title: 'must not cross company boundary',
          companyUid: 'cmp_other',
        },
      ],
      unreadCount: 2,
      nextCursor: null,
    };
    nativeWake('share:new-events', {
      companyUid: 'cmp_other',
      events: [{ eventId: 'share-foreign' }],
    });
    await flush(64);
    expect(host.querySelector('[data-testid="titlebar-notifications-badge"]')).toBeTruthy();
    expect(calls.filter((command) => command === 'fetch_notifications')).toHaveLength(
      fetchesAfterFirstWake,
    );

    warmRoute('hqwork://open?channel=chn_engineering&reply=evt_root');
    await flush(64);
    const channelFetches = calls.filter((command) => command === 'fetch_channel').length;
    const replyFetches = calls.filter((command) => command === 'fetch_thread').length;

    nativeWake('channel:new-message', {
      channelId: 'chn_engineering',
      eventId: 'evt-channel-2',
      companyUid: 'cmp_indigo',
    });
    nativeWake('thread:new-reply', {
      rootEventId: 'evt_root',
      eventId: 'evt-reply-2',
      scope: 'channel',
      channelId: 'chn_engineering',
      companyUid: 'cmp_indigo',
    });
    await flush(64);
    expect(calls.filter((command) => command === 'fetch_channel').length).toBeGreaterThan(
      channelFetches,
    );
    expect(calls.filter((command) => command === 'fetch_thread').length).toBeGreaterThan(
      replyFetches,
    );

  });

  it('consumes a cold meeting focus id and marks the requested agenda row', async () => {
    await mountShell({ pendingRoute: 'meetings', pendingMeetingId: 'mtg_focus' });
    (host.querySelector('[data-testid="meetings-refresh"]') as HTMLButtonElement).click();
    await flush(64);

    expect(host.querySelector('[data-testid="desktop-alt-meetings"]')).toBeTruthy();
    expect(host.querySelector('[data-meeting-id="mtg_focus"]')?.classList.contains('focused')).toBe(
      true,
    );
  });

  it('carries a warm meeting focus id through the mounted host into the agenda', async () => {
    vi.useFakeTimers();
    try {
      await mountShell();
      warmRoute('meetings');
      await flush();
      (host.querySelector('[data-testid="meetings-refresh"]') as HTMLButtonElement).click();
      await flush(64);

      warmMeetingFocus('mtg_focus');
      await flush(64);
      vi.advanceTimersByTime(1700);

      // A repeated id is a new sequenced focus event, not a no-op assignment.
      warmMeetingFocus('mtg_focus');
      await flush(64);
      vi.advanceTimersByTime(200);
      await flush();
      expect(host.querySelector('[data-meeting-id="mtg_focus"]')?.classList.contains('focused')).toBe(
        true,
      );

      // Leaving through the mounted Meetings UI consumes the request: a later
      // manual visit does not replay an old notification highlight.
      (host.querySelector('[data-testid="meetings-back"]') as HTMLButtonElement).click();
      await flush();
      warmRoute('meetings');
      await flush();
      expect(host.querySelector('[data-meeting-id="mtg_focus"]')?.classList.contains('focused')).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a cold Inbox route active after delayed directory auto-selection', async () => {
    let releaseDirectory: ((value: unknown) => void) | undefined;
    const directoryResponse = new Promise<unknown>((resolve) => {
      releaseDirectory = resolve;
    });
    await mountShell({ pendingRoute: 'inbox', directoryResponse });

    expect(
      host.querySelector('[data-testid="notifications-view"]')?.parentElement?.classList.contains('is-active'),
    ).toBe(true);

    releaseDirectory?.({
      channels: [{ channelId: 'chn_engineering', id: 'chn_engineering', name: 'engineering' }],
    });
    await flush(64);

    expect(
      host.querySelector('[data-testid="notifications-view"]')?.parentElement?.classList.contains('is-active'),
    ).toBe(true);
  });

  it('rehydrates the compact embedded shell from the native OAuth completion event', async () => {
    const auth = { signedIn: false, calls: [] as string[] };
    await mountShell(auth);
    expect(host.querySelector('[data-testid="hq-work-signed-out"]')).toBeTruthy();
    const authProbesBeforeCompletion = auth.calls.filter(
      (command) => command === 'get_auth_state',
    ).length;

    auth.signedIn = true;
    warmAuthSessionReady();
    await flush(64);

    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
    expect(auth.calls.filter((command) => command === 'get_auth_state').length).toBeGreaterThan(
      authProbesBeforeCompletion,
    );
  });

  it('feeds native package update results to Installed and unregisters on lifecycle teardown', async () => {
    const calls: string[] = [];
    await mountShell({ calls });
    warmRoute('library:installed');
    await flush(64);
    expect(nativeListeners.has('packages:updates')).toBe(true);
    expect(calls).toContain('check_package_updates');

    warmPackageUpdates({
      packs: {
        hqRoot: '/tmp/HQ',
        hqVersion: '1.0.0',
        installed: [
          {
            name: 'hq-pack-engineering',
            transport: null,
            contributes: {},
            links: { live: 1, broken: 0, missing: 0, foreign: 0 },
            inCatalog: true,
            updateAvailable: true,
          },
        ],
        available: [],
        warnings: [],
      },
      registry: null,
      error: null,
    });
    await flush();
    expect(host.querySelector('[data-testid="installed-updates-badge"]')?.textContent).toContain(
      '1 update',
    );

    warmRoute('home');
    await flush();
    expect(nativeListeners.has('packages:updates')).toBe(false);
  });

  it('uses the native sign_out command and reroutes the mounted UI to signed-out', async () => {
    const calls: string[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(HqWorkDesktopShell, {
      target: host,
      props: { invokeFn: invokeFor({ pendingRoute: 'settings', calls }) },
    });
    await flush(64);
    expect(nativeListeners.has('share:new-events')).toBe(true);

    (host.querySelector('[data-testid="settings-sign-out"]') as HTMLButtonElement).click();
    await flush();
    (document.querySelector('[data-testid="confirm-dialog-ok"]') as HTMLButtonElement).click();
    await flush();

    expect(calls).toContain('sign_out');
    expect(host.querySelector('[data-testid="hq-work-signed-out"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeNull();
    expect(nativeListeners.has('share:new-events')).toBe(false);

    // The old DesktopApp listener is detached while signed out. A new native
    // route must be queued for the next mounted host rather than dispatched
    // into an unmounted shell and lost.
    warmRoute('settings:appearance');
    (host.querySelector('[data-testid="hq-work-signed-out"] .secondary') as HTMLButtonElement).click();
    await flush(64);
    expect(host.querySelector('[data-testid="settings-host"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="settings-nav-appearance"]')?.getAttribute('aria-current'),
    ).toBe('page');
  });

  it('opens approved Console, company, calendar, OAuth, integration, and meeting-join handoffs', async () => {
    await mountShell({ pendingRoute: 'settings' });

    (host.querySelector('[data-testid="settings-open-console"]') as HTMLButtonElement).click();
    await flush();
    expect(openExternal).toHaveBeenLastCalledWith('https://hq.computer/');

    (host.querySelector('[data-testid="settings-nav-companies"]') as HTMLButtonElement).click();
    await flush();
    (host.querySelector('[data-testid="settings-company-row"] button') as HTMLButtonElement).click();
    await flush();
    expect(openExternal).toHaveBeenLastCalledWith('https://hq.computer/companies/indigo');

    warmRoute('meetings');
    await flush();
    (host.querySelector('[data-testid="meetings-refresh"]') as HTMLButtonElement).click();
    await flush(64);
    (host.querySelector('.meetings-open-cal') as HTMLButtonElement).click();
    await flush();
    expect(openExternal).toHaveBeenLastCalledWith('https://calendar.google.com/');

    (host.querySelector('[data-testid="meetings-connect-calendar"]') as HTMLButtonElement).click();
    await flush();
    expect(openExternal).toHaveBeenLastCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=hq',
    );

    (host.querySelector('[aria-label="Open meeting in browser"]') as HTMLButtonElement).click();
    await flush();
    expect(openExternal).toHaveBeenLastCalledWith('https://meet.google.com/abc-defg-hij');

    (host.querySelector('[data-testid="meetings-manage"]') as HTMLButtonElement).click();
    await flush();
    expect(openExternal).toHaveBeenLastCalledWith('https://hq.computer/personal/integrations');
  });

  it('renders auth expiry, identity failure, and partial-workspace failure with retries', async () => {
    await mountShell({ signedIn: false });
    expect(host.querySelector('[data-testid="hq-work-signed-out"]')).toBeTruthy();
    expect(host.textContent).toContain('Your session expired');

    await unmount(component!);
    component = null;
    host.remove();
    const identity = { identityFailure: true };
    await mountShell(identity);
    expect(host.querySelector('[data-testid="hq-work-identity-error"]')).toBeTruthy();
    identity.identityFailure = false;
    (host.querySelector('[data-testid="hq-work-identity-error"] button') as HTMLButtonElement).click();
    await flush(64);
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();

    await unmount(component!);
    component = null;
    host.remove();
    const workspace = { workspaceFailure: true };
    await mountShell(workspace);
    await flush(64);
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="hq-work-workspace-error"]')).toBeTruthy();
    workspace.workspaceFailure = false;
    (host.querySelector('[data-testid="hq-work-workspace-error"] button') as HTMLButtonElement).click();
    await flush(64);
    expect(host.querySelector('[data-testid="hq-work-workspace-error"]')).toBeNull();
  });
});
