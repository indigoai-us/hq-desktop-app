// @vitest-environment happy-dom
/**
 * US-103 — Mount embedded @hq/ui DesktopApp behind hq_work_handoff.
 *
 * Tray "Open desktop view" always opens the desktop-alt window. The webview
 * boot is the flag branch: flag on → HQ Work shell, flag off → legacy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.150'),
  setTheme: vi.fn(async () => {}),
}));

import { flushSync, mount, unmount } from 'svelte';
import { failure, ok, type PlatformAdapter } from '@hq/platform';
import { ChatSidebar, OPEN_SETTINGS_EVENT } from '@hq/ui';
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
import { createSyncPlatformAdapter, type SyncInvokeFn } from '../../src/lib/hq-work-adapter';

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
        return { authenticated: true, expiresAt: '2099-01-01T00:00:00Z' };
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

async function flush(times = 12): Promise<void> {
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
      case 'list_dm_requests':
        return { requests: [] };
      case 'create_channel':
        return { channelId: 'chn_created', name: 'release', scope: 'company' };
      case 'search_messages':
        return [
          {
            messageId: 'evt_known',
            channelId: 'chn_existing',
            scope: 'channel',
            body: 'known audit result',
            createdAt: '2026-08-31T09:00:00.000Z',
          },
        ];
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

async function openNewMessage(): Promise<void> {
  (host.querySelector('[data-testid="chat-new-message"]') as HTMLButtonElement).click();
  await flush();
  (host.querySelector('[data-testid="chat-plus-new-message"]') as HTMLButtonElement).click();
  await flush();
}

function setInput(testId: string, value: string): void {
  const input = document.querySelector(`[data-testid="${testId}"]`) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
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

    it('applyDesktopAltRoute maps settings and settings:updates onto OPEN_SETTINGS_EVENT', () => {
      const seen: string[] = [];
      const onSettings = () => {
        seen.push('settings');
      };
      window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
      applyDesktopAltRoute(null);
      applyDesktopAltRoute('meetings');
      applyDesktopAltRoute('settings');
      applyDesktopAltRoute('settings:updates');
      applyDesktopAltRoute('settings/general');
      window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
      expect(seen).toEqual(['settings', 'settings', 'settings']);
    });
  });

  describe('sidebar host bridge', () => {
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
  });

  describe('F-04 embedded messaging semantics', () => {
    it('sends a selected existing channel body exactly once before closing the compose modal', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(messagingInvoke(calls));
      await flush();
      await openNewMessage();
      setInput('chat-compose-to', 'existing');
      setInput('chat-compose-body', 'ship this once');
      await flush();
      (document.querySelector('[data-testid="chat-compose-suggestion"]') as HTMLButtonElement).click();
      await flush();
      (document.querySelector('[data-testid="chat-compose-send"]') as HTMLButtonElement).click();
      await flush();

      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toEqual([
        {
          cmd: 'send_channel_message',
          args: { channelId: 'chn_existing', body: 'ship this once' },
        },
      ]);
      expect(document.querySelector('[data-testid="chat-new-message-modal"]')).toBeNull();
    });

    it('sends a selected existing DM body exactly once before closing the compose modal', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(messagingInvoke(calls));
      await flush();
      await openNewMessage();
      setInput('chat-compose-to', 'Bob');
      setInput('chat-compose-body', 'hello Bob');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flush();
      (document.querySelector('[data-testid="chat-compose-suggestion"]') as HTMLButtonElement).click();
      await flush();
      (document.querySelector('[data-testid="chat-compose-send"]') as HTMLButtonElement).click();
      await flush();

      expect(calls.filter((call) => call.cmd === 'send_dm')).toEqual([
        {
          cmd: 'send_dm',
          args: { toPersonUid: 'prs_bob', body: 'hello Bob' },
        },
      ]);
      expect(document.querySelector('[data-testid="chat-new-message-modal"]')).toBeNull();
    });

    it('retains a failed existing-message draft and shows a retryable error', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(
        messagingInvoke(calls, {
          send_channel_message: () => {
            throw new Error('network unavailable');
          },
        }),
      );
      await flush();
      await openNewMessage();
      setInput('chat-compose-to', 'existing');
      setInput('chat-compose-body', 'do not lose me');
      await flush();
      (document.querySelector('[data-testid="chat-compose-suggestion"]') as HTMLButtonElement).click();
      await flush();
      (document.querySelector('[data-testid="chat-compose-send"]') as HTMLButtonElement).click();
      await flush();

      expect(document.querySelector('[data-testid="chat-new-message-modal"]')).toBeTruthy();
      expect((document.querySelector('[data-testid="chat-compose-body"]') as HTMLTextAreaElement).value).toBe('do not lose me');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('network unavailable');
      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toHaveLength(1);
    });

    it('sends a composed first message after channel creation and does not drop it', async () => {
      const calls: MessagingCall[] = [];
      mountMessagingSidebar(messagingInvoke(calls));
      await flush();
      await openNewMessage();
      setInput('chat-compose-to', '#release');
      setInput('chat-compose-body', 'announce release');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flush();
      (document.querySelector('[data-testid="chat-compose-create-channel"]') as HTMLButtonElement).click();
      await flush();
      (document.querySelector('[data-testid="chat-channel-create"]') as HTMLButtonElement).click();
      await flush();

      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toEqual([
        {
          cmd: 'send_channel_message',
          args: { channelId: 'chn_created', body: 'announce release' },
        },
      ]);
    });

    it('keeps the first-message draft actionable when channel creation succeeds but send fails', async () => {
      const calls: MessagingCall[] = [];
      let sendAttempts = 0;
      mountMessagingSidebar(
        messagingInvoke(calls, {
          send_channel_message: () => {
            sendAttempts += 1;
            if (sendAttempts === 1) throw new Error('send failed');
            return { eventId: 'evt_sent' };
          },
        }),
      );
      await flush();
      await openNewMessage();
      setInput('chat-compose-to', '#release');
      setInput('chat-compose-body', 'keep this first post');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flush();
      (document.querySelector('[data-testid="chat-compose-create-channel"]') as HTMLButtonElement).click();
      await flush();
      (document.querySelector('[data-testid="chat-channel-create"]') as HTMLButtonElement).click();
      await flush();

      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(document.querySelector('[data-testid="chat-new-channel-modal"]')).toBeTruthy();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('send failed');
      expect(document.body.textContent).toContain('keep this first post');

      (document.querySelector('[data-testid="chat-channel-create"]') as HTMLButtonElement).click();
      await flush();
      expect(calls.filter((call) => call.cmd === 'create_channel')).toHaveLength(1);
      expect(calls.filter((call) => call.cmd === 'send_channel_message')).toEqual([
        {
          cmd: 'send_channel_message',
          args: { channelId: 'chn_created', body: 'keep this first post' },
        },
        {
          cmd: 'send_channel_message',
          args: { channelId: 'chn_created', body: 'keep this first post' },
        },
      ]);
      expect(document.querySelector('[data-testid="chat-new-channel-modal"]')).toBeNull();
    });

    it('renders a real Sync search result instead of treating its array as an envelope', async () => {
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
