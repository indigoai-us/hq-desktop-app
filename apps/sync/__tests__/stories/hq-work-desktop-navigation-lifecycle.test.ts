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
    return () => nativeListeners.delete(name);
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
  session?: {
    accountId: string;
    whoami: { personUid: string; email: string; displayName: string };
    workspaces?: Promise<unknown>;
  };
  authSession?: unknown;
  calls?: string[];
  workspaceFailure?: boolean;
  identityFailure?: boolean;
  directoryResponse?: Promise<unknown>;
  sendChannelResponse?: Promise<unknown>;
}

function invokeFor(options: Options = {}): SyncInvokeFn {
  return async (command, args) => {
    options.calls?.push(command);
    switch (command) {
      case 'get_auth_session':
        return options.authSession ?? null;
      case 'get_auth_state':
        return {
          authenticated: options.signedIn ?? true,
          accountId: options.session?.accountId ?? 'acct_ada',
        };
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
        if (options.session?.workspaces) return options.session.workspaces;
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
      case 'send_channel_message':
        return options.sendChannelResponse ?? { eventId: 'evt_sent' };
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
      case 'fetch_notifications':
        return { notifications: [] };
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
          return {
            status: 200,
            body: JSON.stringify(options.session?.whoami ?? WHOAMI),
          };
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

async function flush(times = 64): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  flushSync();
}

function setInput(testId: string, value: string): void {
  const input = document.querySelector(`[data-testid="${testId}"]`) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

function warmAuthSessionChanged(payload: unknown): void {
  const listener = nativeListeners.get('auth:session-changed');
  if (!listener) throw new Error('auth:session-changed listener was not registered');
  listener({ payload });
}

function warmPackageUpdates(payload: unknown): void {
  const listener = nativeListeners.get('packages:updates');
  if (!listener) throw new Error('packages:updates listener was not registered');
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

  it('keeps automatic Inbox hydration and a replacement compose draft intact across a delayed send', async () => {
    let releaseDirectory: ((value: unknown) => void) | undefined;
    const directoryResponse = new Promise<unknown>((resolve) => {
      releaseDirectory = resolve;
    });
    let releaseSend: ((value: unknown) => void) | undefined;
    const sendChannelResponse = new Promise<unknown>((resolve) => {
      releaseSend = resolve;
    });
    await mountShell({ pendingRoute: 'inbox', directoryResponse, sendChannelResponse });

    releaseDirectory?.({
      channels: [{ channelId: 'chn_engineering', id: 'chn_engineering', name: 'engineering' }],
    });
    await flush(64);

    // The channel directory's automatic first-row selection must not pull a
    // host-selected Inbox back to Messages.
    expect(
      host.querySelector('[data-testid="notifications-view"]')?.parentElement?.classList.contains('is-active'),
    ).toBe(true);

    (host.querySelector('[data-testid="chat-new-message"]') as HTMLButtonElement).click();
    await flush();
    (document.querySelector('[data-testid="chat-plus-new-message"]') as HTMLButtonElement).click();
    await flush();
    setInput('chat-compose-to', 'engineering');
    setInput('chat-compose-body', 'old delayed draft');
    await flush();
    (document.querySelector('[data-testid="chat-compose-suggestion"]') as HTMLButtonElement).click();
    await flush();
    (document.querySelector('[data-testid="chat-compose-send"]') as HTMLButtonElement).click();
    await flush();

    // Start a newer compose instance while the old host send is still in
    // flight. Its completion must not close or clear this replacement draft.
    (document.querySelector('[data-testid="chat-new-message-modal"] [aria-label="Close"]') as HTMLButtonElement).click();
    await flush();
    (host.querySelector('[data-testid="chat-new-message"]') as HTMLButtonElement).click();
    await flush();
    (document.querySelector('[data-testid="chat-plus-new-message"]') as HTMLButtonElement).click();
    await flush();
    setInput('chat-compose-to', 'engineering');
    setInput('chat-compose-body', 'new replacement draft');
    await flush();

    releaseSend?.({ eventId: 'evt_old' });
    await flush(64);

    expect(
      host.querySelector('[data-testid="notifications-view"]')?.parentElement?.classList.contains('is-active'),
    ).toBe(true);
    expect(document.querySelector('[data-testid="chat-new-message-modal"]')).toBeTruthy();
    expect((document.querySelector('[data-testid="chat-compose-to"]') as HTMLInputElement).value).toBe(
      'engineering',
    );
    expect((document.querySelector('[data-testid="chat-compose-body"]') as HTMLTextAreaElement).value).toBe(
      'new replacement draft',
    );
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
    await flush();

    (host.querySelector('[data-testid="settings-sign-out"]') as HTMLButtonElement).click();
    await flush();
    (document.querySelector('[data-testid="confirm-dialog-ok"]') as HTMLButtonElement).click();
    await flush();

    expect(calls).toContain('sign_out');
    expect(host.querySelector('[data-testid="hq-work-signed-out"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeNull();

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

  it('synchronously clears account A and rejects its late workspace completion after native switches to B', async () => {
    let releaseAWorkspaces: ((value: unknown) => void) | undefined;
    const account: NonNullable<Options['session']> = {
      accountId: 'acct_ada',
      whoami: WHOAMI,
      workspaces: new Promise<unknown>((resolve) => {
        releaseAWorkspaces = resolve;
      }),
    };
    await mountShell({ session: account });
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();

    account.accountId = 'acct_grace';
    account.whoami = {
      personUid: 'prs_grace',
      email: 'grace@example.test',
      displayName: 'Grace Hopper',
    };
    warmAuthSessionChanged({
      accountId: 'acct_grace',
      generation: 2,
      status: 'active',
      reason: 'account changed',
    });

    // The tenant boundary is synchronous: no A-labelled renderer stays mounted
    // while the B identity/profile/workspaces loads.
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeNull();
    expect(host.querySelector('[data-testid="hq-work-loading"]')).toBeTruthy();

    releaseAWorkspaces?.({
      workspaces: [
        { slug: 'indigo', cloudUid: 'cmp_indigo', role: 'owner', membershipStatus: 'active' },
      ],
    });
    await flush(64);

    warmRoute('settings');
    await flush(64);
    expect(
      (host.querySelector('[data-testid="settings-display-name-input"]') as HTMLInputElement)
        .value,
    ).toBe('Grace');
  });

  it('retries only the recoverable native refresh state on coalesced online/focus recovery', async () => {
    const calls: string[] = [];
    const auth: Options = {
      calls,
      authSession: {
        accountId: 'acct_ada',
        generation: 1,
        status: 'refresh_temporarily_unavailable',
        reason: 'network unavailable',
      },
    };
    await mountShell(auth);
    expect(host.querySelector('[data-testid="hq-work-auth-recovery"]')).toBeTruthy();
    const before = calls.filter((command) => command === 'get_auth_session').length;

    auth.authSession = {
      accountId: 'acct_ada',
      generation: 2,
      status: 'active',
      reason: null,
    };
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    await flush(64);

    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
    // Both browser recovery signals share one in-flight revalidation. The
    // second lookup is the nested B-generation hydration, not a second focus
    // or online request.
    expect(calls.filter((command) => command === 'get_auth_session').length).toBe(before + 2);
  });

  it('keeps a ready shell mounted and on its destination during ordinary browser wakeups', async () => {
    const calls: string[] = [];
    await mountShell({ calls });
    warmRoute('settings:appearance');
    await flush();
    const before = calls.filter((command) => command === 'get_auth_session').length;

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush(64);

    expect(calls.filter((command) => command === 'get_auth_session').length).toBe(before);
    expect(host.querySelector('[data-testid="hq-work-loading"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="settings-nav-appearance"]')?.getAttribute('aria-current'),
    ).toBe('page');
  });

  it('keeps invalid credentials fail closed until the user explicitly retries', async () => {
    const calls: string[] = [];
    const auth: Options = {
      calls,
      authSession: {
        accountId: 'acct_ada',
        generation: 1,
        status: 'credentials_invalid',
        reason: 'refresh token rejected',
      },
    };
    await mountShell(auth);
    expect(host.querySelector('[data-testid="hq-work-signed-out"]')).toBeTruthy();
    expect(host.textContent).toContain('sign-in is no longer valid');
    const beforeAutomaticRecovery = calls.filter(
      (command) => command === 'get_auth_session',
    ).length;

    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(calls.filter((command) => command === 'get_auth_session').length).toBe(
      beforeAutomaticRecovery,
    );

    auth.authSession = {
      accountId: 'acct_ada',
      generation: 2,
      status: 'active',
      reason: null,
    };
    const retry = host.querySelector(
      '[data-testid="hq-work-signed-out"] button.secondary',
    ) as HTMLButtonElement;
    retry.click();
    await flush(64);

    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
  });
});
