// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('../../src/lib/settings-mutations', () => ({
  updateSettings: settings.update,
}));

import { flushSync, mount, unmount } from 'svelte';
import VersionPopout from '../../src/desktop-alt/components/VersionPopout.svelte';

type UpdateInfo = {
  version: string;
  body?: string;
  date?: string;
};

type UpdateListener = (event: { payload: UpdateInfo }) => void;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let updateListener: UpdateListener | null = null;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mountPopout(
  overrides: Partial<{
    version: string;
    placement: 'above' | 'below';
    onOpenSettings: (tab?: string) => void;
    onclose: () => void;
  }> = {},
): HTMLElement {
  component = mount(VersionPopout, {
    target: host,
    props: {
      version: '0.10.33',
      onOpenSettings: vi.fn(),
      onclose: vi.fn(),
      ...overrides,
    },
  });
  flushSync();
  return host;
}

function button(testId: string): HTMLButtonElement {
  const match = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(match, `button ${testId}`).toBeTruthy();
  return match!;
}

function toggle(): HTMLInputElement {
  const match = host.querySelector<HTMLInputElement>(
    '[data-testid="version-popout-auto-toggle"]',
  );
  expect(match).toBeTruthy();
  return match!;
}

function status(): string {
  return (
    host
      .querySelector('[data-testid="version-popout-status"]')
      ?.textContent?.trim() ?? ''
  );
}

function latest(): string {
  return (
    host
      .querySelector('[data-testid="version-popout-latest"]')
      ?.textContent?.trim() ?? ''
  );
}

async function waitForHydration(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(toggle().disabled).toBe(false);
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  updateListener = null;
  tauri.listen.mockImplementation(
    async (event: string, callback: UpdateListener) => {
      expect(event).toBe('update:available');
      updateListener = callback;
      return tauri.unlisten;
    },
  );
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_pending_update') return null;
    if (command === 'get_settings') return { autoUpdate: true };
    throw new Error(`Unexpected invoke: ${command}`);
  });
  settings.update.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('VersionPopout restored updater behavior', () => {
  it('hydrates the pending updater result and the saved automatic-update preference', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return { version: '0.10.34' };
      if (command === 'get_settings') return { autoUpdate: false };
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout({ placement: 'below' });

    expect(host.querySelector('[data-testid="version-popout"]')?.classList).toContain(
      'below',
    );
    expect(
      host.querySelector('[data-testid="version-popout-current"]')?.textContent,
    ).toBe('v0.10.33');
    expect(toggle().disabled).toBe(true);

    await waitForHydration();

    expect(latest()).toBe('v0.10.34');
    expect(status()).toBe('Update available');
    expect(toggle().checked).toBe(false);
    expect(button('version-popout-restart').textContent?.trim()).toBe(
      'Restart to update',
    );
  });

  it('registers the update event before slow hydration and keeps a newer event visible', async () => {
    const pending = deferred<UpdateInfo | null>();
    const prefs = deferred<{ autoUpdate: boolean }>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_update') return pending.promise;
      if (command === 'get_settings') return prefs.promise;
      return Promise.reject(new Error(`Unexpected invoke: ${command}`));
    });

    mountPopout();
    await vi.waitFor(() => expect(updateListener).toBeTypeOf('function'));

    updateListener?.({ payload: { version: '0.10.35' } });
    flushSync();
    expect(latest()).toBe('v0.10.35');
    expect(status()).toBe('Update available');

    pending.resolve(null);
    prefs.resolve({ autoUpdate: true });
    await waitForHydration();
    expect(latest()).toBe('v0.10.35');
  });

  it('checks for updates and switches between current and available states', async () => {
    let checkResult: UpdateInfo | null = null;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return null;
      if (command === 'get_settings') return { autoUpdate: true };
      if (command === 'check_for_updates') return checkResult;
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForHydration();

    button('version-popout-check').click();
    flushSync();
    expect(status()).toBe('Checking…');
    expect(button('version-popout-check').disabled).toBe(true);
    await vi.waitFor(() => expect(status()).toBe('Up to date'));
    expect(latest()).toBe('v0.10.33');
    expect(
      host.querySelector('[data-testid="version-popout-restart"]'),
    ).toBeNull();

    checkResult = { version: '0.10.36' };
    button('version-popout-check').click();
    await vi.waitFor(() => expect(status()).toBe('Update available'));
    expect(latest()).toBe('v0.10.36');
    expect(button('version-popout-restart')).toBeTruthy();
    expect(tauri.invoke).toHaveBeenCalledWith('check_for_updates');
  });

  it('surfaces a failed check and recovers when an update event arrives', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return null;
      if (command === 'get_settings') return { autoUpdate: true };
      if (command === 'check_for_updates') throw new Error('offline');
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForHydration();
    button('version-popout-check').click();
    await vi.waitFor(() => expect(status()).toBe('Check failed'));

    updateListener?.({ payload: { version: '0.10.37' } });
    flushSync();
    expect(status()).toBe('Update available');
    expect(latest()).toBe('v0.10.37');
  });

  it('shows download progress, then asks for restart when installation returns', async () => {
    const install = deferred<void>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_update') {
        return Promise.resolve({ version: '0.10.34' });
      }
      if (command === 'get_settings') return Promise.resolve({ autoUpdate: true });
      if (command === 'install_update') return install.promise;
      return Promise.reject(new Error(`Unexpected invoke: ${command}`));
    });

    mountPopout();
    await waitForHydration();
    await vi.waitFor(() => expect(status()).toBe('Update available'));

    button('version-popout-restart').click();
    flushSync();
    expect(status()).toBe('Downloading…');
    expect(button('version-popout-check').disabled).toBe(true);
    expect(
      host.querySelector('[data-testid="version-popout-restart"]'),
    ).toBeNull();

    install.resolve();
    await vi.waitFor(() => expect(status()).toBe('Restart to apply'));
    expect(button('version-popout-restart').disabled).toBe(false);
    expect(tauri.invoke).toHaveBeenCalledWith('install_update');
  });

  it('surfaces installation failure without losing the available version', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return { version: '0.10.34' };
      if (command === 'get_settings') return { autoUpdate: true };
      if (command === 'install_update') throw new Error('signature rejected');
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForHydration();
    await vi.waitFor(() => expect(status()).toBe('Update available'));
    button('version-popout-restart').click();

    await vi.waitFor(() => expect(status()).toBe('Install failed'));
    expect(latest()).toBe('v0.10.34');
    expect(button('version-popout-restart').disabled).toBe(false);
  });

  it('persists automatic updates optimistically and rolls back a failed save', async () => {
    const save = deferred<void>();
    settings.update.mockReturnValueOnce(save.promise);
    mountPopout();
    await waitForHydration();

    toggle().click();
    flushSync();
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    expect(settings.update).toHaveBeenCalledWith({ autoUpdate: false });

    save.reject(new Error('read-only settings'));
    await vi.waitFor(() => {
      flushSync();
      expect(toggle().checked).toBe(true);
      expect(toggle().disabled).toBe(false);
    });

    toggle().click();
    await vi.waitFor(() =>
      expect(settings.update).toHaveBeenLastCalledWith({ autoUpdate: false }),
    );
    await vi.waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(false);
  });

  it('remains usable with safe defaults when updater hydration is unavailable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tauri.listen.mockRejectedValueOnce(new Error('events unavailable'));
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') throw new Error('updater unavailable');
      if (command === 'get_settings') throw new Error('settings unavailable');
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForHydration();

    expect(status()).toBe('Up to date');
    expect(latest()).toBe('v0.10.33');
    expect(toggle().checked).toBe(true);
    expect(button('version-popout-check').disabled).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      'version-popout: failed to listen for update:available',
      expect.any(Error),
    );
    expect(consoleError).toHaveBeenCalledWith(
      'get_pending_update failed:',
      expect.any(Error),
    );
  });

  it('releases a listener that resolves after the popout has already unmounted', async () => {
    const listener = deferred<() => void>();
    tauri.listen.mockReturnValueOnce(listener.promise);
    mountPopout();

    await unmount(component!);
    component = null;
    listener.resolve(tauri.unlisten);

    await vi.waitFor(() => expect(tauri.unlisten).toHaveBeenCalledOnce());
  });

  it('opens the Updates settings tab, closes the popout, and releases its listener', async () => {
    const onOpenSettings = vi.fn();
    const onclose = vi.fn();
    mountPopout({ onOpenSettings, onclose });
    await waitForHydration();

    button('version-popout-settings-link').click();
    expect(onOpenSettings).toHaveBeenCalledWith('updates');
    expect(onclose).toHaveBeenCalledOnce();

    await unmount(component!);
    component = null;
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });
});
