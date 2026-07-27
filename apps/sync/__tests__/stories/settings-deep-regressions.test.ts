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
  installCli?: () => Promise<{ local: string | null; latest: string }>;
  installApp?: () => Promise<void>;
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
        return 'granted';
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
      case 'check_core_state':
        return null;
      case 'check_hq_cli_update':
        return options.cliUpdate ?? null;
      case 'install_hq_cli_update':
        return options.installCli?.();
      case 'install_update':
        return options.installApp?.();
      case 'get_hq_version':
        return '15.0.16';
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
    expect(host.querySelector('[aria-busy="false"]')).toBeTruthy();
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

  it('keeps every Settings control disabled until the persisted preferences load', async () => {
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
    const disabledGroup = host.querySelector<HTMLFieldSetElement>('fieldset[disabled]');
    expect(controls.length).toBeGreaterThan(0);
    expect(disabledGroup?.disabled).toBe(true);
    expect(controls.every((control) => disabledGroup?.contains(control))).toBe(true);

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

  it('reverts live toggles and skips their side effects when persistence fails', async () => {
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
    await vi.waitFor(() => expect(realtime.checked).toBe(true));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('disk is read-only');
    expect(tauri.invoke).not.toHaveBeenCalledWith('stop_daemon');

    const instant = checkbox('Instant sync');
    tauri.invoke.mockClear();
    instant.checked = false;
    instant.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(instant.checked).toBe(true));
    expect(tauri.invoke).not.toHaveBeenCalledWith('stop_daemon');
    expect(tauri.invoke).not.toHaveBeenCalledWith('start_daemon');

    const startAtLogin = checkbox('Start at login');
    tauri.invoke.mockClear();
    startAtLogin.checked = false;
    startAtLogin.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(startAtLogin.checked).toBe(true));
    expect(tauri.invoke).not.toHaveBeenCalledWith('set_autostart_enabled', {
      enabled: false,
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

    await vi.waitFor(() => expect(host.textContent).toContain('hq CLI update: v0.20.0'));
    const cliCard = Array.from(host.querySelectorAll<HTMLElement>('.notice-card')).find((card) =>
      card.textContent?.includes('hq CLI update:'),
    );
    const update = Array.from(cliCard?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Update',
    );
    update?.click();

    await vi.waitFor(() => expect(cliCard?.textContent).toContain('Update failed.'));
  });
});
