// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: tauri.open }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: tauri.listen,
  emit: vi.fn(),
}));

import { flushSync, mount, unmount } from 'svelte';
import type { Workspace } from '../../lib/workspaces';
import CompanyPage from './CompanyPage.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

/**
 * US-039 (feedback_8efb8f09): `hq cloud provision company arbium` ran before
 * sign-in, exited 1, and was never retried. Locally the company still reads
 * `cloud: true` with no manifest `cloud_uid`, which `assemble_workspaces`
 * reports as `local-only` — the same shape a never-provisioned company has.
 */
function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'arbium',
    displayName: 'Arbium',
    kind: 'company',
    state: 'local-only',
    cloudUid: null,
    bucketName: null,
    hasLocalFolder: true,
    localPath: '/tmp/HQ/companies/arbium',
    membershipStatus: null,
    role: null,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

function mountPage(company: Workspace, extra: Record<string, unknown> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(CompanyPage, {
    target: host,
    // The Goals section only lists local files; the Overview board would
    // fan out cloud calls that are irrelevant to the connect surface.
    props: { company, tab: 'goals', ...extra },
  });
  flushSync();
}

function defaultInvoke(command: string): Promise<unknown> {
  switch (command) {
    case 'get_settings':
      return Promise.resolve({ hqPath: '/tmp/HQ' });
    default:
      return Promise.resolve([]);
  }
}

describe('CompanyPage unconnected-company notice (US-039)', () => {
  it('tells the user a local-only company is not connected and offers Connect', () => {
    tauri.invoke.mockImplementation(defaultInvoke);
    tauri.listen.mockResolvedValue(() => undefined);

    mountPage(workspace());

    const notice = host.querySelector('[data-testid="company-unconnected-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent?.replace(/\s+/g, ' ')).toContain(
      "Arbium isn't connected to HQ cloud yet.",
    );
    const connect = host.querySelector<HTMLButtonElement>('[data-testid="company-connect"]');
    expect(connect).not.toBeNull();
    expect(connect?.disabled).toBe(false);
    expect(connect?.textContent?.trim()).toBe('Connect to cloud');
  });

  it('carries the broken reason and the retry label for a broken company', () => {
    tauri.invoke.mockImplementation(defaultInvoke);
    tauri.listen.mockResolvedValue(() => undefined);

    mountPage(
      workspace({
        state: 'broken',
        cloudUid: 'cmp_stale',
        brokenReason: 'manifest cloud_uid cmp_stale not found in your cloud memberships',
      }),
    );

    const notice = host.querySelector('[data-testid="company-unconnected-notice"]');
    expect(notice?.textContent?.replace(/\s+/g, ' ')).toContain(
      "Arbium isn't connected to HQ cloud yet.",
    );
    expect(notice?.textContent).toContain('cmp_stale not found');
    expect(host.querySelector('[data-testid="company-connect"]')?.textContent?.trim()).toBe(
      'Retry connect',
    );
  });

  it('shows no notice for a connected company', () => {
    tauri.invoke.mockImplementation(defaultInvoke);
    tauri.listen.mockResolvedValue(() => undefined);

    mountPage(workspace({ state: 'synced', cloudUid: 'cmp_arbium', membershipStatus: 'active' }));

    expect(host.querySelector('[data-testid="company-unconnected-notice"]')).toBeNull();
    expect(host.querySelector('[data-testid="company-connect"]')).toBeNull();
  });

  it('shows a failed Connect inline instead of only in console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onworkspaceschanged = vi.fn();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'connect_workspace_to_cloud') {
        return Promise.reject(
          "hq CLI failed for 'arbium': vault/network error from `hq cloud provision`: exit 1 (vault)",
        );
      }
      return defaultInvoke(command);
    });
    tauri.listen.mockResolvedValue(() => undefined);

    mountPage(workspace(), { onworkspaceschanged });

    host.querySelector<HTMLButtonElement>('[data-testid="company-connect"]')?.click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="company-action-error"]')).not.toBeNull();
    });

    expect(tauri.invoke).toHaveBeenCalledWith('connect_workspace_to_cloud', { slug: 'arbium' });
    const error = host.querySelector('[data-testid="company-action-error"]');
    expect(error?.textContent).toContain('Connect failed:');
    expect(error?.textContent).toContain('exit 1 (vault)');
    expect(onworkspaceschanged).not.toHaveBeenCalled();
    // The notice stays: the company is still unconnected.
    expect(host.querySelector('[data-testid="company-unconnected-notice"]')).not.toBeNull();
    consoleError.mockRestore();
  });

  it('clears the inline error and reports back after a successful Connect', async () => {
    const onworkspaceschanged = vi.fn();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'connect_workspace_to_cloud') return Promise.resolve(undefined);
      return defaultInvoke(command);
    });
    tauri.listen.mockResolvedValue(() => undefined);

    mountPage(workspace(), { onworkspaceschanged });

    host.querySelector<HTMLButtonElement>('[data-testid="company-connect"]')?.click();

    await vi.waitFor(() => {
      flushSync();
      expect(onworkspaceschanged).toHaveBeenCalledTimes(1);
    });
    expect(host.querySelector('[data-testid="company-action-error"]')).toBeNull();
  });
});
