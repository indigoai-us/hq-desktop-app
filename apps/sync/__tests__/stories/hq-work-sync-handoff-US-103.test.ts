// @vitest-environment happy-dom
/**
 * US-103 — Mount embedded @hq/ui DesktopApp behind hq_work_handoff.
 *
 * Tray "Open desktop view" always opens the desktop-alt window. The webview
 * boot is the flag branch: flag on → HQ Work shell, flag off → legacy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const tauriEvents = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload?: unknown }) => void>(),
}));

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('tests must inject invokeFn');
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (payload: { payload?: unknown }) => void) => {
    tauriEvents.listeners.set(event, handler);
    return () => tauriEvents.listeners.delete(event);
  }),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.150'),
  setTheme: vi.fn(async () => {}),
}));

import { flushSync, mount, unmount } from 'svelte';
import { failure, ok, type PlatformAdapter } from '@hq/platform';
import { ChatSidebar, EMBEDDED_NAVIGATION_EVENT, OPEN_SETTINGS_EVENT } from '@hq/ui';
import {
  bootDesktopAltWindow,
  resolveDesktopAltShell,
} from '../../src/desktop-alt/boot';
import {
  applyDesktopAltRoute,
  createHqWorkSidebarApi,
} from '../../src/desktop-alt/hq-work-host';
import HqWorkDesktopShell from '../../src/desktop-alt/HqWorkDesktopShell.svelte';
import {
  hqWorkHandoffEnabled,
  type HqWorkInvoker,
} from '../../src/lib/hq-work';
import { createSyncPlatformAdapter, type SyncInvokeFn } from '@hq/platform';

const WHOAMI = {
  personUid: 'prs_ada',
  email: 'ada@getindigo.ai',
  displayName: 'Ada',
};

function hqProPath(url: unknown): string {
  const raw = String(url ?? '');
  if (raw.startsWith('https://')) {
    try {
      const parsed = new URL(raw);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return raw;
    }
  }
  return raw;
}

function mockInvoke(): SyncInvokeFn {
  return async (cmd, args) => {
    switch (cmd) {
      case 'get_auth_state':
        return {
          authenticated: true,
          accountId: 'acct_ada',
          expiresAt: '2099-01-01T00:00:00Z',
        };
      case 'whoami':
        return WHOAMI;
      case 'desktop_alt_is_admin':
        return true;
      case 'meetings_feature_enabled':
        return true;
      case 'is_indigo_user':
        return false;
      case 'list_syncable_workspaces':
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
        return {
          channels: [
            { channelId: 'chn_1', id: 'chn_1', name: 'general', scope: 'company' },
          ],
        };
      case 'list_contacts':
        return { contacts: [] };
      case 'list_dm_requests':
        return { requests: [] };
      case 'fetch_notifications':
        return { notifications: [] };
      case 'get_settings':
        return {};
      case 'get_config':
        return {};
      case 'desktop_alt_consume_pending_route':
        return null;
      case 'hq_pro_fetch': {
        const path = hqProPath(args?.url);
        if (path.startsWith('/v1/identity/whoami')) {
          return { status: 200, body: JSON.stringify(WHOAMI) };
        }
        if (path.startsWith('/v1/notify/inbox')) {
          return { status: 200, body: JSON.stringify({ events: [] }) };
        }
        if (path.startsWith('/v1/files/shared-with-me')) {
          return { status: 200, body: JSON.stringify({ events: [] }) };
        }
        return { status: 200, body: JSON.stringify({}) };
      }
      default:
        return null;
    }
  };
}

// 32 turns: the identity settle path gained await hops (timeout race +
// reveal/tick) in the boot-loader change, so 12 no longer drains it.
async function flush(times = 32): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  flushSync();
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

interface MessagingCall {
  cmd: string;
  args?: Record<string, unknown>;
}

function messagingInvoke(
  calls: MessagingCall[],
  overrides: Partial<Record<string, (args?: Record<string, unknown>) => unknown>> = {},
): SyncInvokeFn {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    const override = overrides[cmd];
    if (override) return override(args);
    switch (cmd) {
      case 'list_channels':
        return {
          channels: [
            {
              channelId: 'chn_existing',
              id: 'chn_existing',
              name: 'existing',
              scope: 'company',
              lastActivityAt: '2026-08-31T09:00:00.000Z',
            },
          ],
        };
      case 'list_contacts':
        return {
          contacts: [
            {
              personUid: 'prs_bob',
              displayName: 'Bob',
              email: 'bob@example.test',
              lastActivityAt: '2026-08-31T09:00:00.000Z',
            },
          ],
        };
      case 'list_company_members':
        return {
          contacts: [
            {
              personUid: 'prs_bob',
              displayName: 'Bob',
              email: 'bob@example.test',
            },
            {
              personUid: 'prs_eve',
              displayName: 'Eve',
              email: 'eve@example.test',
            },
          ],
        };
      case 'list_dm_requests':
        return { requests: [] };
      case 'create_channel':
        return { channelId: 'chn_created', name: 'release', scope: 'company' };
      case 'search_messages':
        return {
          results: [
            {
              messageId: 'evt_known',
              channelId: 'chn_existing',
              scope: 'channel',
              body: 'known audit result',
              createdAt: '2026-08-31T09:00:00.000Z',
            },
          ],
        };
      case 'send_channel_message':
      case 'send_dm':
      case 'mark_channel_read':
      case 'mark_dm_thread_read':
        return { eventId: 'evt_sent' };
      default:
        throw new Error(`unexpected messaging command: ${cmd}`);
    }
  };
}

function mountMessagingSidebar(invokeFn: SyncInvokeFn): void {
  host = document.createElement('div');
  host.className = 'desktop-shell chat-shell';
  document.body.appendChild(host);
  const adapter = createSyncPlatformAdapter({ invoke: invokeFn });
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: createHqWorkSidebarApi(adapter),
      seedDirectory: [
        {
          channelId: 'chn_existing',
          name: 'existing',
          scope: 'company',
          lastActivityAt: '2026-08-31T09:00:00.000Z',
        },
      ],
      isAdmin: true,
      companies: [
        {
          slug: 'indigo',
          displayName: 'Indigo',
          kind: 'company',
          state: 'synced',
          cloudUid: 'cmp_indigo',
          bucketName: null,
          hasLocalFolder: true,
          localPath: '/tmp/indigo',
          membershipStatus: 'active',
          role: 'owner',
          lastSyncedAt: null,
          brokenReason: null,
          invitedBy: null,
          invitedAt: null,
        },
      ],
    },
  });
}

/** The sidebar "+" opens the unified create modal directly (no dropdown). */
async function openCreateModal(): Promise<void> {
  (host.querySelector('[data-testid="chat-new-message"]') as HTMLButtonElement).click();
  await flush();
}

/** Clear the create modal's 110 ms query debounce. */
async function settleQuery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await flush();
}

function click(selector: string): void {
  const node = document.querySelector(selector) as HTMLButtonElement | null;
  if (!node) throw new Error(`missing ${selector}`);
  node.click();
}

/** Enter the create step for `name` from the find step. */
async function enterCreateStep(name: string): Promise<void> {
  setInput('chat-create-query', name);
  await settleQuery();
  click('[data-testid="chat-create-channel-row"]');
  await flush();
}

/** Pick `name` from the member picker's suggestions. */
async function addMember(name: string): Promise<void> {
  setInput('chat-channel-participants', name);
  await flush();
  click('[data-testid="chat-channel-suggestion"]');
  await flush();
}

/** Click Create and let the sequential member / first-message loop drain. */
async function submitCreate(): Promise<void> {
  click('[data-testid="chat-channel-create"]');
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
}

function summaryRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="chat-create-summary-row"]'),
  );
}

function setInput(testId: string, value: string): void {
  const input = document.querySelector(`[data-testid="${testId}"]`) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  tauriEvents.listeners.clear();
  vi.clearAllMocks();
});

describe('US-103 embedded desktop window', () => {
  describe('flag branch (tray desktop-view → window boot)', () => {
    it('hq_work_handoff still defaults false', () => {
      expect(hqWorkHandoffEnabled(undefined)).toBe(false);
      expect(hqWorkHandoffEnabled(null)).toBe(false);
      expect(hqWorkHandoffEnabled(false)).toBe(false);
      expect(hqWorkHandoffEnabled(true)).toBe(true);
    });

    it('Given flag off, when the tray desktop-view action runs, then legacy desktop-alt mounts', async () => {
      const calls: string[] = [];
      const shell = await bootDesktopAltWindow({
        getHandoff: async () => false,
        mountLegacy: () => {
          calls.push('legacy');
        },
        mountHqWork: () => {
          calls.push('hq-work');
        },
      });
      expect(shell).toBe('legacy');
      expect(await resolveDesktopAltShell(async () => false)).toBe('legacy');
      expect(calls).toEqual(['legacy']);
    });

    it('shows a branded loading mark until identity settles', async () => {
      host = document.createElement('div');
      document.body.appendChild(host);
      let releaseWhoami: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseWhoami = resolve;
      });
      const inner = mockInvoke();
      const invokeFn: SyncInvokeFn = async (cmd, args) => {
        if (cmd === 'whoami') {
          await gate;
        }
        return inner(cmd, args);
      };
      component = mount(HqWorkDesktopShell, {
        target: host,
        props: { invokeFn },
      });
      flushSync();
      expect(host.querySelector('[data-testid="hq-work-boot"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="desktop-shell"]')).toBeNull();
      expect(host.textContent).toContain('HQ');
      releaseWhoami();
      await flush();
      expect(host.querySelector('[data-testid="hq-work-boot"]')).toBeNull();
      expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
    });

    it('Given flag on, when the tray desktop-view action is clicked, then the embedded HQ Work shell renders', async () => {
      host = document.createElement('div');
      document.body.appendChild(host);
      const invokeFn = mockInvoke();
      const calls: string[] = [];
      const shell = await bootDesktopAltWindow({
        getHandoff: async () => true,
        mountLegacy: () => {
          calls.push('legacy');
        },
        mountHqWork: () => {
          calls.push('hq-work');
          component = mount(HqWorkDesktopShell, {
            target: host,
            props: { invokeFn },
          });
        },
      });
      expect(shell).toBe('hq-work');
      expect(calls).toEqual(['hq-work']);
      flushSync();
      await flush();
      expect(host.querySelector('[data-testid="hq-work-embedded-shell"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="chat-sidebar"]')).toBeTruthy();
    });

    it('flag-read failure falls back to the legacy desktop-alt shell', async () => {
      const shell = await bootDesktopAltWindow({
        getHandoff: async () => {
          throw new Error('menubar missing');
        },
        mountLegacy: () => undefined,
        mountHqWork: () => {
          throw new Error('must not mount HQ Work when the flag cannot be read');
        },
      });
      expect(shell).toBe('legacy');
    });

    it('finding-6: flag-off boot does not probe install or mount the HQ Work shell', async () => {
      const invokeFn = vi.fn(async (command: string) => {
        throw new Error(`flag-off boot must not invoke ${command}`);
      }) as HqWorkInvoker;
      const shell = await bootDesktopAltWindow({
        getHandoff: async () => false,
        mountLegacy: () => undefined,
        mountHqWork: () => {
          throw new Error('must not mount HQ Work when flag is off');
        },
      });
      expect(shell).toBe('legacy');
      expect(invokeFn).not.toHaveBeenCalled();
    });
  });

  describe('embedded settings', () => {
    it('⌘, opens the embedded settings surface', async () => {
      host = document.createElement('div');
      document.body.appendChild(host);
      component = mount(HqWorkDesktopShell, {
        target: host,
        props: { invokeFn: mockInvoke() },
      });
      flushSync();
      await flush();
      expect(host.querySelector('[data-testid="settings-host"]')).toBeNull();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }),
      );
      flushSync();
      await flush();
      expect(host.querySelector('[data-testid="settings-host"]')).toBeTruthy();
    });

    it('rechecks authoritative version state when the native host emits an update edge', async () => {
      host = document.createElement('div');
      document.body.appendChild(host);
      const calls: string[] = [];
      const baseInvoke = mockInvoke();
      const invokeFn: SyncInvokeFn = async (command, args) => {
        calls.push(command);
        return baseInvoke(command, args);
      };
      component = mount(HqWorkDesktopShell, {
        target: host,
        props: { invokeFn },
      });
      await flush(24);

      window.dispatchEvent(
        new CustomEvent(EMBEDDED_NAVIGATION_EVENT, {
          detail: { kind: 'settings', section: 'updates' },
        }),
      );
      await flush(24);
      expect(host.querySelector('[data-testid="settings-updates-pane"]')).toBeTruthy();
      const before = calls.filter((command) => command === 'check_for_updates').length;
      const listener = tauriEvents.listeners.get('hq-cli-update:available');
      expect(listener).toBeTypeOf('function');
      listener?.({ payload: { latest: '5.104.0' } });
      await flush(24);
      expect(calls.filter((command) => command === 'check_for_updates')).toHaveLength(before + 1);
    });

    it('does not recursively restart an Updates probe when that probe emits core-state:changed', async () => {
      host = document.createElement('div');
      document.body.appendChild(host);
      const baseInvoke = mockInvoke();
      let coreChecks = 0;
      const invokeFn: SyncInvokeFn = async (command, args) => {
        if (command === 'check_core_state') {
          coreChecks += 1;
          if (coreChecks === 1) {
            tauriEvents.listeners.get('core-state:changed')?.({ payload: { versionBehind: false } });
          }
          return { versionBehind: false };
        }
        return baseInvoke(command, args);
      };
      component = mount(HqWorkDesktopShell, { target: host, props: { invokeFn } });
      await flush(24);
      window.dispatchEvent(
        new CustomEvent(EMBEDDED_NAVIGATION_EVENT, {
          detail: { kind: 'settings', section: 'updates' },
        }),
      );
      await flush(24);

      expect(coreChecks).toBe(1);
    });

    it('rotates the mounted Settings profile and company scope with the authoritative auth session', async () => {
      let active: 'ada' | 'grace' = 'ada';
      const identities = {
        ada: {
          accountId: 'acct_ada',
          generation: 1,
          personUid: 'prs_ada',
          displayName: 'Ada',
          email: 'ada@getindigo.ai',
          companyUid: 'cmp_ada',
          companyName: 'Ada Org',
        },
        grace: {
          accountId: 'acct_grace',
          generation: 2,
          personUid: 'prs_grace',
          displayName: 'Grace',
          email: 'grace@getindigo.ai',
          companyUid: 'cmp_grace',
          companyName: 'Grace Org',
        },
      } as const;
      const fallback = mockInvoke();
      const invokeFn: SyncInvokeFn = async (command, args) => {
        const identity = identities[active];
        if (command === 'get_auth_session') {
          return {
            status: 'active',
            accountId: identity.accountId,
            generation: identity.generation,
          };
        }
        if (command === 'list_syncable_workspaces') {
          return {
            workspaces: [
              {
                companyUid: identity.companyUid,
                companySlug: identity.companyName.toLowerCase().replace(' ', '-'),
                companyName: identity.companyName,
                status: 'active',
                role: 'member',
              },
            ],
          };
        }
        if (command === 'whoami') {
          return {
            personUid: identity.personUid,
            displayName: identity.displayName,
            email: identity.email,
          };
        }
        return fallback(command, args);
      };

      host = document.createElement('div');
      document.body.appendChild(host);
      component = mount(HqWorkDesktopShell, { target: host, props: { invokeFn } });
      await flush(36);
      window.dispatchEvent(
        new CustomEvent(EMBEDDED_NAVIGATION_EVENT, {
          detail: { kind: 'settings', section: 'profile' },
        }),
      );
      await flush(24);
      expect(
        host.querySelector<HTMLInputElement>('[data-testid="settings-display-name-input"]')?.value,
      ).toBe('Ada');

      active = 'grace';
      tauriEvents.listeners.get('auth:session-changed')?.({
        payload: { status: 'active', accountId: 'acct_grace', generation: 2 },
      });
      await flush(40);
      window.dispatchEvent(
        new CustomEvent(EMBEDDED_NAVIGATION_EVENT, {
          detail: { kind: 'settings', section: 'companies' },
        }),
      );
      await flush(24);

      expect(host.querySelector('[data-testid="settings-companies-pane"]')?.textContent).toContain('Grace Org');
      expect(host.querySelector('[data-testid="settings-companies-pane"]')?.textContent).not.toContain('Ada Org');
      window.dispatchEvent(
        new CustomEvent(EMBEDDED_NAVIGATION_EVENT, {
          detail: { kind: 'settings', section: 'profile' },
        }),
      );
      await flush(24);
      expect(
        host.querySelector<HTMLInputElement>('[data-testid="settings-display-name-input"]')?.value,
      ).toBe('Grace');
    });

    it('applyDesktopAltRoute emits typed subsection targets instead of flattening them', () => {
      const seen: string[] = [];
      const targets: unknown[] = [];
      const onSettings = () => {
        seen.push('settings');
      };
      const onEmbedded = (event: Event) => {
        targets.push((event as CustomEvent).detail);
      };
      window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
      window.addEventListener(EMBEDDED_NAVIGATION_EVENT, onEmbedded);
      applyDesktopAltRoute(null);
      applyDesktopAltRoute('meetings');
      applyDesktopAltRoute('settings');
      applyDesktopAltRoute('settings:updates');
      applyDesktopAltRoute('settings/general');
      window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
      window.removeEventListener(EMBEDDED_NAVIGATION_EVENT, onEmbedded);
      expect(seen).toEqual(['settings']);
      expect(targets).toEqual([
        { kind: 'meetings' },
        { kind: 'settings', section: 'updates' },
        { kind: 'settings', section: 'general' },
      ]);
    });
  });

  describe('sidebar host bridge', () => {
    it('maps typed registry installation to the native registry command arguments', async () => {
      const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
      const adapter = createSyncPlatformAdapter({
        invoke: async (command, args) => {
          calls.push({ command, args });
          return null;
        },
      });

      await adapter.packages.install({ source: 'hq-pack-engineering', registry: true });

      expect(calls).toEqual([
        {
          command: 'install_package',
          args: { source: 'hq-pack-engineering', registry: true },
        },
      ]);
    });

    it('maps list_channels payloads onto a directory snapshot', async () => {
      const adapter = createSyncPlatformAdapter({
        invoke: async (cmd) => {
          if (cmd === 'list_channels') {
            return {
              channels: [{ id: 'chn_1', name: 'general', scope: 'company' }],
            };
          }
          throw new Error(`unexpected ${cmd}`);
        },
      });
      const api = createHqWorkSidebarApi(adapter);
      const feed = await api.fetchChannelDirectory(null);
      expect(feed.snapshot).toBe(true);
      expect(feed.rows?.some((row) => row.channelId === 'chn_1')).toBe(true);
    });

    it('surfaces adapter failures instead of swallowing them', async () => {
      const adapter = {
        messaging: {
          fetchChannelDirectory: async () => failure('invoke', 'boom'),
        },
      } as unknown as PlatformAdapter;
      const api = createHqWorkSidebarApi(adapter);
      await expect(api.fetchChannelDirectory(null)).rejects.toThrow(/boom/);
    });

    it('ok() directory passthrough still works', async () => {
      const adapter = {
        messaging: {
          fetchChannelDirectory: async () =>
            ok({
              snapshot: true,
              cursor: 'a'.repeat(32),
              cursorExpiresAt: '2099-01-01T00:00:00Z',
              rows: [
                {
                  channelId: 'chn_2',
                  name: 'ops',
                  scope: 'company',
                  lastActivityAt: null,
                },
              ],
            }),
        },
      } as unknown as PlatformAdapter;
      const api = createHqWorkSidebarApi(adapter);
      const feed = await api.fetchChannelDirectory(null);
      expect(feed.rows?.[0]?.channelId).toBe('chn_2');
    });

    it('normalizes the native search_messages envelope before the sidebar host wraps it', async () => {
      const hit = {
        messageId: 'evt_native',
        channelId: 'chn_existing',
        scope: 'channel',
        body: 'native result',
        createdAt: '2026-08-31T09:00:00.000Z',
      };
      const adapter = createSyncPlatformAdapter({
        invoke: async (cmd) => {
          if (cmd === 'search_messages') return { results: [hit] };
          throw new Error(`unexpected ${cmd}`);
        },
      });

      await expect(
        createHqWorkSidebarApi(adapter).searchMessages({ q: 'native' }),
      ).resolves.toEqual({ results: [hit] });
    });
  });

  describe('F-04 embedded messaging semantics', () => {
    // The old "New message" compose modal (To + body + Send) is gone. The "+"
    // opens ONE search-first create modal: an existing channel or person is
    // OPENED (never messaged from the modal), and an unmatched name creates a
    // channel whose optional "What's this for?" body is its first message.
    // Every guarantee below is the old F-04 guarantee restated for that flow.

    it('opens a picked existing channel exactly once and closes the create modal', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(messagingInvoke(calls));
      await flush();
      await openCreateModal();
      setInput('chat-create-query', 'existing');
      await settleQuery();
      // The rail auto-opens its first row on mount; only count the pick.
      const before = calls.length;
      click('[data-testid="chat-create-result"]');
      await flush();

      expect(calls.slice(before).filter((call) => call.cmd === 'mark_channel_read')).toEqual([
        { cmd: 'mark_channel_read', args: { channelId: 'chn_existing' } },
      ]);
      // Nothing is composed for an existing conversation — opening it is the action.
      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toEqual([]);
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
    });

    it('opens a picked existing DM exactly once and closes the create modal', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(messagingInvoke(calls));
      await flush();
      await openCreateModal();
      setInput('chat-create-query', 'Bob');
      await settleQuery();
      const bob = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-create-result"]'),
      ).find((node) => node.textContent?.includes('Bob'));
      expect(bob?.textContent).toContain('bob@example.test');
      bob?.click();
      await flush();

      expect(calls.filter((call) => call.cmd === 'mark_dm_thread_read')).toEqual([
        { cmd: 'mark_dm_thread_read', args: { withPersonUid: 'prs_bob' } },
      ]);
      expect(calls.filter((call) => call.cmd === 'send_dm')).toEqual([]);
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
    });

    it('never acts on a stale result after the visible query changes', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(messagingInvoke(calls));
      await flush();
      await openCreateModal();
      setInput('chat-create-query', 'existing');
      await settleQuery();
      expect(document.querySelector('[data-testid="chat-create-result"]')?.textContent).toContain(
        'existing',
      );

      // Retyping replaces the result list; Enter activates what is VISIBLE.
      setInput('chat-create-query', 'Bob');
      await settleQuery();
      const before = calls.length;
      const input = document.querySelector('[data-testid="chat-create-query"]') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flush();

      const after = calls.slice(before);
      expect(after.filter((call) => call.cmd === 'mark_channel_read')).toEqual([]);
      expect(after.filter((call) => call.cmd === 'mark_dm_thread_read')).toEqual([
        { cmd: 'mark_dm_thread_read', args: { withPersonUid: 'prs_bob' } },
      ]);
    });

    it('refuses to dismiss while a create is in flight, then opens the channel once it lands', async () => {
      const calls: MessagingCall[] = [];
      const pending = deferred<{ eventId: string }>();
      mountMessagingSidebar(
        messagingInvoke(calls, {
          send_channel_message: () => pending.promise,
        }),
      );
      await flush();
      await openCreateModal();
      await enterCreateStep('#release');
      setInput('chat-channel-first-message', 'in-flight draft');
      await flush();
      click('[data-testid="chat-channel-create"]');
      await flush();

      // A completion from a torn-down instance used to close/clear a NEWER
      // draft. There is no newer instance now: × and the backdrop are inert
      // until the host answers, so the outcome always lands where it started.
      const close = document.querySelector(
        '[data-testid="chat-create-modal"] [aria-label="Close"]',
      ) as HTMLButtonElement;
      expect(close.disabled).toBe(true);
      close.click();
      await flush();
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeTruthy();
      expect(
        (document.querySelector('[data-testid="chat-channel-first-message"]') as HTMLTextAreaElement)
          .value,
      ).toBe('in-flight draft');

      pending.resolve({ eventId: 'evt_sent' });
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();

      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toEqual([
        {
          cmd: 'send_channel_message',
          args: { channelId: 'chn_created', body: 'in-flight draft' },
        },
      ]);
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
    });

    it('reports a late first-message failure on the summary instead of losing it', async () => {
      const calls: MessagingCall[] = [];
      const pending = deferred<{ eventId: string }>();
      mountMessagingSidebar(
        messagingInvoke(calls, {
          send_channel_message: () => pending.promise,
        }),
      );
      await flush();
      await openCreateModal();
      await enterCreateStep('#release');
      setInput('chat-channel-first-message', 'old draft');
      await flush();
      click('[data-testid="chat-channel-create"]');
      await flush();

      pending.reject(new Error('old send failed'));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();

      const summary = document.querySelector('[data-testid="chat-create-summary"]');
      expect(summary).toBeTruthy();
      expect(summary?.textContent).toContain("didn't send");
      expect(summary?.textContent).toContain('old draft');
      // The raw host error is not surfaced until the user retries and it fails again.
      expect(document.querySelector('[data-testid="chat-create-summary-error"]')).toBeNull();
    });

    it('retains a failed first-message draft and offers a retry that reports its own failure', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(
        messagingInvoke(calls, {
          send_channel_message: () => {
            throw new Error('network unavailable');
          },
        }),
      );
      await flush();
      await openCreateModal();
      await enterCreateStep('#release');
      setInput('chat-channel-first-message', 'do not lose me');
      await flush();
      await submitCreate();

      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeTruthy();
      expect(document.querySelector('[data-testid="chat-create-summary"]')?.textContent).toContain(
        'do not lose me',
      );
      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toHaveLength(1);

      click('[data-testid="chat-create-summary-action"]');
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();

      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toHaveLength(2);
      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(
        document.querySelector('[data-testid="chat-create-summary-error"]')?.textContent,
      ).toContain('network unavailable');
      expect(document.querySelector('[data-testid="chat-create-summary"]')?.textContent).toContain(
        'do not lose me',
      );
    });

    it('sends a composed first message after channel creation and does not drop it', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(messagingInvoke(calls));
      await flush();
      await openCreateModal();
      await enterCreateStep('#release');
      setInput('chat-channel-first-message', 'announce release');
      await flush();
      await submitCreate();

      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toEqual([
        {
          cmd: 'send_channel_message',
          args: { channelId: 'chn_created', body: 'announce release' },
        },
      ]);
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
    });

    it('never re-creates the channel when the first message fails; only an explicit retry re-sends', async () => {
      const calls: MessagingCall[] = [];
      let sendAttempts = 0;
      mountMessagingSidebar(
        messagingInvoke(calls, {
          send_channel_message: () => {
            sendAttempts += 1;
            // Model a write that reached the server followed by a dropped
            // response. The client must not silently POST again.
            throw new Error('response lost after accepted write');
          },
        }),
      );
      await flush();
      await openCreateModal();
      await enterCreateStep('#release');
      setInput('chat-channel-first-message', 'keep this first post');
      await flush();
      await submitCreate();

      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(sendAttempts).toBe(1);
      // The channel exists and is accounted for; the draft is still on screen.
      const summary = document.querySelector('[data-testid="chat-create-summary"]');
      expect(summary?.textContent).toContain('#release is ready');
      expect(summary?.textContent).toContain('keep this first post');
      expect(host.textContent).toContain('release');

      // A second send is a deliberate user action, never automatic — and it
      // resumes THIS channel rather than creating another.
      click('[data-testid="chat-create-summary-action"]');
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();
      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(sendAttempts).toBe(2);
      expect(document.querySelector('[data-testid="chat-create-summary"]')).toBeTruthy();

      click('[data-testid="chat-create-summary-done"]');
      await flush();
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
    });

    it('persists the created channel before invite N and retries only incomplete invitations', async () => {
      const calls: MessagingCall[] = [];
      let eveAttempts = 0;
      mountMessagingSidebar(
        messagingInvoke(calls, {
          list_contacts: () => ({
            contacts: [
              {
                personUid: 'prs_bob',
                displayName: 'Bob',
                email: 'bob@example.test',
                lastActivityAt: '2026-08-31T09:00:00.000Z',
              },
              {
                personUid: 'prs_eve',
                displayName: 'Eve',
                email: 'eve@example.test',
                lastActivityAt: '2026-08-31T09:00:00.000Z',
              },
            ],
          }),
          invite_to_channel: ({ personUids }) => {
            if (personUids[0] === 'prs_eve' && eveAttempts++ === 0) {
              return Promise.reject(new Error('Eve invite timed out'));
            }
            return { members: [] };
          },
        }),
      );
      await flush();
      await openCreateModal();
      await enterCreateStep('#release');
      await addMember('Bob');
      await addMember('Eve');
      expect(document.querySelectorAll('[data-testid="chat-channel-chip"]')).toHaveLength(2);

      await submitCreate();

      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      // One rejection does not abort the loop, and the created id is pinned
      // before the first invite so every retry resumes the same channel.
      expect(calls.filter((call) => call.cmd === 'invite_to_channel')).toEqual([
        { cmd: 'invite_to_channel', args: { channelId: 'chn_created', personUids: ['prs_bob'] } },
        { cmd: 'invite_to_channel', args: { channelId: 'chn_created', personUids: ['prs_eve'] } },
      ]);
      expect(eveAttempts).toBe(1);
      const rows = summaryRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('Eve');

      click('[data-testid="chat-create-summary-action"]');
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();

      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(calls.filter((call) => call.cmd === 'invite_to_channel')).toEqual([
        { cmd: 'invite_to_channel', args: { channelId: 'chn_created', personUids: ['prs_bob'] } },
        { cmd: 'invite_to_channel', args: { channelId: 'chn_created', personUids: ['prs_eve'] } },
        { cmd: 'invite_to_channel', args: { channelId: 'chn_created', personUids: ['prs_eve'] } },
      ]);
      expect(eveAttempts).toBe(2);
      expect(summaryRows()[0].textContent).toContain('Added.');

      click('[data-testid="chat-create-summary-done"]');
      await flush();
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
    });

    it('renders the native Sync search result envelope exactly once', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(messagingInvoke(calls));
      await flush();
      (host.querySelector('[data-testid="chat-show-history"]') as HTMLButtonElement).click();
      await flush();
      setInput('chat-history-search', 'known');
      await new Promise((resolve) => setTimeout(resolve, 260));
      await flush();

      expect(calls.some((call) => call.cmd === 'search_messages')).toBe(true);
      expect(document.querySelector('[data-testid="chat-search-hit"]')?.textContent).toContain('known audit result');
    });

    it('passes owner company-project options through the mounted UI, host, adapter, and Tauri command', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(
        messagingInvoke(calls, {
          list_channels: (args) =>
            args?.companyUid === 'cmp_indigo' && args.includeCompanyProjects === true
              ? {
                  channels: [
                    {
                      channelId: 'chn_project',
                      id: 'chn_project',
                      name: 'owner-project',
                      scope: 'project',
                      companyUid: 'cmp_indigo',
                      lastActivityAt: '2026-08-31T10:00:00.000Z',
                    },
                  ],
                }
              : { channels: [] },
        }),
      );
      await flush();
      (host.querySelector('[data-testid="chat-filter"]') as HTMLButtonElement).click();
      await flush();
      (document.querySelector('[data-testid="chat-filter-company-projects"]') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await flush();

      expect(calls).toContainEqual({
        cmd: 'list_channels',
        args: { companyUid: 'cmp_indigo', includeCompanyProjects: true },
      });
      expect(host.textContent).toContain('owner-project');
    });
  });
});
