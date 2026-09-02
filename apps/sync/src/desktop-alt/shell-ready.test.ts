// @vitest-environment happy-dom

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
  getVersion: vi.fn(async () => '0.10.178'),
  setTheme: vi.fn(async () => {}),
}));

import { flushSync, mount, unmount } from 'svelte';
import HqWorkDesktopShell from './HqWorkDesktopShell.svelte';
import type { SyncInvokeFn } from '@hq/platform';

const WHOAMI = {
  personUid: 'prs_ada',
  email: 'ada@getindigo.ai',
  displayName: 'Ada',
};

function mockInvoke(
  overrides: Partial<Record<string, (args?: Record<string, unknown>) => unknown>> = {},
): { invokeFn: SyncInvokeFn; calls: string[] } {
  const calls: string[] = [];
  const invokeFn: SyncInvokeFn = async (cmd, args) => {
    calls.push(cmd);
    const override = overrides[cmd];
    if (override) return override(args);
    switch (cmd) {
      case 'get_auth_state':
        return {
          authenticated: true,
          accountId: 'acct_ada',
          email: WHOAMI.email,
          displayName: WHOAMI.displayName,
        };
      case 'get_auth_session':
        return {
          accountId: 'acct_ada',
          generation: 1,
          status: 'active',
          reason: null,
        };
      case 'whoami':
        return WHOAMI;
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
      case 'fetch_channel_directory':
        return {
          contractVersion: 2,
          snapshot: true,
          cursor: 'testcursor00000000000000000000000000000',
          cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          rows: [
            {
              channelId: 'chn_1',
              name: 'general',
              scope: 'company',
              type: 'chat',
            },
          ],
        };
      case 'list_contacts':
        return { contacts: [] };
      case 'list_dm_requests':
        return { requests: [] };
      case 'desktop_alt_consume_pending_route':
        return null;
      case 'meetings_take_pending_focus':
        return null;
      case 'shell_ready':
        return null;
      default:
        return null;
    }
  };
  return { invokeFn, calls };
}

async function flush(times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  flushSync();
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe('HqWorkDesktopShell shell_ready', () => {
  it('invokes shell_ready after the first successful conversations paint', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke();
    component = mount(HqWorkDesktopShell, {
      target: host,
      props: { invokeFn },
    });
    await flush();
    expect(calls).toContain('shell_ready');
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
  });

  it('does not invoke shell_ready on identity-error', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke({
      whoami: () => {
        throw new Error('vault unavailable');
      },
    });
    component = mount(HqWorkDesktopShell, {
      target: host,
      props: { invokeFn },
    });
    await flush();
    expect(calls).not.toContain('shell_ready');
    expect(host.querySelector('[data-testid="hq-work-identity-error"]')).toBeTruthy();
  });
});
