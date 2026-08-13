// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(),
  getVersion: vi.fn(async () => '0.10.33'),
  open: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: tauri.emit, listen: tauri.listen }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: tauri.getVersion }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: tauri.open }));

import { flushSync, mount, unmount } from 'svelte';
import SettingsPage from '../../src/desktop-alt/pages/SettingsPage.svelte';

type Membership = {
  companyUid: string;
  companyName: string;
  role: string;
  status: string;
};

type InvokeOptions = {
  settings?: Record<string, unknown>;
  getSettings?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  memberships?: Membership[] | (() => Membership[]);
  pendingUpdate?:
    | { version: string; body?: string; date?: string }
    | { status: 'unchecked' | 'absent' }
    | {
        status: 'pending';
        update: { version: string; body?: string; date?: string };
      }
    | null;
  settingsDeferred?: Promise<Record<string, unknown>>;
  save?: (prefs: Record<string, unknown>) => Promise<void>;
  cliUpdate?: { local: string | null; latest: string } | null;
  checkCli?: () => Promise<{ local: string | null; latest: string } | null>;
  dismissCli?: (version: string) => Promise<void>;
  cliVersion?: string | null;
  installCli?: () => Promise<{ local: string | null; latest: string }>;
  installApp?: () => Promise<void>;
  checkApp?: () => Promise<{ version: string } | null>;
  coreVersion?: string | null | Promise<string | null>;
  coreState?: unknown | Promise<unknown>;
  installCore?: () => Promise<{
    exit_code: number;
    log_tail: string;
    log_path: string;
  }>;
  notificationPermission?: 'granted' | 'denied' | 'prompt';
  requestNotificationPermission?: () => Promise<'granted' | 'denied' | 'prompt'>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const defaultSettings = {
  hqPath: '/Users/test/HQ',
  syncOnLaunch: true,
  notifications: true,
  startAtLogin: true,
  realtimeSync: true,
  personalSyncEnabled: true,
  instantSync: true,
  shareNotifications: true,
  dmNotifications: true,
  cliAutoUpdate: true,
  autoUpdate: true,
  stagingChannel: false,
  releaseChannel: null,
  meetingDetectNotify: {
    enabled: true,
    platforms: ['zoom', 'meet', 'teams', 'slack', 'webex'],
  },
  defaultRecordingCompanyUid: null,
  telemetryEnabled: true,
  widgetEnabled: true,
  widgetDisplay: null,
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let updateListener: ((event: { payload: { version: string } }) => void) | null = null;
let updateClearedListener: ((event: { payload: unknown }) => void) | null = null;

function stubInvoke(options: InvokeOptions = {}): void {
  let settings = { ...defaultSettings, ...(options.settings ?? {}) };
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'get_settings':
        return options.getSettings?.() ?? options.settingsDeferred ?? { ...settings };
      case 'meetings_feature_enabled':
      case 'is_indigo_user':
        return true;
      case 'available_channels':
        return ['stable', 'beta', 'alpha'];
      case 'meetings_list_memberships':
        return typeof options.memberships === 'function'
          ? options.memberships()
          : (options.memberships ?? []);
      case 'notification_permission_state':
        return options.notificationPermission ?? 'granted';
      case 'notification_request_permission':
        return options.requestNotificationPermission?.() ?? 'granted';
      case 'meetings_permissions_state':
        return {
          accessibility: 'granted',
          screenCapture: 'granted',
          microphone: 'granted',
          systemAudio: 'granted',
          fullDiskAccess: 'unknown',
          allRequiredGranted: true,
        };
      case 'check_pack_update':
        return null;
      case 'check_core_state':
        return options.coreState ?? null;
      case 'check_hq_cli_update':
        return options.checkCli?.() ?? options.cliUpdate ?? null;
      case 'get_hq_cli_version':
        return options.cliVersion === undefined ? '0.19.4' : options.cliVersion;
      case 'install_hq_cli_update':
        return options.installCli?.();
      case 'set_hq_cli_update_dismissed':
        return options.dismissCli?.(String(args?.version ?? ''));
      case 'install_update':
        return options.installApp?.();
      case 'check_for_updates':
        return options.checkApp?.() ?? null;
      case 'get_hq_version':
        return options.coreVersion ?? '15.0.16';
      case 'install_hq_core_update':
      case 'run_replace_from_staging':
        return options.installCore?.();
      case 'get_pending_update':
        return options.pendingUpdate ?? null;
      case 'list_displays':
        return [{ name: 'Built-in Display', primary: true }];
      case 'save_settings':
        {
          const prefs = (args?.prefs ?? {}) as Record<string, unknown>;
          await options.save?.(prefs);
          settings = { ...settings, ...prefs };
        }
        return undefined;
      case 'apply_widget_settings':
      case 'start_daemon':
      case 'stop_daemon':
      case 'set_autostart_enabled':
        return undefined;
      default:
        return null;
    }
  });
}

async function mountSettings(): Promise<void> {
  component = mount(SettingsPage, {
    target: host,
    props: { activeTab: 'sync' },
  });
  flushSync();
}

async function waitForSettingsReady(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('.settings-page[aria-busy="false"]')).toBeTruthy();
  });
}

function checkbox(labelStartsWith: string): HTMLInputElement {
  const match = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
    (input) => input.closest('label')?.textContent?.trim().startsWith(labelStartsWith),
  );
  expect(match, `checkbox ${labelStartsWith}`).toBeTruthy();
  return match!;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  updateListener = null;
  updateClearedListener = null;
  tauri.listen.mockImplementation(async (event: string, callback: unknown) => {
    if (event === 'update:available') {
      updateListener = callback as typeof updateListener;
    }
    if (event === 'update:cleared') {
      updateClearedListener = callback as typeof updateClearedListener;
    }
    return vi.fn();
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('Settings deep regressions', () => {
  it.each(['update:available', 'update:cleared'])(
    'releases the %s settings listener when the sibling registration rejects',
    async (fulfilledEvent) => {
      const retainedUnlisten = vi.fn();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      tauri.listen.mockImplementation(async (event: string) => {
        if (event === fulfilledEvent) return retainedUnlisten;
        throw new Error('event bridge unavailable');
      });
      stubInvoke();

      await mountSettings();
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          'settings: failed to listen for updater state',
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
    'releases the %s settings listener while the sibling registration never settles',
    async (fulfilledEvent) => {
      const retainedUnlisten = vi.fn();
      const never = new Promise<() => void>(() => undefined);
      tauri.listen.mockImplementation(async (event: string) => {
        if (event === fulfilledEvent) return retainedUnlisten;
        return never;
      });
      stubInvoke();

      await mountSettings();
      await Promise.resolve();
      await unmount(component!);
      component = null;

      expect(retainedUnlisten).toHaveBeenCalledOnce();
    },
  );

  it('always shows the HQ CLI identity and status independently from update availability', async () => {
    stubInvoke({ cliVersion: '0.19.4', cliUpdate: null });

    await mountSettings();
    await waitForSettingsReady();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-cli-version"]')?.textContent).toContain(
        'v0.19.4',
      );
      expect(host.querySelector('[data-testid="settings-cli-status"]')?.textContent).toContain(
        'Up to date',
      );
    });
    expect(host.querySelector('[data-testid="settings-check-cli-updates"]')).toBeTruthy();
  });

  it('shows the canonical HQ Core version without waiting for the slower state scan', async () => {
    const coreState = deferred<null>();
    stubInvoke({
      coreVersion: '15.0.66-beta.1',
      coreState: coreState.promise,
    });

    await mountSettings();
    await waitForSettingsReady();

    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="settings-core-version"]')?.textContent,
      ).toContain('v15.0.66-beta.1');
    });
    expect(
      host.querySelector('[data-testid="settings-core-status"]')?.textContent,
    ).toContain('Checking channel status');
    expect(host.textContent).not.toContain('version unknown');

    coreState.resolve(null);
  });

  it('immediately disables and labels the app update check while it is pending', async () => {
    const check = deferred<{ version: string } | null>();
    stubInvoke({ checkApp: () => check.promise });
    await mountSettings();
    await waitForSettingsReady();

    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="settings-check-app-updates"]',
    );
    expect(button).toBeTruthy();
    button!.click();
    flushSync();

    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute('aria-busy')).toBe('true');
    expect(button!.textContent?.trim()).toBe('Checking…');

    check.resolve(null);
    await vi.waitFor(() => {
      flushSync();
      expect(button!.disabled).toBe(false);
      expect(host.querySelector('[data-testid="settings-app-status"]')?.textContent).toContain(
        'Up to date',
      );
    });
  });

  it('hydrates a pending app update and reacts to later background update events', async () => {
    stubInvoke({
      pendingUpdate: {
        status: 'pending',
        update: { version: '0.10.34' },
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    await vi.waitFor(() => {
      expect(host.textContent).toContain('v0.10.34 ready');
      expect(host.querySelector('[data-testid="settings-install-app-update"]')).toBeTruthy();
    });

    expect(updateListener).toBeTypeOf('function');
    updateListener?.({ payload: { version: '0.10.35' } });
    flushSync();
    expect(host.textContent).toContain('v0.10.35 ready');

    expect(updateClearedListener).toBeTypeOf('function');
    updateClearedListener?.({ payload: undefined });
    flushSync();
    expect(host.textContent).not.toContain('v0.10.35 ready');
    expect(host.querySelector('[data-testid="settings-install-app-update"]')).toBeNull();
  });

  it('clears a stale app-install failure when native update state clears', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubInvoke({
      pendingUpdate: {
        status: 'pending',
        update: { version: '0.10.34' },
      },
      installApp: async () => {
        throw new Error('signature rejected');
      },
    });
    await mountSettings();
    await waitForSettingsReady();
    const install = await vi.waitFor(() => {
      const match = host.querySelector<HTMLButtonElement>(
        '[data-testid="settings-install-app-update"]',
      );
      expect(match).toBeTruthy();
      return match!;
    });

    install.click();
    await vi.waitFor(() => expect(host.textContent).toContain('Install failed'));
    updateClearedListener?.({ payload: undefined });
    flushSync();

    expect(host.textContent).not.toContain('Install failed');
    consoleError.mockRestore();
  });

  it('ignores an app-install rejection after native state has already cleared', async () => {
    const install = deferred<void>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubInvoke({
      pendingUpdate: {
        status: 'pending',
        update: { version: '0.10.34' },
      },
      installApp: () => install.promise,
    });
    await mountSettings();
    await waitForSettingsReady();
    const installButton = await vi.waitFor(() => {
      const match = host.querySelector<HTMLButtonElement>(
        '[data-testid="settings-install-app-update"]',
      );
      expect(match).toBeTruthy();
      return match!;
    });

    installButton.click();
    flushSync();
    updateClearedListener?.({ payload: undefined });
    flushSync();
    install.reject(new Error('No update available'));
    await install.promise.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(host.textContent).not.toContain('Install failed');
    expect(host.querySelector('[data-testid="settings-install-app-update"]')).toBeNull();
    consoleError.mockRestore();
  });

  it('keeps a newer app update authoritative over an older install completion', async () => {
    const install = deferred<void>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubInvoke({
      pendingUpdate: {
        status: 'pending',
        update: { version: '0.10.34' },
      },
      installApp: () => install.promise,
    });
    await mountSettings();
    await waitForSettingsReady();
    const installButton = await vi.waitFor(() => {
      const match = host.querySelector<HTMLButtonElement>(
        '[data-testid="settings-install-app-update"]',
      );
      expect(match).toBeTruthy();
      return match!;
    });

    installButton.click();
    updateListener?.({ payload: { version: '0.10.35' } });
    flushSync();
    install.reject(new Error('superseded install'));
    await install.promise.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(host.textContent).toContain('v0.10.35 ready');
    expect(host.textContent).not.toContain('Install failed');
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="settings-install-app-update"]')
        ?.disabled,
    ).toBe(false);
    consoleError.mockRestore();
  });

  it('does not resurrect a cleared update when an older manual check settles', async () => {
    const check = deferred<{ version: string } | null>();
    stubInvoke({ checkApp: () => check.promise });
    await mountSettings();
    await waitForSettingsReady();
    await vi.waitFor(() => expect(updateClearedListener).toBeTypeOf('function'));

    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="settings-check-app-updates"]',
    );
    button?.click();
    flushSync();
    expect(button?.disabled).toBe(true);

    updateClearedListener?.({ payload: undefined });
    flushSync();
    expect(button?.disabled).toBe(false);

    check.resolve({ version: '0.10.35' });
    await check.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(host.textContent).not.toContain('v0.10.35 ready');
    expect(
      host.querySelector('[data-testid="settings-install-app-update"]'),
    ).toBeNull();
  });

  it('revalidates the default recording company when memberships change on focus', async () => {
    let memberships: Membership[] = [
      {
        companyUid: 'cmp_indigo',
        companyName: 'Indigo',
        role: 'owner',
        status: 'active',
      },
    ];
    stubInvoke({
      settings: { defaultRecordingCompanyUid: 'cmp_indigo' },
      memberships: () => memberships,
    });
    await mountSettings();
    await waitForSettingsReady();

    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Default recording company"]',
    );
    expect(select?.value).toBe('cmp_indigo');

    memberships = [];
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(select?.value).toBe(''));
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual(['']);
  });

  it('keeps backend Settings disabled during hydration while local Appearance stays usable', async () => {
    let resolveSettings!: (value: Record<string, unknown>) => void;
    const settingsDeferred = new Promise<Record<string, unknown>>((resolve) => {
      resolveSettings = resolve;
    });
    stubInvoke({ settingsDeferred });
    await mountSettings();

    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy();
    const controls = Array.from(host.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >('button, input, select'));
    const disabledGroups = Array.from(
      host.querySelectorAll<HTMLFieldSetElement>('fieldset.settings-controls[disabled]'),
    );
    const appearance = host.querySelector<HTMLElement>(
      '[data-testid="settings-appearance"]',
    );
    const localControls = Array.from(
      appearance?.querySelectorAll<HTMLInputElement>('input') ?? [],
    );
    const backendControls = controls.filter(
      (control) =>
        !appearance?.contains(control) &&
        // US-020 single-pane navigation (Back / section index) is local UI —
        // it must stay usable during hydration, like Appearance.
        control.dataset.testid !== 'settings-back' &&
        control.dataset.testid !== 'settings-index-row',
    );
    expect(controls.length).toBeGreaterThan(0);
    expect(disabledGroups).toHaveLength(2);
    expect(disabledGroups.every((group) => group.disabled)).toBe(true);
    expect(
      backendControls.every((control) =>
        disabledGroups.some((group) => group.contains(control)),
      ),
    ).toBe(true);
    expect(localControls.length).toBeGreaterThan(0);
    expect(localControls.every((control) => !control.disabled)).toBe(true);

    resolveSettings(defaultSettings);
    await waitForSettingsReady();
    expect(checkbox('Sync on launch').disabled).toBe(false);
  });

  it('offers retry after initial settings hydration fails and unlocks only after retry succeeds', async () => {
    let settingsAvailable = false;
    stubInvoke({
      getSettings: async () => {
        if (!settingsAvailable) throw new Error('settings temporarily unavailable');
        return { ...defaultSettings };
      },
    });
    await mountSettings();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-retry-load"]')).toBeTruthy();
      expect(host.querySelector<HTMLFieldSetElement>('fieldset[disabled]')?.disabled).toBe(true);
    });

    settingsAvailable = true;
    host
      .querySelector<HTMLButtonElement>('[data-testid="settings-retry-load"]')
      ?.click();

    await waitForSettingsReady();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(checkbox('Sync on launch').disabled).toBe(false);
  });

  it('lets a successful focus refresh recover a transient initial settings failure', async () => {
    let settingsAvailable = false;
    stubInvoke({
      getSettings: async () => {
        if (!settingsAvailable) throw new Error('settings temporarily unavailable');
        return { ...defaultSettings };
      },
    });
    await mountSettings();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-retry-load"]')).toBeTruthy();
    });

    settingsAvailable = true;
    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector<HTMLFieldSetElement>('fieldset[disabled]')).toBeNull();
    });
    expect(checkbox('Sync on launch').disabled).toBe(false);
  });

  it('ignores an older mount failure after a newer focus hydration succeeds', async () => {
    const oldHydration = deferred<Record<string, unknown>>();
    let getSettingsCalls = 0;
    stubInvoke({
      getSettings: () => {
        getSettingsCalls += 1;
        // SettingsPage and its WidgetSettings child both hydrate on mount.
        if (getSettingsCalls <= 2) return oldHydration.promise;
        return { ...defaultSettings, notifications: false };
      },
    });
    await mountSettings();
    await vi.waitFor(() => expect(getSettingsCalls).toBeGreaterThanOrEqual(2));

    window.dispatchEvent(new Event('focus'));
    await waitForSettingsReady();
    expect(checkbox('Sync notifications').checked).toBe(false);

    oldHydration.reject(new Error('late mount failure'));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(checkbox('Sync notifications').checked).toBe(false);
    });
  });

  it('never lets a pre-save focus snapshot overwrite a newer optimistic save', async () => {
    let persisted = { ...defaultSettings };
    let deferNextSettingsRead = false;
    let deferredReadStarted = false;
    const staleFocusRead = deferred<Record<string, unknown>>();
    stubInvoke({
      getSettings: () => {
        if (deferNextSettingsRead) {
          deferNextSettingsRead = false;
          deferredReadStarted = true;
          return staleFocusRead.promise;
        }
        return { ...persisted };
      },
      save: async (prefs) => {
        persisted = { ...persisted, ...prefs };
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    deferNextSettingsRead = true;
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(deferredReadStarted).toBe(true));

    const notificationsToggle = checkbox('Sync notifications');
    notificationsToggle.checked = false;
    notificationsToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(persisted.notifications).toBe(false));
    expect(notificationsToggle.checked).toBe(false);

    // This snapshot began before the save and resolves last. The generation
    // guard must ignore it after the post-save hydration has applied.
    staleFocusRead.resolve({ ...defaultSettings, notifications: true });
    await vi.waitFor(() => {
      flushSync();
      expect(checkbox('Sync notifications').checked).toBe(false);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it('serializes rapid preference writes so an older snapshot cannot finish last', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const savedSnapshots: Record<string, unknown>[] = [];
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });

    stubInvoke({
      save: async (prefs) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        savedSnapshots.push({ ...prefs });
        if (savedSnapshots.length === 1) await firstSaveGate;
        inFlight -= 1;
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    const syncOnLaunch = checkbox('Sync on launch');
    const syncNotifications = checkbox('Sync notifications');
    syncOnLaunch.checked = false;
    syncOnLaunch.dispatchEvent(new Event('change', { bubbles: true }));
    syncNotifications.checked = false;
    syncNotifications.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(savedSnapshots).toHaveLength(1));
    releaseFirstSave();
    await vi.waitFor(() => expect(savedSnapshots).toHaveLength(2));

    expect(maxInFlight).toBe(1);
    expect(savedSnapshots[1]).toMatchObject({
      syncOnLaunch: false,
      notifications: false,
    });
  });

  it('serializes Settings and Widget writes through one latest-preference queue', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const savedSnapshots: Record<string, unknown>[] = [];
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });

    stubInvoke({
      save: async (prefs) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        savedSnapshots.push({ ...prefs });
        if (savedSnapshots.length === 1) await firstSaveGate;
        inFlight -= 1;
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    const syncOnLaunch = checkbox('Sync on launch');
    const widgetToggle = host.querySelector<HTMLButtonElement>('[data-testid="widget-toggle"]');
    expect(widgetToggle).toBeTruthy();

    syncOnLaunch.checked = false;
    syncOnLaunch.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(savedSnapshots).toHaveLength(1));

    widgetToggle?.click();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    expect(savedSnapshots).toHaveLength(1);
    expect(maxInFlight).toBe(1);
    releaseFirstSave();

    await vi.waitFor(() => expect(savedSnapshots).toHaveLength(2));
    expect(savedSnapshots[1]).toMatchObject({
      syncOnLaunch: false,
      widgetEnabled: false,
    });
    expect(maxInFlight).toBe(1);
  });

  it('reconciles an older failed optimistic patch after a newer queued patch succeeds', async () => {
    let saveCount = 0;
    stubInvoke({
      save: async () => {
        saveCount += 1;
        if (saveCount === 1) throw new Error('first write failed');
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    const syncOnLaunch = checkbox('Sync on launch');
    const syncNotifications = checkbox('Sync notifications');
    syncOnLaunch.checked = false;
    syncOnLaunch.dispatchEvent(new Event('change', { bubbles: true }));
    syncNotifications.checked = false;
    syncNotifications.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(saveCount).toBe(2));
    await vi.waitFor(() => {
      flushSync();
      expect(checkbox('Sync on launch').checked).toBe(true);
      expect(checkbox('Sync notifications').checked).toBe(false);
    });
  });

  it('reverts live toggles and rolls back their side effects when persistence fails', async () => {
    stubInvoke({
      save: async () => {
        throw new Error('disk is read-only');
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    const realtime = checkbox('Auto-sync');
    tauri.invoke.mockClear();
    realtime.checked = false;
    realtime.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(checkbox('Auto-sync').checked).toBe(true));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('disk is read-only');
    expect(tauri.invoke).toHaveBeenCalledWith('stop_daemon');
    expect(tauri.invoke).toHaveBeenCalledWith('start_daemon');

    const instant = checkbox('Instant sync');
    tauri.invoke.mockClear();
    instant.checked = false;
    instant.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(checkbox('Instant sync').checked).toBe(true));
    expect(tauri.invoke).not.toHaveBeenCalledWith('stop_daemon');
    expect(tauri.invoke).not.toHaveBeenCalledWith('start_daemon');

    const startAtLogin = checkbox('Start at login');
    tauri.invoke.mockClear();
    startAtLogin.checked = false;
    startAtLogin.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(checkbox('Start at login').checked).toBe(true));
    expect(tauri.invoke).toHaveBeenCalledWith('set_autostart_enabled', {
      enabled: false,
    });
    expect(tauri.invoke).toHaveBeenCalledWith('set_autostart_enabled', {
      enabled: true,
    });
  });

  it('does not persist Auto-sync until the daemon changes and leaves a visible retry path', async () => {
    stubInvoke();
    await mountSettings();
    await waitForSettingsReady();

    const originalInvoke = tauri.invoke.getMockImplementation()!;
    let stopAttempts = 0;
    tauri.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'stop_daemon') {
          stopAttempts += 1;
          if (stopAttempts === 1) throw new Error('daemon unavailable');
        }
        return originalInvoke(command, args);
      },
    );
    tauri.invoke.mockClear();

    const realtime = checkbox('Auto-sync');
    realtime.checked = false;
    realtime.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      flushSync();
      expect(realtime.checked).toBe(true);
      expect(
        host.querySelector('[data-testid="settings-realtime-sync-error"]')?.textContent,
      ).toContain('Toggle again to retry');
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'save_settings',
      expect.anything(),
    );
    expect(realtime.disabled).toBe(false);

    const retryRealtime = checkbox('Auto-sync');
    retryRealtime.checked = false;
    retryRealtime.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(tauri.invoke).toHaveBeenCalledWith(
        'save_settings',
        expect.objectContaining({
          prefs: expect.objectContaining({ realtimeSync: false }),
        }),
      );
      expect(checkbox('Auto-sync').checked).toBe(false);
      expect(
        host.querySelector('[data-testid="settings-realtime-sync-error"]'),
      ).toBeNull();
    });
  });

  it('reverts Instant sync and its persisted value when daemon activation fails', async () => {
    stubInvoke();
    await mountSettings();
    await waitForSettingsReady();

    const originalInvoke = tauri.invoke.getMockImplementation()!;
    let startAttempts = 0;
    tauri.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'start_daemon') {
          startAttempts += 1;
          if (startAttempts === 1) throw new Error('daemon restart failed');
        }
        return originalInvoke(command, args);
      },
    );
    tauri.invoke.mockClear();

    const instant = checkbox('Instant sync');
    instant.checked = false;
    instant.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      flushSync();
      expect(instant.checked).toBe(true);
      expect(
        host.querySelector('[data-testid="settings-instant-sync-error"]')?.textContent,
      ).toContain('Toggle again to retry');
    });
    const savedSnapshots = tauri.invoke.mock.calls
      .filter(([command]) => command === 'save_settings')
      .map(([, args]) => (args as { prefs: Record<string, unknown> }).prefs.instantSync);
    expect(savedSnapshots).toEqual([false, true]);
    expect(instant.disabled).toBe(false);
  });

  it('does not persist Start at login until native autostart succeeds', async () => {
    stubInvoke();
    await mountSettings();
    await waitForSettingsReady();

    const originalInvoke = tauri.invoke.getMockImplementation()!;
    let attempts = 0;
    tauri.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'set_autostart_enabled') {
          attempts += 1;
          if (attempts === 1) throw new Error('launch agent unavailable');
        }
        return originalInvoke(command, args);
      },
    );
    tauri.invoke.mockClear();

    const startAtLogin = checkbox('Start at login');
    startAtLogin.checked = false;
    startAtLogin.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      flushSync();
      expect(startAtLogin.checked).toBe(true);
      expect(
        host.querySelector('[data-testid="settings-start-at-login-error"]')?.textContent,
      ).toContain('Toggle again to retry');
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'save_settings',
      expect.anything(),
    );
    expect(startAtLogin.disabled).toBe(false);
  });

  it('shows notification permission failure and retries from the same control', async () => {
    let attempts = 0;
    stubInvoke({
      notificationPermission: 'prompt',
      requestNotificationPermission: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('permission bridge unavailable');
        return 'granted';
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    const permissionButton = await vi.waitFor(() => {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Enable',
      );
      expect(button).toBeTruthy();
      return button!;
    });
    permissionButton.click();

    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="settings-notification-permission-error"]')
          ?.textContent,
      ).toContain('Try again');
      expect(permissionButton.textContent?.trim()).toBe('Try again');
    });
    permissionButton.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('System notifications are enabled for HQ');
      expect(
        host.querySelector('[data-testid="settings-notification-permission-error"]'),
      ).toBeNull();
    });
  });

  it('keeps failed CLI copy, drift open, sign-out, and quit actions retryable', async () => {
    const driftReport = {
      baselineStatus: 'Available',
      updateRequired: false,
      count: 1,
      modified: [],
      missing: [],
      added: [],
      scannedAt: '2026-07-29T00:00:00Z',
      hqVersion: '15.0.16',
      targetRepo: 'indigo/hq-core',
      targetRef: 'main',
    };
    stubInvoke({
      cliVersion: null,
      coreState: {
        channel: 'release',
        targetRepo: 'indigo/hq-core',
        targetVersion: '15.0.16',
        targetRef: 'main',
        localVersion: '15.0.16',
        floorSha: null,
        isEligible: true,
        versionBehind: false,
        driftReport,
        unchangedCount: 0,
        userOnlyCount: 1,
        scannedAt: '2026-07-29T00:00:00Z',
      },
    });
    const clipboardWrite = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('clipboard blocked'))
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    await mountSettings();
    await waitForSettingsReady();

    const originalInvoke = tauri.invoke.getMockImplementation()!;
    const attempts = new Map<string, number>();
    tauri.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (['open_drift_detail', 'quit_app'].includes(command)) {
          const next = (attempts.get(command) ?? 0) + 1;
          attempts.set(command, next);
          if (next === 1) throw new Error(`${command} unavailable`);
        }
        return originalInvoke(command, args);
      },
    );
    tauri.emit
      .mockRejectedValueOnce(new Error('sign-out bridge unavailable'))
      .mockResolvedValue(undefined);

    const copy = await vi.waitFor(() => {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Copy install command',
      );
      expect(button).toBeTruthy();
      return button!;
    });
    copy.click();
    await vi.waitFor(() => {
      flushSync();
      expect(copy.textContent?.trim()).toBe('Copy failed — retry');
      expect(host.querySelector('[data-testid="settings-cli-copy-error"]')).toBeTruthy();
    });
    copy.click();
    await vi.waitFor(() => expect(copy.textContent?.trim()).toBe('Command copied'));

    const drift = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === '1 drifted',
    );
    expect(drift).toBeTruthy();
    drift?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(drift?.textContent?.trim()).toBe('Retry details');
      expect(host.querySelector('[data-testid="settings-drift-error"]')).toBeTruthy();
    });
    drift?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-drift-error"]')).toBeNull();
    });

    const signOut = host.querySelector<HTMLButtonElement>(
      '[data-testid="settings-sign-out"]',
    );
    expect(signOut).toBeTruthy();
    signOut?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(signOut?.textContent?.trim()).toBe('Retry sign out');
      expect(host.querySelector('[data-testid="settings-account-error"]')).toBeTruthy();
    });
    signOut?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-account-error"]')).toBeNull();
      expect(
        host.querySelector<HTMLButtonElement>('[data-testid="settings-sign-out"]')
          ?.disabled,
      ).toBe(false);
    });

    const quit = host.querySelector<HTMLButtonElement>('[data-testid="settings-quit"]');
    expect(quit).toBeTruthy();
    quit?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(
        host
          .querySelector<HTMLButtonElement>('[data-testid="settings-quit"]')
          ?.textContent?.trim(),
      ).toBe('Retry quit');
      expect(host.querySelector('[data-testid="settings-account-error"]')).toBeTruthy();
      expect(
        host.querySelector<HTMLButtonElement>('[data-testid="settings-quit"]')?.disabled,
      ).toBe(false);
    });
    host.querySelector<HTMLButtonElement>('[data-testid="settings-quit"]')?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-account-error"]')).toBeNull();
    });
  });

  it('keeps a CLI install failure visible instead of rehydrating it away', async () => {
    stubInvoke({
      cliUpdate: { local: '0.19.4', latest: '0.20.0' },
      installCli: async () => {
        throw new Error('registry unavailable');
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    const cliRow = await vi.waitFor(() => {
      const row = host.querySelector<HTMLElement>('[data-testid="settings-cli-row"]');
      expect(row?.textContent).toContain('HQ CLI');
      expect(row?.textContent).toContain('Update available to v0.20.0');
      return row!;
    });
    const update = Array.from(cliRow.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Update to v0.20.0',
    );
    update?.click();

    await vi.waitFor(() => expect(cliRow.textContent).toContain('Update failed.'));
  });

  it('prevents dismissing a CLI update while its install is in flight', async () => {
    const install = deferred<{ local: string | null; latest: string }>();
    stubInvoke({
      cliUpdate: { local: '0.19.4', latest: '0.20.0' },
      installCli: () => install.promise,
    });
    await mountSettings();
    await waitForSettingsReady();

    const cliRow = await vi.waitFor(() => {
      const row = host.querySelector<HTMLElement>('[data-testid="settings-cli-row"]');
      expect(row?.textContent).toContain('Update to v0.20.0');
      return row!;
    });
    Array.from(cliRow.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Update to v0.20.0')
      ?.click();
    flushSync();

    const dismiss = Array.from(cliRow.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Dismiss',
    );
    expect(dismiss).toBeTruthy();
    expect(dismiss?.disabled).toBe(true);
    dismiss?.click();
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'set_hq_cli_update_dismissed',
      expect.anything(),
    );

    install.resolve({ local: '0.20.0', latest: '0.20.0' });
  });

  it('keeps a dismissed CLI update hidden when an older check settles', async () => {
    const staleCheck = deferred<{ local: string | null; latest: string } | null>();
    let checks = 0;
    stubInvoke({
      checkCli: async () => {
        checks += 1;
        if (checks === 1) return { local: '0.19.4', latest: '0.20.0' };
        return staleCheck.promise;
      },
      dismissCli: async () => undefined,
    });
    await mountSettings();
    await waitForSettingsReady();

    const cliRow = await vi.waitFor(() => {
      const row = host.querySelector<HTMLElement>('[data-testid="settings-cli-row"]');
      expect(row?.textContent).toContain('Update to v0.20.0');
      return row!;
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="settings-check-cli-updates"]')
      ?.click();
    flushSync();
    const dismiss = Array.from(cliRow.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Dismiss',
    );
    expect(dismiss).toBeTruthy();
    dismiss?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(cliRow.textContent).not.toContain('Update to v0.20.0');
    });

    staleCheck.resolve({ local: '0.19.4', latest: '0.20.0' });
    await staleCheck.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(cliRow.textContent).not.toContain('Update to v0.20.0');
  });

  it('restores a CLI update with inline retry feedback when dismiss persistence fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubInvoke({
      cliUpdate: { local: '0.19.4', latest: '0.20.0' },
      dismissCli: async () => {
        throw new Error('preferences unavailable');
      },
    });
    await mountSettings();
    await waitForSettingsReady();

    const cliRow = await vi.waitFor(() => {
      const row = host.querySelector<HTMLElement>('[data-testid="settings-cli-row"]');
      expect(row?.textContent).toContain('Update to v0.20.0');
      return row!;
    });
    Array.from(cliRow.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Dismiss')
      ?.click();

    await vi.waitFor(() => {
      flushSync();
      expect(cliRow.textContent).toContain('Update to v0.20.0');
      expect(
        host.querySelector('[data-testid="settings-cli-status"]')?.textContent,
      ).toContain('Couldn’t dismiss update. Try again.');
      expect(cliRow.textContent).toContain('Retry dismiss');
    });
    consoleError.mockRestore();
  });

  it('blocks a stale Core install while channel state is refreshing', async () => {
    const initialState = {
      channel: 'release',
      targetRepo: 'indigo/hq-core',
      targetVersion: '15.0.17',
      targetRef: 'v15.0.17',
      localVersion: '15.0.16',
      floorSha: null,
      isEligible: true,
      versionBehind: true,
      driftReport: {
        baselineStatus: 'Available',
        updateRequired: true,
        count: 0,
        modified: [],
        missing: [],
        added: [],
        scannedAt: '2026-07-27T00:00:00Z',
        hqVersion: '15.0.16',
        targetRepo: 'indigo/hq-core',
        targetRef: 'v15.0.17',
      },
      unchangedCount: 0,
      userOnlyCount: 0,
      scannedAt: '2026-07-27T00:00:00Z',
    };
    const stagingState = {
      ...initialState,
      channel: 'staging',
      targetVersion: '15.0.18-beta.1',
      targetRef: 'staging',
    };
    const refresh = deferred<typeof stagingState>();
    let stateChecks = 0;
    stubInvoke({
      coreState: null,
      installCore: async () => ({
        exit_code: 0,
        log_tail: '',
        log_path: '',
      }),
    });
    const originalInvoke = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'check_core_state') {
        stateChecks += 1;
        if (stateChecks === 1) return initialState;
        if (stateChecks === 2) return refresh.promise;
        return stagingState;
      }
      return originalInvoke(command, args);
    });
    await mountSettings();
    await waitForSettingsReady();

    const update = await vi.waitFor(() => {
      const match = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Update to v15.0.17',
      );
      expect(match).toBeTruthy();
      return match!;
    });
    host.querySelector<HTMLButtonElement>('[data-testid="settings-refresh-core"]')?.click();
    flushSync();
    expect(update.disabled).toBe(true);
    update.click();
    expect(tauri.invoke).not.toHaveBeenCalledWith('install_hq_core_update');

    refresh.resolve(stagingState);
    const stagingUpdate = await vi.waitFor(() => {
      flushSync();
      const match = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Update to Staging',
      );
      expect(match).toBeTruthy();
      return match!;
    });
    stagingUpdate.click();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('run_replace_from_staging');
    });
  });

  it('locks Core channel controls while an install is in flight', async () => {
    const install = deferred<{
      exit_code: number;
      log_tail: string;
      log_path: string;
    }>();
    stubInvoke({
      coreState: {
        channel: 'release',
        targetRepo: 'indigo/hq-core',
        targetVersion: '15.0.17',
        targetRef: 'v15.0.17',
        localVersion: '15.0.16',
        floorSha: null,
        isEligible: true,
        versionBehind: true,
        driftReport: {
          baselineStatus: 'Available',
          updateRequired: true,
          count: 0,
          modified: [],
          missing: [],
          added: [],
          scannedAt: '2026-07-27T00:00:00Z',
          hqVersion: '15.0.16',
          targetRepo: 'indigo/hq-core',
          targetRef: 'v15.0.17',
        },
        unchangedCount: 0,
        userOnlyCount: 0,
        scannedAt: '2026-07-27T00:00:00Z',
      },
      installCore: () => install.promise,
    });
    await mountSettings();
    await waitForSettingsReady();

    const update = await vi.waitFor(() => {
      const match = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Update to v15.0.17',
      );
      expect(match).toBeTruthy();
      return match!;
    });
    update.click();
    flushSync();

    expect(checkbox('HQ Core staging channel').disabled).toBe(true);
    const releaseChannel = Array.from(
      host.querySelectorAll<HTMLSelectElement>('select'),
    ).find((select) =>
      select.closest('label')?.textContent?.includes('Release channel'),
    );
    expect(releaseChannel?.disabled).toBe(true);

    install.resolve({ exit_code: 0, log_tail: '', log_path: '' });
  });

  it('blocks Core install while a channel preference is still saving', async () => {
    const save = deferred<void>();
    stubInvoke({
      save: () => save.promise,
      coreState: {
        channel: 'release',
        targetRepo: 'indigo/hq-core',
        targetVersion: '15.0.17',
        targetRef: 'v15.0.17',
        localVersion: '15.0.16',
        floorSha: null,
        isEligible: true,
        versionBehind: true,
        driftReport: {
          baselineStatus: 'Available',
          updateRequired: true,
          count: 0,
          modified: [],
          missing: [],
          added: [],
          scannedAt: '2026-07-27T00:00:00Z',
          hqVersion: '15.0.16',
          targetRepo: 'indigo/hq-core',
          targetRef: 'v15.0.17',
        },
        unchangedCount: 0,
        userOnlyCount: 0,
        scannedAt: '2026-07-27T00:00:00Z',
      },
      installCore: async () => ({
        exit_code: 0,
        log_tail: '',
        log_path: '',
      }),
    });
    await mountSettings();
    await waitForSettingsReady();

    const update = await vi.waitFor(() => {
      const match = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Update to v15.0.17',
      );
      expect(match).toBeTruthy();
      return match!;
    });
    const staging = checkbox('HQ Core staging channel');
    staging.checked = !staging.checked;
    staging.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    expect(update.disabled).toBe(true);
    update.click();
    expect(tauri.invoke).not.toHaveBeenCalledWith('install_hq_core_update');
    expect(tauri.invoke).not.toHaveBeenCalledWith('run_replace_from_staging');

    save.resolve();
  });

  it('keeps a failed Core install log usable with pending, success, and error feedback', async () => {
    const logPath = '/Users/test/Library/Logs/HQ/hq-core-update.log';
    const install = deferred<{
      exit_code: number;
      log_tail: string;
      log_path: string;
    }>();
    const clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    stubInvoke({
      coreState: {
        channel: 'release',
        targetRepo: 'indigo/hq-core',
        targetVersion: '15.0.17',
        targetRef: 'v15.0.17',
        localVersion: '15.0.16',
        floorSha: null,
        isEligible: true,
        versionBehind: true,
        driftReport: {
          baselineStatus: 'Available',
          updateRequired: true,
          count: 0,
          modified: [],
          missing: [],
          added: [],
          scannedAt: '2026-07-27T00:00:00Z',
          hqVersion: '15.0.16',
          targetRepo: 'indigo/hq-core',
          targetRef: 'v15.0.17',
        },
        unchangedCount: 0,
        userOnlyCount: 0,
        scannedAt: '2026-07-27T00:00:00Z',
      },
      installCore: () => install.promise,
    });
    await mountSettings();
    await waitForSettingsReady();

    const update = await vi.waitFor(() => {
      flushSync();
      const match = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Update to v15.0.17',
      );
      expect(match).toBeTruthy();
      return match!;
    });
    update.click();
    flushSync();
    expect(update.disabled).toBe(true);
    expect(update.getAttribute('aria-busy')).toBe('true');
    expect(update.textContent?.trim()).toBe('Updating…');

    install.resolve({
      exit_code: 1,
      log_tail: 'permission denied',
      log_path: logPath,
    });

    const copy = await vi.waitFor(() => {
      flushSync();
      const status = host.querySelector('[data-testid="settings-core-status"]');
      expect(status?.textContent).toContain('Update failed. Review the install log');
      expect(status?.textContent).not.toContain(logPath);
      expect(
        host.querySelector('[data-testid="settings-core-install-log-path"]')?.textContent,
      ).toContain(logPath);
      expect(
        host
          .querySelector('[data-testid="settings-core-install-log-path"]')
          ?.closest('.core-update-row')
          ?.classList.contains('has-core-log'),
      ).toBe(true);
      const match = host.querySelector<HTMLButtonElement>(
        '[data-testid="settings-copy-core-install-log-path"]',
      );
      expect(match).toBeTruthy();
      return match!;
    });
    const open = host.querySelector<HTMLButtonElement>(
      '[data-testid="settings-open-core-install-log"]',
    );
    expect(open).toBeTruthy();

    const copyPending = deferred<void>();
    clipboardWrite.mockImplementationOnce(() => copyPending.promise);
    copy.click();
    flushSync();
    expect(copy.disabled).toBe(true);
    expect(copy.getAttribute('aria-busy')).toBe('true');
    expect(copy.textContent?.trim()).toBe('Copying…');
    copyPending.resolve();
    await vi.waitFor(() => {
      flushSync();
      expect(copy.textContent?.trim()).toBe('Path copied');
    });
    expect(clipboardWrite).toHaveBeenCalledWith(logPath);

    const openPending = deferred<void>();
    tauri.open.mockImplementationOnce(() => openPending.promise);
    open!.click();
    flushSync();
    expect(open!.disabled).toBe(true);
    expect(open!.getAttribute('aria-busy')).toBe('true');
    expect(open!.textContent?.trim()).toBe('Opening…');
    openPending.resolve();
    await vi.waitFor(() => {
      flushSync();
      expect(open!.textContent?.trim()).toBe('Opened');
    });
    expect(tauri.open).toHaveBeenCalledWith(logPath);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clipboardWrite.mockRejectedValueOnce(new Error('clipboard unavailable'));
    copy.click();
    await vi.waitFor(() => {
      flushSync();
      expect(copy.textContent?.trim()).toBe('Copy failed');
    });

    tauri.open.mockRejectedValueOnce(new Error('no log viewer'));
    open!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(open!.textContent?.trim()).toBe('Open failed');
    });
    consoleError.mockRestore();
  });
});
