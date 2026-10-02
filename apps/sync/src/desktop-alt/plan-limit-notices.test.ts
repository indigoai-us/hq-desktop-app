// @vitest-environment happy-dom

/**
 * hard-stop-readiness US-019: the desktop window shows "New files are paused"
 * for every company whose uploads a plan limit refused — even when the window
 * opens after the sync pass — follows the native `sync:uploads-paused`
 * snapshot, and offers the upgrade link only for the host hq-pro returns.
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
import HqWorkWorkShell from './HqWorkWorkShell.svelte';
import type { SyncInvokeFn } from '@hq/platform';

const UPGRADE_URL = 'https://hq.computer/companies/acme/billing?upgrade=1';
const ATTRIBUTED_URL = `${UPGRADE_URL}&entrySurface=desktop_limit`;

function mockInvoke(syncStatus: unknown) {
  const invokeFn: SyncInvokeFn = async (cmd) => {
    switch (cmd) {
      case 'get_auth_state':
        return {
          authenticated: true,
          accountId: 'acct_ada',
          email: 'ada@getindigo.ai',
          displayName: 'Ada',
        };
      case 'get_auth_session':
        return null;
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
  delete (globalThis as Record<string, unknown>).__harnessInitialActiveCompany;
  if (component) await unmount(component);
  component = null;
  host?.remove();
  nativeEvents.handlers.clear();
  vi.mocked(shellOpen).mockClear();
});

type ActivePane = { uid: string | null; slug: string } | null;

/** QA-075: the shell reports which company pane is open (null = personal). */
async function openPane(pane: ActivePane): Promise<void> {
  (globalThis as { __harnessSetActiveCompany?: (p: ActivePane) => void })
    .__harnessSetActiveCompany?.(pane);
  await flush();
}

async function mountShell(
  syncStatus: unknown = null,
  pane: ActivePane = { uid: null, slug: 'acme' },
): Promise<void> {
  (globalThis as Record<string, unknown>).__harnessInitialActiveCompany = pane;
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(HqWorkWorkShell, {
    target: host,
    props: { invokeFn: mockInvoke(syncStatus) },
  });
  await flush();
}

function notices(): string[] {
  return [...document.querySelectorAll('[data-testid="sync-plan-limit-notice"]')].map(
    (el) => el.querySelector('.ts-title')?.textContent ?? '',
  );
}

describe('HqWorkWorkShell plan-limit upload pause (US-019)', () => {
  it('shows the pause from the journal when the window opens after the sync pass', async () => {
    await mountShell({
      lastSyncAt: '2026-09-28T12:00:00Z',
      conflicts: 0,
      uploadsPaused: [{ company: 'Acme', upgradeUrl: UPGRADE_URL, lastNoticeAtMs: 1 }],
    });

    expect(notices()).toEqual(['New files are paused for Acme.']);
    const upgrade = document.querySelector<HTMLButtonElement>(
      '[data-testid="sync-plan-limit-upgrade"]',
    );
    upgrade?.click();
    await flush();
    expect(shellOpen).toHaveBeenCalledWith(ATTRIBUTED_URL);
  });

  it('follows the native snapshot per open pane: adds, keeps link-less rows, and clears', async () => {
    await mountShell({ uploadsPaused: [] });
    expect(notices()).toEqual([]);

    emit('sync:uploads-paused', {
      companies: [
        { company: 'Acme', upgradeUrl: UPGRADE_URL },
        { company: 'Beta' },
      ],
      summary: 'Uploads paused for Acme and Beta',
    });
    await flush();
    expect(notices()).toEqual(['New files are paused for Acme.']);
    expect(document.querySelectorAll('[data-testid="sync-plan-limit-upgrade"]')).toHaveLength(1);

    await openPane({ uid: null, slug: 'beta' });
    expect(notices()).toEqual(['New files are paused for Beta.']);
    expect(document.querySelector('[data-testid="sync-plan-limit-upgrade"]')).toBeNull();

    emit('sync:uploads-paused', { companies: [], summary: null });
    await flush();
    expect(document.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
  });

  it('shows a runner notice on a host hq-pro never returns without an upgrade action', async () => {
    await mountShell();
    emit('sync:plan-limit', {
      company: 'Acme',
      upgradeUrl: 'https://app.indigo-hq.com/billing/upgrade',
    });
    await flush();
    expect(notices()).toEqual(['New files are paused for Acme.']);
    expect(document.querySelector('[data-testid="sync-plan-limit-upgrade"]')).toBeNull();
  });

  it('keeps a dismissal per company for the session', async () => {
    await mountShell({ uploadsPaused: [{ company: 'Acme', upgradeUrl: UPGRADE_URL }] });
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss upgrade notice for Acme"]')
      ?.click();
    await flush();
    expect(notices()).toEqual([]);

    emit('sync:uploads-paused', {
      companies: [
        { company: 'Acme', upgradeUrl: UPGRADE_URL },
        { company: 'Beta', upgradeUrl: UPGRADE_URL },
      ],
    });
    await flush();
    expect(notices()).toEqual([]);
    await openPane({ uid: null, slug: 'beta' });
    expect(notices()).toEqual(['New files are paused for Beta.']);

    // Uploads resumed, then Acme went over again: still dismissed this session.
    emit('sync:uploads-paused', { companies: [] });
    await flush();
    emit('sync:uploads-paused', { companies: [{ company: 'Acme', upgradeUrl: UPGRADE_URL }] });
    await flush();
    await openPane({ uid: null, slug: 'acme' });
    expect(notices()).toEqual([]);
  });
});

describe('HqWorkWorkShell plan-limit notice placement (QA-075)', () => {
  const many = ['Acme', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((company) => ({
    company,
    upgradeUrl: UPGRADE_URL,
  }));

  it('shows a limited company notice only inside that company pane', async () => {
    await mountShell({ uploadsPaused: many }, { uid: null, slug: 'gamma' });
    expect(notices()).toEqual(['New files are paused for Gamma.']);
    const layer = document.querySelector('[data-testid="toast-stack"]');
    expect(layer?.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeTruthy();

    await openPane({ uid: null, slug: 'unlimited-co' });
    expect(notices()).toEqual([]);
  });

  it('shows no plan-limit notice on personal pages', async () => {
    await mountShell({ uploadsPaused: many }, null);
    expect(document.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();

    await openPane({ uid: null, slug: 'acme' });
    expect(notices()).toHaveLength(1);
    await openPane(null);
    expect(document.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
  });

  it('never stacks notices when several companies are limited', async () => {
    await mountShell({ uploadsPaused: many }, { uid: null, slug: 'acme' });
    emit('sync:plan-limit', { company: 'Beta', upgradeUrl: UPGRADE_URL });
    await flush();
    for (const slug of ['acme', 'beta', 'delta', 'epsilon']) {
      await openPane({ uid: null, slug });
      expect(document.querySelectorAll('[data-testid="sync-plan-limit-notice"]')).toHaveLength(1);
      expect(document.querySelectorAll('[data-testid="sync-plan-limit-notice"]')).toHaveLength(1);
    }
  });

  // OWNER-002: the old build stacked every paused company's notice above the
  // shell frame, on the see-through host, so they showed over other apps.
  // OWNER-003: the notice moved from the pane onto the shared toast layer.
  it('renders the notice as one toast on the shared layer', async () => {
    await mountShell({ uploadsPaused: many }, { uid: null, slug: 'delta' });
    const all = [...document.querySelectorAll('[data-testid="sync-plan-limit-notice"]')];
    expect(all).toHaveLength(1);
    for (const el of all) {
      expect(el.closest('[data-testid="toast-stack"]')).toBeTruthy();
      expect(el.closest('.work-shell-frame')).toBeNull();
      expect(el.getAttribute('data-kind')).toBe('sticky');
    }
  });
});
