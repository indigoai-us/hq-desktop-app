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

vi.mock('./external-open', () => ({
  approvedExternalUrl: vi.fn((url: string) => url),
  openApprovedExternalUrl: vi.fn(async () => {}),
  openBrowserUrl: vi.fn(async () => {}),
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
import { openApprovedExternalUrl } from './external-open';
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

function mockInvoke(
  rosterResponses: Array<() => unknown>,
  options: {
    limitPromptFlag?: boolean;
    limitStatusPushFlag?: boolean;
    usageBody?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const hqProUrls: string[] = [];
  const telemetryEvents: Record<string, unknown>[] = [];
  const invokeFn: SyncInvokeFn = async (cmd, args) => {
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
      case 'hq_pro_fetch': {
        const request = args ?? {};
        if (typeof request.url === 'string') hqProUrls.push(request.url);
        if (request.url === '/v1/flags/resolve') {
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: {
                'billing.limit-at-action-prompt': options.limitPromptFlag ?? false,
                'desktop.limit-status-push': options.limitStatusPushFlag ?? false,
              },
            }),
          };
        }
        if (typeof request.url === 'string' && request.url.startsWith('/v1/billing/usage-limits?')) {
          return { status: 200, body: JSON.stringify(options.usageBody ?? {}) };
        }
        if (request.url === '/v1/telemetry/events') {
          const body = JSON.parse(String(request.body ?? '{}')) as {
            events?: Record<string, unknown>[];
          };
          telemetryEvents.push(...(body.events ?? []));
          return { status: 202, body: '{}' };
        }
        return { status: 404, body: '{}' };
      }
      default:
        return null;
    }
  };
  return { invokeFn, calls, hqProUrls, telemetryEvents };
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
  it('shows a server-linked plan notice and opens the exact upgrade URL', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, telemetryEvents } = mockInvoke([() => ({ workspaces: [ACME] })]);
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();

    const upgradeUrl = 'https://hq.computer/companies/acme/billing?upgrade=team';
    emit('sync:plan-limit', { company: 'Acme', upgradeUrl });
    await flush();

    const notice = host.querySelector('[data-testid="sync-plan-limit-notice"]');
    expect(notice?.textContent).toContain('New files are paused for Acme.');
    const upgrade = notice?.querySelector<HTMLButtonElement>(
      '[data-testid="sync-plan-limit-upgrade"]',
    );
    expect(upgrade?.textContent).toBe('Upgrade');
    upgrade?.click();
    await flush();
    expect(openApprovedExternalUrl).toHaveBeenCalledWith(
      'https://hq.computer' + '/companies/' + 'acme' + '/billing?upgrade=team&entrySurface=desktop_limit',
    );
    expect(telemetryEvents).toEqual([]);
  });

  it('tracks each visible prompt once and records engagement only for Upgrade clicks', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, telemetryEvents } = mockInvoke([() => ({ workspaces: [ACME] })], {
      limitPromptFlag: true,
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();

    const upgradeUrl = 'https://hq.computer/companies/acme/billing?upgrade=team';
    const limitEvent = { company: 'Acme', upgradeUrl };
    emit('sync:plan-limit', limitEvent);
    await flush();
    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeTruthy();
    expect(telemetryEvents.map((event) => event.eventName)).toEqual([
      'plan_limit_prompt_exposed',
    ]);

    emit('sync:plan-limit', limitEvent);
    await flush();
    expect(telemetryEvents.map((event) => event.eventName)).toEqual([
      'plan_limit_prompt_exposed',
    ]);

    const upgrade = host.querySelector<HTMLButtonElement>(
      '[data-testid="sync-plan-limit-upgrade"]',
    );
    upgrade?.click();
    await flush();
    expect(telemetryEvents.map((event) => event.eventName)).toEqual([
      'plan_limit_prompt_exposed',
      'plan_limit_prompt_engaged',
    ]);
    expect((telemetryEvents[1]?.properties as Record<string, unknown>).action).toBe(
      'upgrade_clicked',
    );
    expect((telemetryEvents[1]?.properties as Record<string, unknown>).exposureId).toBe(
      (telemetryEvents[0]?.properties as Record<string, unknown>).exposureId,
    );
    expect(openApprovedExternalUrl).toHaveBeenCalledWith(
      'https://hq.computer' + '/companies/' + 'acme' + '/billing?upgrade=team&entrySurface=desktop_limit',
    );

    host.querySelector<HTMLButtonElement>('.plan-limit-dismiss')?.click();
    await flush();
    emit('sync:plan-limit', limitEvent);
    await flush();
    const exposures = telemetryEvents.filter(
      (event) => event.eventName === 'plan_limit_prompt_exposed',
    );
    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
    expect(exposures).toHaveLength(1);
    expect(telemetryEvents.filter((event) => event.eventName === 'plan_limit_prompt_engaged'))
      .toHaveLength(1);
  });

  it('does not push a company plan-limit notice when desktop.limit-status-push is off', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, hqProUrls } = mockInvoke([() => ({ workspaces: [ACME] })], {
      usageBody: {
        plan: 'free',
        agents: { used: 11, limit: 10, over: true, pctUsed: 110 },
      },
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();

    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
    expect(hqProUrls).not.toContain('/v1/billing/usage-limits?companyUid=cmp_acme');
  });

  it('pushes free warning status on refresh and keeps a dismissed notice hidden', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, hqProUrls } = mockInvoke([() => ({ workspaces: [ACME] })], {
      limitStatusPushFlag: true,
      usageBody: {
        plan: 'free',
        cohort: 'enforceable',
        planLimitsExempt: false,
        payingBypass: false,
        agents: { used: 8, limit: 10, over: false, pctUsed: 80 },
        upgradeUrl: 'https://hq.computer/companies/acme/billing?upgrade=team',
      },
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();

    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeTruthy();
    expect(hqProUrls.filter((url) => url.startsWith('/v1/billing/usage-limits?'))).toHaveLength(1);

    host.querySelector<HTMLButtonElement>('.plan-limit-dismiss')?.click();
    await flush();
    emit('sync:all-complete', {});
    await flush();

    expect(hqProUrls.filter((url) => url.startsWith('/v1/billing/usage-limits?'))).toHaveLength(2);
    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
  });

  it('does not push a notice for a free company below the warning threshold', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn } = mockInvoke([() => ({ workspaces: [ACME] })], {
      limitStatusPushFlag: true,
      usageBody: {
        plan: 'free',
        cohort: 'enforceable',
        planLimitsExempt: false,
        payingBypass: false,
        agents: { used: 4, limit: 10, over: false, pctUsed: 40 },
      },
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();

    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
  });

  it('does not push a notice for a free company exempt from plan-limit enforcement', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn } = mockInvoke([() => ({ workspaces: [ACME] })], {
      limitStatusPushFlag: true,
      usageBody: {
        plan: 'free',
        cohort: 'enforceable',
        planLimitsExempt: true,
        payingBypass: false,
        agents: { used: 11, limit: 10, over: false, pctUsed: 110 },
      },
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();

    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
  });

  it('waits for both a resolved roster identity and a visible desktop window', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    let resolveRoster!: (value: unknown) => void;
    const roster = new Promise<unknown>((resolve) => {
      resolveRoster = resolve;
    });
    const { invokeFn, telemetryEvents } = mockInvoke([() => roster], {
      limitPromptFlag: true,
    });
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();

    const limitEvent = {
      company: 'Acme',
      upgradeUrl: 'https://hq.computer/companies/acme/billing?upgrade=team',
    };
    emit('sync:plan-limit', limitEvent);
    await flush();
    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeTruthy();
    expect(telemetryEvents).toEqual([]);

    resolveRoster({ workspaces: [ACME] });
    await flush();
    expect(telemetryEvents).toEqual([]);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(telemetryEvents.map((event) => event.eventName)).toEqual([
      'plan_limit_prompt_exposed',
    ]);
    expect(telemetryEvents[0]).toMatchObject({ companyUid: 'cmp_acme' });
  });

  it('clears a company plan notice when the authenticated account changes', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn } = mockInvoke([() => ({ workspaces: [ACME] })]);
    component = mount(HqWorkWorkShell, { target: host, props: { invokeFn } });
    await flush();

    emit('sync:plan-limit', {
      company: 'Acme',
      upgradeUrl: 'https://hq.computer/companies/acme/billing?upgrade=team',
    });
    await flush();
    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeTruthy();

    emit('auth:session-changed', {
      accountId: 'acct_grace',
      generation: 2,
      status: 'active',
      reason: null,
    });
    await flush();

    expect(host.querySelector('[data-testid="sync-plan-limit-notice"]')).toBeNull();
  });

  it('recovers when the native roster succeeds after the UI deadline', async () => {
    vi.useFakeTimers();
    try {
      host = document.createElement('div');
      document.body.appendChild(host);
      let resolveRoster!: (value: unknown) => void;
      const pending = new Promise((resolve) => { resolveRoster = resolve; });
      const { invokeFn } = mockInvoke([() => pending]);
      component = mount(HqWorkWorkShell, {
        target: host,
        props: { invokeFn, rosterRetryDelaysMs: [100_000] },
      });
      await flush();
      await vi.advanceTimersByTimeAsync(15_001);
      await flush();
      const notice = host.querySelector('[data-testid="hq-work-workspace-error"]');
      expect(notice?.textContent).toContain('Workspaces couldn’t refresh.');
      expect(notice?.textContent).not.toContain('timed out');
      expect(notice?.getAttribute('role')).toBe('status');
      resolveRoster({ workspaces: [ACME] });
      await flush();
      expect(host.querySelector('[data-testid="hq-work-workspace-error"]')).toBeNull();
    } finally {
      if (component) await unmount(component);
      component = null;
      vi.useRealTimers();
    }
  });

  it('keeps a newer failed retry authoritative over an older late success', async () => {
    vi.useFakeTimers();
    try {
      host = document.createElement('div');
      document.body.appendChild(host);
      let resolveOld!: (value: unknown) => void;
      const old = new Promise((resolve) => { resolveOld = resolve; });
      const { invokeFn, calls } = mockInvoke([
        () => old,
        () => { throw new Error('still offline'); },
      ]);
      component = mount(HqWorkWorkShell, {
        target: host,
        props: { invokeFn, rosterRetryDelaysMs: [100_000] },
      });
      await flush();
      await vi.advanceTimersByTimeAsync(15_001);
      await flush();
      const retry = host.querySelector<HTMLButtonElement>('[data-testid="hq-work-workspace-error"] button');
      expect(retry).toBeTruthy();
      retry!.click();
      await flush();
      expect(rosterCalls(calls)).toBe(2);
      resolveOld({ workspaces: [ACME] });
      await flush();
      expect(host.querySelector('[data-testid="hq-work-workspace-error"]')).toBeTruthy();
    } finally {
      if (component) await unmount(component);
      component = null;
      vi.useRealTimers();
    }
  });

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

  it('treats a cloud-unreachable roster envelope as a failed fetch and retries it', async () => {
    // `list_syncable_workspaces` resolves (never rejects) with an empty
    // roster + `cloudReachable: false` when the cloud branch fails. On a
    // clean-VM first sign-in that read as "no companies" and stuck there.
    host = document.createElement('div');
    document.body.appendChild(host);
    const { invokeFn, calls } = mockInvoke([
      () => ({ workspaces: [], cloudReachable: false, error: 'vault unreachable' }),
      () => ({ workspaces: [ACME], cloudReachable: true, error: null }),
    ]);
    component = mount(HqWorkWorkShell, {
      target: host,
      props: { invokeFn, rosterRetryDelaysMs: [5, 5, 5] },
    });
    await flush();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="hq-work-workspace-error"]')?.textContent).toContain(
        'Workspaces couldn’t refresh.',
      );
      expect(host.querySelector('[data-testid="hq-work-workspace-error"]')?.textContent).not.toContain('vault unreachable');
    });
    await vi.waitFor(() => {
      expect(rosterCalls(calls)).toBe(2);
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="hq-work-workspace-error"]')).toBeNull();
    });
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
