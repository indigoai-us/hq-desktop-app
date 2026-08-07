// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent, EventHint } from '@sentry/svelte';

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
import { beforeSend } from '../sentry-before-send';
import WorkspaceList from './WorkspaceList.svelte';

let component: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
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

async function renderRejectedConnect(
  message: string,
  expectsRepairAffordance = true,
  state: 'local-only' | 'broken' = 'local-only',
) {
  mocks.invoke.mockRejectedValueOnce(new Error(message));
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(WorkspaceList, {
    target: host,
    props: {
      workspaces: [
        {
          ...workspace,
          state,
          brokenReason: state === 'broken' ? 'Manifest points at a retired cloud vault' : null,
        },
      ],
      cloudReachable: true,
      hqFolderPath: '/Users/Ada/HQ',
    },
  });
  flushSync();
  const action = state === 'broken' ? 'Reconnect' : 'Connect';
  host.querySelector<HTMLButtonElement>(`[aria-label="${action} Acme to cloud"]`)?.click();
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
    const privatePath = '/Users/Ada/Library/Application Support/Indigo HQ/toolchain/node/bin/node';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderRejectedConnect(`local environment failure (${kind}): ${privatePath}`);
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(host?.textContent).toContain(label);
    expect(host?.textContent).not.toContain('Connect failed — click to retry');
    expect(host?.innerHTML).not.toContain(privatePath);

    // Model the browser SDK's default console integration, then pass the
    // resulting breadcrumbs through the production scrubber. The expected
    // setup path must have no route into a later, unrelated Sentry event.
    const event: ErrorEvent = {
      type: undefined,
      breadcrumbs: consoleError.mock.calls.map((args) => ({
        category: 'console',
        message: args.map(String).join(' '),
        data: { arguments: args.map(String) },
      })),
    };
    const scrubbed = beforeSend(event, {} as EventHint);
    expect(JSON.stringify(scrubbed)).not.toContain(privatePath);
  });

  it.each([
    ['node-missing', 'Install Node.js'],
    ['npx-unavailable', 'Restore npx'],
  ])(
    'renders the actionable %s repair on a broken workspace while keeping it unreported',
    async (kind, label) => {
      await renderRejectedConnect(
        `local environment failure (${kind}): expected first-run setup gap`,
        true,
        'broken',
      );

      expect(mocks.captureException).not.toHaveBeenCalled();
      expect(host?.textContent).toContain(label);
      expect(host?.textContent).toContain('Fix in Claude Code');
      expect(host?.textContent).not.toContain('Reconnect failed — click to retry');
      expect(host?.textContent).not.toContain('Copy repair prompt');
    },
  );

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
