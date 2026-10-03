// @vitest-environment happy-dom

/**
 * hard-stop-readiness US-019, revised for the v0.10.383 banner storm: a plan
 * limit that pauses a company's uploads is announced as a notification row
 * (the panel that lists DMs and shares), one per company per paused episode,
 * and never as a banner in the shell. Rows follow the native
 * `sync:uploads-paused` snapshot, survive a reopened window without
 * re-announcing, and carry the upgrade link only for a host hq-pro returns.
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
        (nativeEvents.handlers.get(event) ?? []).filter((h) => h !== handler),
      );
    };
  }),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn(),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.352'),
  setTheme: vi.fn(async () => {}),
}));

vi.mock('@hq/work/WorkShell', async () => {
  const { default: WorkShellShellReadyHarness } = await import(
    './WorkShellShellReadyHarness.svelte'
  );
  return { default: WorkShellShellReadyHarness };
});

import { flushSync, mount, unmount } from 'svelte';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { sendNotification } from '@tauri-apps/plugin-notification';
import HqWorkWorkShell from './HqWorkWorkShell.svelte';
import type { SyncInvokeFn } from '@hq/platform';

const UPGRADE_URL = 'https://hq.computer/companies/acme/billing?upgrade=1';
const ATTRIBUTED_URL = `${UPGRADE_URL}&entrySurface=desktop_limit`;

const COMPANIES = [
  'boring-cro', 'boring-ecom', 'dealroom-media', 'enabled-ai', 'fermat', 'hollow', 'hpo',
  'klug-media', 'look-optic', 'moonflow', 'movefwd', '8vc', 'absorption-company',
];

let notifyPrefs: Record<string, unknown> | null = null;

function mockInvoke(syncStatus: unknown) {
  const invokeFn: SyncInvokeFn = async (cmd, args) => {
    switch (cmd) {
      case 'hq_pro_fetch': {
        const request = (args ?? {}) as { url?: unknown };
        if (request.url === '/v1/notify/prefs' && notifyPrefs) {
          return { status: 200, body: JSON.stringify({ prefs: notifyPrefs, paused: false }) };
        }
        return { status: 404, body: '{}' };
      }
      case 'get_auth_state':
        return {
          authenticated: true,
          accountId: 'acct_ada',
          email: 'ada@getindigo.ai',
          displayName: 'Ada',
        };
      case 'get_auth_session':
        return { accountId: 'acct_ada', generation: 1, status: 'active', reason: null };
      case 'whoami':
        return { personUid: 'prs_ada', email: 'ada@getindigo.ai', displayName: 'Ada' };
      case 'list_syncable_workspaces':
        return { workspaces: [] };
      case 'get_sync_status':
        return syncStatus;
      default:
        return null;
    }
  };
  return invokeFn;
}

function emit(event: string, payload: unknown): void {
  for (const handler of nativeEvents.handlers.get(event) ?? []) handler({ payload });
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
  vi.mocked(shellOpen).mockClear();
  vi.mocked(sendNotification).mockClear();
  window.localStorage.clear();
  notifyPrefs = null;
});

async function mountShell(syncStatus: unknown = null): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(HqWorkWorkShell, {
    target: host,
    props: { invokeFn: mockInvoke(syncStatus), planLimitBannerDelayMs: 0 },
  });
  await flush();
}

/** Paused-upload rows handed to the notifications feed. */
function rows(): HTMLElement[] {
  return [
    ...host.querySelectorAll<HTMLElement>('[data-testid="harness-host-notification"]'),
  ].filter((row) => row.dataset.type === 'plan_limit');
}

function titles(): string[] {
  return rows().map((row) => row.querySelector('.title')?.textContent ?? '');
}

function expectNoBanner(): void {
  expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
  expect(host.querySelector('.plan-limit-notices')).toBeNull();
  expect(host.querySelector('.plan-limit-notice')).toBeNull();
  expect(host.textContent ?? '').not.toContain('Dismiss');
}

/** Let the 0 ms banner timer fire and its permission/prefs reads settle. */
async function settleBanner(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await flush();
}

describe('HqWorkWorkShell plan-limit upload pause (US-019)', () => {
  it('records the pause from the journal as one notification when the window opens after the sync pass', async () => {
    await mountShell({
      lastSyncAt: '2026-09-28T12:00:00Z',
      conflicts: 0,
      uploadsPaused: [{ company: 'Acme', upgradeUrl: UPGRADE_URL, lastNoticeAtMs: 1 }],
    });

    expectNoBanner();
    expect(titles()).toEqual(['New files are paused for Acme.']);
    expect(rows()[0].dataset.status).toBe('unread');
    host.querySelector<HTMLButtonElement>('[data-testid="harness-host-notification-open"]')?.click();
    await flush();
    expect(shellOpen).toHaveBeenCalledWith(ATTRIBUTED_URL);
  });

  it('renders no banner for 13 paused companies and records 13 notifications from the snapshot', async () => {
    await mountShell({ uploadsPaused: [] });
    const snapshot = {
      companies: COMPANIES.map((company) => ({ company, upgradeUrl: UPGRADE_URL })),
      summary: 'Uploads paused for 13 companies',
    };
    emit('sync:uploads-paused', snapshot);
    await flush();
    await settleBanner();

    expectNoBanner();
    expect(titles().sort()).toEqual(
      COMPANIES.map((company) => `New files are paused for ${company}.`).sort(),
    );
    // One OS banner for the whole pass, not thirteen.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New files are paused for 13 companies.' }),
    );

    // A refresh of the same set does not re-notify.
    emit('sync:uploads-paused', snapshot);
    await flush();
    await settleBanner();
    expect(rows()).toHaveLength(13);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('records 13 notifications from 13 sync:plan-limit events and dedupes repeats per company', async () => {
    await mountShell();
    for (const company of COMPANIES) {
      emit('sync:plan-limit', { company, upgradeUrl: UPGRADE_URL });
    }
    await flush();
    await settleBanner();
    expectNoBanner();
    expect(rows()).toHaveLength(13);
    expect(new Set(rows().map((row) => row.dataset.id)).size).toBe(13);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    for (const company of COMPANIES) {
      emit('sync:plan-limit', { company, upgradeUrl: UPGRADE_URL });
    }
    await flush();
    await settleBanner();
    expect(rows()).toHaveLength(13);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('does not re-notify when the window reopens during the same paused episode', async () => {
    const status = {
      uploadsPaused: COMPANIES.map((company) => ({ company, upgradeUrl: UPGRADE_URL })),
    };
    await mountShell(status);
    await settleBanner();
    expect(rows()).toHaveLength(13);
    const ids = rows().map((row) => row.dataset.id).sort();
    host.querySelector<HTMLButtonElement>('[data-testid="harness-host-notification-ack"]')?.click();
    await flush();
    expect(rows().filter((row) => row.dataset.status === 'read')).toHaveLength(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    await unmount(component!);
    host.remove();
    await mountShell(status);
    await settleBanner();

    expect(rows().map((row) => row.dataset.id).sort()).toEqual(ids);
    expect(rows().filter((row) => row.dataset.status === 'read')).toHaveLength(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('starts a new notification only when a company is paused again after resuming', async () => {
    await mountShell({ uploadsPaused: [{ company: 'Acme', upgradeUrl: UPGRADE_URL }] });
    expect(rows()).toHaveLength(1);

    // Another company joins: Acme keeps its single row.
    emit('sync:uploads-paused', {
      companies: [
        { company: 'Acme', upgradeUrl: UPGRADE_URL },
        { company: 'Beta' },
      ],
    });
    await flush();
    expect(titles()).toEqual([
      'New files are paused for Beta.',
      'New files are paused for Acme.',
    ]);
    // Beta has no approved link, so its row opens nothing.
    expect(rows()[0].dataset.target).toBe('');

    // Uploads resumed: history stays, no new rows.
    emit('sync:uploads-paused', { companies: [] });
    await flush();
    expect(rows()).toHaveLength(2);

    // Paused again: a new episode, a new row.
    emit('sync:uploads-paused', { companies: [{ company: 'Acme', upgradeUrl: UPGRADE_URL }] });
    await flush();
    expect(titles()).toEqual([
      'New files are paused for Acme.',
      'New files are paused for Beta.',
      'New files are paused for Acme.',
    ]);
  });

  it('keeps a runner notice on a host hq-pro never returns without an upgrade link', async () => {
    await mountShell();
    emit('sync:plan-limit', {
      company: 'Acme',
      upgradeUrl: 'https://app.indigo-hq.com/billing/upgrade',
    });
    await flush();
    expect(titles()).toEqual(['New files are paused for Acme.']);
    expect(host.querySelector('[data-testid="harness-host-notification-open"]')).toBeNull();
  });

  it('records the rows but sends no OS banner while notifications are paused', async () => {
    notifyPrefs = { pausedUntil: 'forever', files: true };
    await mountShell({
      uploadsPaused: COMPANIES.map((company) => ({ company, upgradeUrl: UPGRADE_URL })),
    });
    await settleBanner();
    expect(rows()).toHaveLength(13);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('honours the Files notification toggle for the OS banner', async () => {
    notifyPrefs = { pausedUntil: null, files: false };
    await mountShell({ uploadsPaused: [{ company: 'Acme', upgradeUrl: UPGRADE_URL }] });
    await settleBanner();
    expect(rows()).toHaveLength(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('marks every paused-upload row read on read-all', async () => {
    await mountShell({
      uploadsPaused: COMPANIES.slice(0, 3).map((company) => ({ company, upgradeUrl: UPGRADE_URL })),
    });
    host.querySelector<HTMLButtonElement>('[data-testid="harness-host-notifications-read-all"]')?.click();
    await flush();
    expect(rows().map((row) => row.dataset.status)).toEqual(['read', 'read', 'read']);
  });
});
