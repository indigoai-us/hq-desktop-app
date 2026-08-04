// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@sentry/svelte', () => ({ captureException: mocks.captureException }));

import { flushSync, mount, unmount } from 'svelte';
import WorkspaceList from './WorkspaceList.svelte';

let component: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.clearAllMocks();
});

const workspace = {
  slug: 'acme',
  displayName: 'Acme',
  kind: 'company' as const,
  state: 'local-only' as const,
  cloudUid: null,
  bucketName: null,
  hasLocalFolder: true,
  localPath: '/Users/Ada/HQ/companies/acme',
  membershipStatus: null,
  role: null,
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

async function renderRejectedConnect(message: string, expectsRepairAffordance = true) {
  mocks.invoke.mockRejectedValueOnce(new Error(message));
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(WorkspaceList, {
    target: host,
    props: {
      workspaces: [workspace],
      cloudReachable: true,
      hqFolderPath: '/Users/Ada/HQ',
    },
  });
  flushSync();
  host.querySelector<HTMLButtonElement>('[aria-label="Connect Acme to cloud"]')?.click();
  await vi.waitFor(() => {
    flushSync();
    expect(host?.textContent).toContain(
      expectsRepairAffordance ? 'Fix in Claude Code' : 'Connect failed — click to retry',
    );
  });
}

describe('WorkspaceList Connect error reporting', () => {
  it.each([
    ['node-missing', 'Install Node.js'],
    ['npx-unavailable', 'Restore npx'],
  ])('does not report a proven %s setup failure and renders its repair affordance', async (kind, label) => {
    await renderRejectedConnect(`local environment failure (${kind}): ${label}`);
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(host?.textContent).toContain(label);
    expect(host?.textContent).not.toContain('Connect failed — click to retry');
  });

  it('continues reporting an unclassified Connect rejection once', async () => {
    await renderRejectedConnect('runtime launcher unavailable; see log', false);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it.each([
    'npm-cache-permission',
    'disk-full',
    'npm-registry-unreachable',
    'npm-registry-timeout',
  ])('continues reporting the pre-existing %s local environment kind once', async (kind) => {
    await renderRejectedConnect(`local environment failure (${kind}): existing repair detail`);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it.each([
    'local environment failure (future-kind): unrecognized backend kind',
    'raw IPC serialization failure',
  ])('continues reporting an unknown rejection once: %s', async (message) => {
    await renderRejectedConnect(message, false);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });
});
