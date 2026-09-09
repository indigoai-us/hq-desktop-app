// @vitest-environment happy-dom

/**
 * Regression (fresh-Mac onboarding): the native host fetched
 * `list_syncable_workspaces` once when identity settled and again only on a
 * manual "Retry workspaces" click. A website-created company that the sync
 * runner provisioned moments later never reached the host roster until a
 * restart. The host must retry a failed fetch on a bounded backoff and
 * re-fetch on `sync:company-provisioned` / `sync:all-complete`.
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

const ACME = {
  slug: 'acme',
  cloudUid: 'cmp_acme',
  displayName: 'Acme',
  kind: 'company',
  state: 'cloud-only',
  role: 'owner',
  membershipStatus: 'active',
};

function mockInvoke(rosterResponses: Array<() => unknown>) {
  const calls: string[] = [];
  const invokeFn: SyncInvokeFn = async (cmd) => {
    calls.push(cmd);
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
      case 'list_syncable_workspaces': {
        const next =
          rosterResponses.length > 1 ? rosterResponses.shift() : rosterResponses[0];
        return next ? next() : { workspaces: [] };
      }
      default:
        return null;
    }
  };
  return { invokeFn, calls };
}

function emit(event: string, payload: unknown): void {
  for (const handler of nativeEvents.handlers.get(event) ?? []) handler({ payload });
}

function rosterCalls(calls: string[]): number {
  return calls.filter((c) => c === 'list_syncable_workspaces').length;
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
});

describe('HqWorkWorkShell workspace roster refresh', () => {
  it('retries a failed roster fetch on a bounded backoff and clears the warning', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke([
      () => {
        throw new Error('vault unreachable');
      },
      () => ({ workspaces: [ACME] }),
    ]);
    component = mount(HqWorkWorkShell, {
      target: host,
      props: { invokeFn, rosterRetryDelaysMs: [5, 5, 5] },
    });
    await flush();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="hq-work-workspace-error"]')).toBeTruthy();
    });
    await vi.waitFor(() => {
      expect(rosterCalls(calls)).toBe(2);
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="hq-work-workspace-error"]')).toBeNull();
    });
  });

  it('re-fetches the roster on sync:company-provisioned and sync:all-complete', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke([
      () => ({ workspaces: [] }),
      () => ({ workspaces: [ACME] }),
    ]);
    component = mount(HqWorkWorkShell, {
      target: host,
      props: { invokeFn, rosterRetryDelaysMs: [5, 5, 5] },
    });
    await flush();
    await vi.waitFor(() => {
      expect(rosterCalls(calls)).toBe(1);
      expect(nativeEvents.handlers.get('sync:company-provisioned')?.length ?? 0).toBeGreaterThan(0);
      expect(nativeEvents.handlers.get('sync:all-complete')?.length ?? 0).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rosterCalls(calls)).toBe(1);

    emit('sync:company-provisioned', {
      companyUid: 'cmp_acme',
      companySlug: 'acme',
      bucketName: 'hq-vault-cmp-acme',
    });
    await vi.waitFor(() => {
      expect(rosterCalls(calls)).toBe(2);
    });

    emit('sync:all-complete', {
      companiesAttempted: 1,
      filesDownloaded: 0,
      bytesDownloaded: 0,
      errors: [],
    });
    await vi.waitFor(() => {
      expect(rosterCalls(calls)).toBe(3);
    });
    expect(host.querySelector('[data-testid="hq-work-workspace-error"]')).toBeNull();
  });

  it('stops listening once unmounted', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke([() => ({ workspaces: [] })]);
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();
    await vi.waitFor(() => {
      expect(rosterCalls(calls)).toBe(1);
    });
    await unmount(component);
    component = null;
    await flush();
    emit('sync:company-provisioned', { companyUid: 'cmp_acme', companySlug: 'acme' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rosterCalls(calls)).toBe(1);
  });
});
