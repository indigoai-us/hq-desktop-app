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
type ClearListener = (event: { payload: unknown }) => void;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let updateListener: UpdateListener | null = null;
let clearListener: ClearListener | null = null;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function listenerHandle(): () => void {
  // Tauri returns a distinct closure for each listener registration. Keep the
  // shared spy as an invocation counter while preserving that real identity
  // contract for safeUnlisten's duplicate-wrapper guard.
  return vi.fn(() => tauri.unlisten());
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
    expect(button('version-popout-check').disabled).toBe(false);
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  updateListener = null;
  clearListener = null;
  tauri.listen.mockImplementation(
    async (event: string, callback: UpdateListener | ClearListener) => {
      if (event === 'update:available') {
        updateListener = callback as UpdateListener;
      } else if (event === 'update:cleared') {
        clearListener = callback as ClearListener;
      } else {
        throw new Error(`Unexpected event: ${event}`);
      }
      return listenerHandle();
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
  it('separates the desktop app build from HQ Core and exposes Core channel status', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return null;
      if (command === 'get_settings') return { autoUpdate: true };
      if (command === 'get_hq_version') return '15.0.66-beta.1';
      if (command === 'check_core_state') {
        return {
          channel: 'staging',
          targetVersion: '15.0.67-beta.1',
          localVersion: '15.0.66-beta.1',
          versionBehind: true,
          driftReport: { count: 0 },
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForHydration();

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="version-popout-core-current"]')?.textContent,
      ).toContain('v15.0.66-beta.1');
    });
    expect(
      host.querySelector('[data-testid="version-popout-app-current"]')?.textContent,
    ).toContain('v0.10.33');
    expect(
      host.querySelector('[data-testid="version-popout-core-status"]')?.textContent,
    ).toContain('Staging · Update available to v15.0.67-beta.1');
    expect(host.textContent).toContain('Desktop app');
    expect(host.textContent).toContain('HQ Core');
  });

  it('explains when an available Core update is not automatic because the master toggle is off', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return null;
      if (command === 'get_settings') return { autoUpdate: false };
      if (command === 'get_hq_version') return '15.0.4';
      if (command === 'check_core_state') {
        return {
          channel: 'release',
          targetVersion: '15.0.117',
          localVersion: '15.0.4',
          versionBehind: true,
          driftReport: { count: 0 },
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForHydration();

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="version-popout-core-status"]')?.textContent,
      ).toContain('Automatic updates off');
    });
    expect(
      host.querySelector('[data-testid="version-popout-core-status"]')?.textContent,
    ).toContain('v15.0.117');
  });

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
    expect(
      host.querySelector('[data-testid="version-popout-auto-loading"]'),
    ).toBeTruthy();

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

  it('clears stale available UI and ignores an older hydration result', async () => {
    const pending = deferred<UpdateInfo | null>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_update') return pending.promise;
      if (command === 'get_settings') return Promise.resolve({ autoUpdate: true });
      return Promise.reject(new Error(`Unexpected invoke: ${command}`));
    });

    mountPopout();
    await vi.waitFor(() => {
      expect(updateListener).toBeTypeOf('function');
      expect(clearListener).toBeTypeOf('function');
    });

    updateListener?.({ payload: { version: '0.10.35' } });
    flushSync();
    expect(latest()).toBe('v0.10.35');

    clearListener?.({ payload: undefined });
    flushSync();
    expect(status()).toBe('Up to date');
    expect(latest()).toBe('v0.10.33');

    pending.resolve({ version: '0.10.34' });
    await Promise.resolve();
    flushSync();
    expect(latest()).toBe('v0.10.33');
  });

  it('does not resurrect an update after native state clears during a manual check', async () => {
    const check = deferred<UpdateInfo | null>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_update') return Promise.resolve(null);
      if (command === 'get_settings') return Promise.resolve({ autoUpdate: true });
      if (command === 'get_hq_version') return Promise.resolve('15.0.66');
      if (command === 'check_core_state') return Promise.resolve(null);
      if (command === 'check_for_updates') return check.promise;
      return Promise.reject(new Error(`Unexpected invoke: ${command}`));
    });

    mountPopout();
    await waitForHydration();
    await vi.waitFor(() => expect(clearListener).toBeTypeOf('function'));

    button('version-popout-check').click();
    flushSync();
    expect(status()).toBe('Checking…');

    clearListener?.({ payload: undefined });
    flushSync();
    expect(status()).toBe('Up to date');

    check.resolve({ version: '0.10.35' });
    await check.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(status()).toBe('Up to date');
    expect(latest()).toBe('v0.10.33');
    expect(button('version-popout-check').disabled).toBe(false);
  });

  it('does not let a stale empty manual check erase a newer updater event', async () => {
    const check = deferred<UpdateInfo | null>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_update') return Promise.resolve(null);
      if (command === 'get_settings') return Promise.resolve({ autoUpdate: true });
      if (command === 'get_hq_version') return Promise.resolve('15.0.66');
      if (command === 'check_core_state') return Promise.resolve(null);
      if (command === 'check_for_updates') return check.promise;
      return Promise.reject(new Error(`Unexpected invoke: ${command}`));
    });

    mountPopout();
    await waitForHydration();
    await vi.waitFor(() => expect(updateListener).toBeTypeOf('function'));

    button('version-popout-check').click();
    updateListener?.({ payload: { version: '0.10.36' } });
    flushSync();
    expect(status()).toBe('Update available');

    check.resolve(null);
    await check.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(status()).toBe('Update available');
    expect(latest()).toBe('v0.10.36');
  });

  it('does not treat native unchecked state as authoritative absence', async () => {
    const pending = deferred<{ status: 'unchecked' }>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_pending_update') return pending.promise;
      if (command === 'get_settings') return Promise.resolve({ autoUpdate: true });
      return Promise.reject(new Error(`Unexpected invoke: ${command}`));
    });

    mountPopout();
    await vi.waitFor(() => expect(updateListener).toBeTypeOf('function'));
    updateListener?.({ payload: { version: '0.10.35' } });
    pending.resolve({ status: 'unchecked' });
    await vi.waitFor(() => expect(latest()).toBe('v0.10.35'));
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
    expect(button('version-popout-restart').disabled).toBe(true);
    expect(button('version-popout-restart').getAttribute('aria-busy')).toBe('true');
    expect(button('version-popout-restart').textContent).toContain('Downloading');

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

  it('keeps authoritative cleared state when an in-flight install rejects afterward', async () => {
    const install = deferred<void>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    await vi.waitFor(() => expect(clearListener).toBeTypeOf('function'));
    button('version-popout-restart').click();
    flushSync();
    expect(status()).toBe('Downloading…');

    clearListener?.({ payload: undefined });
    flushSync();
    install.reject(new Error('No update available'));
    await install.promise.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(status()).toBe('Up to date');
    expect(latest()).toBe('v0.10.33');
    expect(host.querySelector('[data-testid="version-popout-restart"]')).toBeNull();
    expect(consoleError).not.toHaveBeenCalledWith(
      'install_update failed:',
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('keeps a newer updater event when an older install completes afterward', async () => {
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
    await vi.waitFor(() => expect(updateListener).toBeTypeOf('function'));
    button('version-popout-restart').click();
    flushSync();
    expect(status()).toBe('Downloading…');

    updateListener?.({ payload: { version: '0.10.36' } });
    install.resolve();
    await install.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(status()).toBe('Update available');
    expect(latest()).toBe('v0.10.36');
    expect(button('version-popout-restart').disabled).toBe(false);
  });

  it('ignores an install rejection that settles after the popout unmounts', async () => {
    const install = deferred<void>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

    await unmount(component!);
    component = null;
    install.reject(new Error('window closed'));
    await install.promise.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleError).not.toHaveBeenCalledWith(
      'install_update failed:',
      expect.anything(),
    );
    consoleError.mockRestore();
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
      expect(
        host.querySelector('[data-testid="version-popout-auto-feedback"]')
          ?.textContent,
      ).toContain('Couldn’t save automatic updates');
    });

    button('version-popout-auto-retry').click();
    await vi.waitFor(() =>
      expect(settings.update).toHaveBeenLastCalledWith({ autoUpdate: false }),
    );
    await vi.waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(false);
  });

  it('does not invent an automatic-update default when hydration fails and recovers on Retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tauri.listen.mockRejectedValueOnce(new Error('events unavailable'));
    let settingsAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') throw new Error('updater unavailable');
      if (command === 'get_settings') {
        settingsAttempts += 1;
        if (settingsAttempts === 1) throw new Error('settings unavailable');
        return { autoUpdate: false };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="version-popout-auto-feedback"]')
          ?.textContent,
      ).toContain('Couldn’t load the automatic update preference');
    });

    expect(status()).toBe('Up to date');
    expect(latest()).toBe('v0.10.33');
    expect(
      host.querySelector('[data-testid="version-popout-auto-toggle"]'),
    ).toBeNull();
    expect(button('version-popout-check').disabled).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      'version-popout: failed to listen for updater state',
      expect.any(Error),
    );
    expect(consoleError).toHaveBeenCalledWith(
      'get_pending_update failed:',
      expect.any(Error),
    );
    expect(consoleError).toHaveBeenCalledWith(
      'version-popout: automatic update preference load failed',
      expect.any(Error),
    );

    button('version-popout-auto-retry').click();
    await waitForHydration();
    expect(toggle().checked).toBe(false);
    expect(
      host.querySelector('[data-testid="version-popout-auto-feedback"]'),
    ).toBeNull();
  });

  it('releases a listener that resolves after the popout has already unmounted', async () => {
    const listener = deferred<() => void>();
    tauri.listen.mockReturnValueOnce(listener.promise);
    mountPopout();

    await unmount(component!);
    component = null;
    listener.resolve(listenerHandle());

    await vi.waitFor(() => expect(tauri.unlisten).toHaveBeenCalledTimes(2));
  });

  it.each(['update:available', 'update:cleared'])(
    'releases the %s listener when the sibling registration rejects',
    async (fulfilledEvent) => {
      const retainedUnlisten = vi.fn();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      tauri.listen.mockImplementation(async (event: string) => {
        if (event === fulfilledEvent) return retainedUnlisten;
        throw new Error('event bridge unavailable');
      });

      mountPopout();
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          'version-popout: failed to listen for updater state',
          expect.any(Error),
        );
      });

      await unmount(component!);
      component = null;
      expect(retainedUnlisten).toHaveBeenCalledOnce();
      consoleError.mockRestore();
    },
  );

  it.each(['update:available', 'update:cleared'])(
    'releases the fulfilled %s listener even when its sibling never settles',
    async (fulfilledEvent) => {
      const retainedUnlisten = vi.fn();
      const neverSettles = new Promise<() => void>(() => undefined);
      tauri.listen.mockImplementation((event: string) =>
        event === fulfilledEvent ? Promise.resolve(retainedUnlisten) : neverSettles,
      );

      mountPopout();
      await vi.waitFor(() => expect(tauri.listen).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));

      await unmount(component!);
      component = null;
      expect(retainedUnlisten).toHaveBeenCalledOnce();
    },
  );

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
    expect(tauri.unlisten).toHaveBeenCalledTimes(2);
  });
});
