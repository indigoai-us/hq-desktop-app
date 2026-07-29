// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@sentry/svelte', () => ({
  captureException: sentry.captureException,
}));

import { flushSync, mount, unmount } from 'svelte';
import SyncModeToggle from '../../src/components/SyncModeToggle.svelte';

type SyncMode = 'all' | 'shared' | 'custom';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function config(syncMode: SyncMode) {
  return {
    membershipId: 'mem_1',
    syncMode,
    isDefault: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mountToggle(): void {
  component = mount(SyncModeToggle, {
    target: host,
    props: {
      slug: 'indigo',
      cloudReachable: true,
    },
  });
  flushSync();
}

function button(testId: string): HTMLButtonElement {
  const match = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(match, `button ${testId}`).toBeTruthy();
  return match!;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_sync_mode') return config('all');
    throw new Error(`Unexpected invoke: ${command}`);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.restoreAllMocks();
});

describe('SyncModeToggle async feedback', () => {
  it('announces the initial read and exposes the confirmed value only after it resolves', async () => {
    const load = deferred<ReturnType<typeof config>>();
    tauri.invoke.mockReturnValueOnce(load.promise);

    mountToggle();

    expect(
      host.querySelector('[data-testid="sync-mode-control"]')?.getAttribute(
        'aria-busy',
      ),
    ).toBe('true');
    expect(host.textContent).toContain('Loading');
    expect(host.querySelector('[data-testid="sync-mode-all"]')).toBeNull();

    load.resolve(config('all'));
    await vi.waitFor(() => {
      flushSync();
      expect(button('sync-mode-all').getAttribute('aria-pressed')).toBe('true');
    });
    expect(
      host.querySelector('[data-testid="sync-mode-control"]')?.getAttribute(
        'aria-busy',
      ),
    ).toBe('false');
  });

  it('renders a localized load failure and recovers through Retry', async () => {
    tauri.invoke
      .mockRejectedValueOnce(new Error('vault offline'))
      .mockResolvedValueOnce(config('shared'));

    mountToggle();

    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="sync-mode-error"]')?.textContent,
      ).toContain('Couldn’t load sync mode');
    });
    expect(host.querySelector('[data-testid="sync-mode-all"]')).toBeNull();

    button('sync-mode-retry').click();
    flushSync();
    expect(host.textContent).toContain('Loading');

    await vi.waitFor(() => {
      flushSync();
      expect(button('sync-mode-shared').getAttribute('aria-pressed')).toBe(
        'true',
      );
    });
    expect(host.querySelector('[data-testid="sync-mode-error"]')).toBeNull();
  });

  it('keeps the trusted value, gates duplicate writes, and retries the failed target', async () => {
    const firstSave = deferred<ReturnType<typeof config>>();
    let saveAttempts = 0;
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_sync_mode') return Promise.resolve(config('all'));
      if (command === 'set_sync_mode') {
        saveAttempts += 1;
        return saveAttempts === 1
          ? firstSave.promise
          : Promise.resolve(config('shared'));
      }
      return Promise.reject(new Error(`Unexpected invoke: ${command}`));
    });

    mountToggle();
    await vi.waitFor(() => {
      flushSync();
      expect(button('sync-mode-all').getAttribute('aria-pressed')).toBe('true');
    });

    button('sync-mode-shared').click();
    flushSync();

    expect(button('sync-mode-shared').disabled).toBe(true);
    expect(button('sync-mode-all').disabled).toBe(true);
    expect(button('sync-mode-shared').getAttribute('aria-busy')).toBe('true');
    expect(button('sync-mode-shared').textContent).toContain('Saving');
    // Pending UI never replaces the last value confirmed by the backend.
    expect(button('sync-mode-all').getAttribute('aria-pressed')).toBe('true');

    button('sync-mode-shared').click();
    expect(saveAttempts).toBe(1);

    firstSave.reject(new Error('write denied'));
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="sync-mode-error"]')?.textContent,
      ).toContain('Couldn’t save sync mode');
    });
    expect(button('sync-mode-all').getAttribute('aria-pressed')).toBe('true');

    button('sync-mode-retry').click();
    await vi.waitFor(() => {
      flushSync();
      expect(button('sync-mode-shared').getAttribute('aria-pressed')).toBe(
        'true',
      );
    });
    expect(saveAttempts).toBe(2);
    expect(host.querySelector('[data-testid="sync-mode-error"]')).toBeNull();
    expect(sentry.captureException).toHaveBeenCalledOnce();
  });
});

describe('settings control motion contracts', () => {
  it('keeps pending UI understandable without toggle or spinner motion', () => {
    const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
    const syncMode = readFileSync(
      root('src/components/SyncModeToggle.svelte'),
      'utf8',
    );
    const versionPopout = readFileSync(
      root('src/desktop-alt/components/VersionPopout.svelte'),
      'utf8',
    );

    for (const source of [syncMode, versionPopout]) {
      expect(source).toContain('@media (prefers-reduced-motion: reduce)');
      expect(source).toContain('animation: none');
    }
    expect(versionPopout).toMatch(
      /\.vp-toggle-row input\[type='checkbox'\]::after\s*\{\s*transition: none;/,
    );
  });
});
