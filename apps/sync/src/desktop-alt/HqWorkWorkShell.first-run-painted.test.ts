// @vitest-environment happy-dom

/**
 * US-010: the screens that mount no shell (signed out, account error) still
 * tell the first-run handoff the desktop window has painted, so the welcome
 * window is not left waiting for the watchdog. The shell also reports when
 * the window is on screen, so the handoff hides the welcome window after it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeEvents = vi.hoisted(() => ({
  handlers: new Map<string, Array<(event: { payload: unknown }) => void>>(),
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
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const list = nativeEvents.handlers.get(event) ?? [];
    list.push(handler);
    nativeEvents.handlers.set(event, list);
    return () => {
      nativeEvents.handlers.set(
        event,
        (nativeEvents.handlers.get(event) ?? []).filter((current) => current !== handler),
      );
    };
  }),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.178'),
  setTheme: vi.fn(async () => {}),
}));

vi.mock('@hq/work/WorkShell', async () => {
  const { default: WorkShellShellReadyHarness } = await import(
    './WorkShellShellReadyHarness.svelte'
  );
  return { default: WorkShellShellReadyHarness };
});

import { flushSync, mount, unmount } from 'svelte';
import HqWorkWorkShell from './HqWorkWorkShell.svelte';
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
        return null;
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
  nativeEvents.handlers.clear();
  delete (document as { visibilityState?: unknown }).visibilityState;
  document.getElementById('hq-boot')?.remove();
});

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

function painted(calls: string[]): number {
  return calls.filter((cmd) => cmd === 'desktop_first_run_takeover_painted').length;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flush(4);
  }
}

describe('HqWorkWorkShell first-run painted signal', () => {
  it('is sent once when the account-error screen paints', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke({
      whoami: () => {
        throw new Error('boom');
      },
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();
    expect(host.querySelector('[data-testid="hq-work-identity-error"]')).toBeTruthy();
    await waitFor(() => painted(calls) > 0);
    expect(painted(calls)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(painted(calls)).toBe(1);
    warn.mockRestore();
  });

  it('is sent when the signed-out screen paints', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke({
      get_auth_state: () => ({ authenticated: false }),
      get_auth_session: () => ({ status: 'credentials_absent' }),
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();
    await waitFor(() => Boolean(host.querySelector('[data-testid="hq-work-signed-out"]')));
    expect(host.querySelector('[data-testid="hq-work-signed-out"]')).toBeTruthy();
    await waitFor(() => painted(calls) > 0);
    expect(painted(calls)).toBe(1);
  });

  it('removes the boot overlay before the painted report when the window is hidden', async () => {
    setVisibility('hidden');
    const overlay = document.createElement('div');
    overlay.id = 'hq-boot';
    document.body.appendChild(overlay);
    host = document.createElement('div');
    document.body.appendChild(host);
    const overlayAtReport: boolean[] = [];
    const { invokeFn, calls } = mockInvoke({
      get_auth_state: () => ({ authenticated: false }),
      get_auth_session: () => ({ status: 'credentials_absent' }),
      desktop_first_run_takeover_painted: () => {
        overlayAtReport.push(document.getElementById('hq-boot') !== null);
        return false;
      },
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();
    await waitFor(() => painted(calls) > 0);
    expect(overlayAtReport).toEqual([false]);
  });
});

describe('HqWorkWorkShell desktop on-screen report', () => {
  function visibleReports(calls: string[]): number {
    return calls.filter((cmd) => cmd === 'desktop_first_run_desktop_visible').length;
  }

  it('is sent after the page turns visible, not while it is hidden', async () => {
    setVisibility('hidden');
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke();
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flush();
    expect(visibleReports(calls)).toBe(0);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => visibleReports(calls) > 0);
    expect(visibleReports(calls)).toBe(1);
  });

  it('is sent on mount when the page is already visible', async () => {
    setVisibility('visible');
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke();
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();
    await waitFor(() => visibleReports(calls) > 0);
    expect(visibleReports(calls)).toBe(1);
  });
});
