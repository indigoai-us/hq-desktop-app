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
import { EMBEDDED_NAVIGATION_EVENT, OPEN_SETTINGS_EVENT } from '@hq/ui';
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
        return {
          authenticated: true,
          accountId: 'acct_ada',
          expiresAt: '2099-01-01T00:00:00Z',
        };
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
  });
});
