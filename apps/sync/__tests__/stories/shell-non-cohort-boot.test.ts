// @vitest-environment happy-dom
/**
 * Production bug (v0.10.178): a signed-in user who is NOT in the former
 * Indigo cohort (e.g. Michel Triana) got the new desktop workspace with
 * only #setup in the rail and an infinite grey conversation skeleton.
 *
 * The directory / contacts / dm-threads reads 404 or hang for that tenant,
 * auto-open skipped the synthetic #setup row, and selectedRow stayed null.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('tests inject invokeFn');
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
import HqWorkDesktopShell from '../../src/desktop-alt/HqWorkDesktopShell.svelte';
import { resolveLaunchShell } from '../../src/lib/desktop-shell';
import { hqWorkHandoffEnabled } from '../../src/lib/hq-work';
import type { SyncInvokeFn } from '@hq/platform';

const MICHEL = {
  personUid: 'prs_michel',
  email: 'michel@other-company.com',
  displayName: 'Michel Triana',
};

const PERSONAL_ONLY = {
  workspaces: [
    {
      slug: 'personal',
      displayName: 'Michel Triana',
      kind: 'personal',
      state: 'personal',
      cloudUid: 'prs_michel',
      membershipStatus: null,
      role: null,
    },
  ],
};

const MULTI_COMPANY = {
  workspaces: [
    {
      slug: 'personal',
      displayName: 'Michel Triana',
      kind: 'personal',
      state: 'personal',
      cloudUid: 'prs_michel',
      membershipStatus: null,
      role: null,
    },
    {
      slug: 'acme',
      displayName: 'Acme',
      kind: 'company',
      state: 'synced',
      cloudUid: 'cmp_acme',
      membershipStatus: 'active',
      role: 'member',
    },
    {
      slug: 'widgets',
      displayName: 'Widgets Co',
      kind: 'company',
      state: 'synced',
      cloudUid: 'cmp_widgets',
      membershipStatus: 'active',
      role: 'admin',
    },
  ],
};

interface Options {
  whoami?: unknown | (() => unknown);
  workspaces?: unknown;
  listChannels?: unknown | (() => unknown);
  listContacts?: unknown | (() => unknown);
  getSettings?: unknown;
  hqPro?: Record<string, { status: number; body: string }>;
}

function invokeFor(options: Options = {}): SyncInvokeFn {
  return async (command, args) => {
    switch (command) {
      case 'get_auth_session':
        return null;
      case 'get_auth_state':
        return {
          authenticated: true,
          accountId: 'acct_michel',
          email: MICHEL.email,
          displayName: MICHEL.displayName,
        };
      case 'whoami':
        if (typeof options.whoami === 'function') return options.whoami();
        if (options.whoami) return options.whoami;
        return MICHEL;
      case 'desktop_alt_is_admin':
      case 'meetings_feature_enabled':
        return false;
      case 'is_indigo_user':
        return false;
      case 'list_syncable_workspaces':
        return options.workspaces ?? PERSONAL_ONLY;
      case 'list_channels':
        if (typeof options.listChannels === 'function') return options.listChannels();
        if (options.listChannels !== undefined) return options.listChannels;
        return { channels: [] };
      case 'list_contacts':
        if (typeof options.listContacts === 'function') return options.listContacts();
        if (options.listContacts !== undefined) return options.listContacts;
        return { contacts: [] };
      case 'list_dm_requests':
        return { requests: [] };
      case 'fetch_notifications':
        return { notifications: [], unreadCount: 0, nextCursor: null };
      case 'get_settings':
        return options.getSettings ?? { hqWorkHandoff: false };
      case 'get_config':
        return {};
      case 'desktop_alt_consume_pending_route':
      case 'meetings_take_pending_focus':
        return null;
      case 'hq_pro_fetch': {
        const path = String(args?.url ?? '');
        if (options.hqPro) {
          for (const [prefix, payload] of Object.entries(options.hqPro)) {
            if (path.startsWith(prefix)) return payload;
          }
        }
        if (path.startsWith('/v1/notify/dm-threads')) {
          return { status: 404, body: JSON.stringify({ error: 'Not found' }) };
        }
        if (path.startsWith('/v1/notify/inbox')) {
          return { status: 404, body: JSON.stringify({ error: 'Not found' }) };
        }
        if (path.startsWith('/v1/identity/whoami')) {
          return { status: 404, body: JSON.stringify({ error: 'Not found' }) };
        }
        return { status: 200, body: JSON.stringify({}) };
      }
      default:
        return null;
    }
  };
}

async function flush(times = 48): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  flushSync();
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

async function mountShell(options: Options = {}, bootTimeoutMs = 40): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(HqWorkDesktopShell, {
    target: host,
    props: { invokeFn: invokeFor(options), bootTimeoutMs },
  });
  await flush();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  try {
    window.localStorage?.clear?.();
  } catch {
    /* Node 22 may not expose localStorage in this worker */
  }
});

describe('desktop workspace boot for non-cohort identities', () => {
  it('a personal-only membership opens #setup instead of an infinite skeleton', async () => {
    await mountShell({ workspaces: PERSONAL_ONLY });
    expect(host.querySelector('[data-testid="hq-work-identity-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeTruthy();
    });
    expect(host.querySelector('[data-testid="channel-skeleton"]')).toBeNull();
  });

  it('a multi-company membership with an empty directory opens #setup, not a skeleton', async () => {
    await mountShell({ workspaces: MULTI_COMPANY });
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeTruthy();
    });
    expect(host.querySelector('[data-testid="channel-skeleton"]')).toBeNull();
  });

  it('native whoami "no person entity" still hydrates the shell from the session', async () => {
    await mountShell({
      whoami: () => {
        throw new Error('person entity lookup failed: no person entity for this account');
      },
    });
    expect(host.querySelector('[data-testid="hq-work-identity-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeTruthy();
    });
  });

  it('a 404 on list_channels / contacts / dm-threads still renders #setup within the timeout', async () => {
    await mountShell({
      listChannels: () => {
        throw new Error('Request failed (status 404)');
      },
      listContacts: () => {
        throw new Error('Request failed (status 404)');
      },
      hqPro: {
        '/v1/notify/dm-threads': {
          status: 404,
          body: JSON.stringify({ error: 'Not found' }),
        },
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeTruthy();
    });
    expect(host.querySelector('[data-testid="channel-skeleton"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-load-error"]')?.textContent).toMatch(
      /Couldn’t load conversations/,
    );
  });

  it('a hung directory fetch still opens #setup within the boot timeout', async () => {
    await mountShell(
      {
        listChannels: () => new Promise(() => {}),
        listContacts: () => new Promise(() => {}),
      },
      40,
    );
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeTruthy();
    });
    expect(host.querySelector('[data-testid="channel-skeleton"]')).toBeNull();
  });

  it('an upgraded install carrying hqWorkHandoff:false still loads the desktop workspace', async () => {
    expect(
      resolveLaunchShell({
        email: MICHEL.email,
        companyUid: 'cmp_acme',
        hqWorkHandoff: false,
      }),
    ).toBe('desktop-alt');
    expect(hqWorkHandoffEnabled(false)).toBe(true);
    await mountShell({ getSettings: { hqWorkHandoff: false, stagingChannel: true } });
    expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeTruthy();
    });
  });
});
