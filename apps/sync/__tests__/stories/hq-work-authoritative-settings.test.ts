// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

// @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
import { mount, tick, unmount } from 'svelte';

import { createSyncPlatformAdapter, type SyncInvokeFn } from '@hq/platform';
import CompaniesSettingsPane from '../../../../packages/ui/src/settings/CompaniesSettingsPane.svelte';
import PrototypeSettingsPanes from '../../../../packages/ui/src/settings/PrototypeSettingsPanes.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

interface HostHarness {
  adapter: ReturnType<typeof createSyncPlatformAdapter>;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  persisted: () => Record<string, unknown>;
}

function nativeHost(
  initial: Record<string, unknown>,
  options: {
    failAutostart?: boolean;
    failCliVersion?: boolean;
    failCliCheck?: boolean;
    configRoot?: string;
    coreVersion?: string | null;
    cliVersion?: string | null;
  } = {},
): HostHarness {
  let saved = { ...initial };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke: SyncInvokeFn = async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case 'get_settings':
        return { ...saved };
      case 'get_config':
        return options.configRoot ? { hqFolderPath: options.configRoot } : {};
      case 'save_settings':
        saved = { ...((args?.prefs ?? {}) as Record<string, unknown>) };
        return undefined;
      case 'set_autostart_enabled':
        if (options.failAutostart) throw new Error('macOS rejected this login item');
        return undefined;
      case 'notification_permission_state':
        return 'granted';
      case 'meetings_list_accounts':
        return [];
      case 'daemon_status':
        return { running: true };
      case 'get_sync_status':
        return {};
      case 'get_hq_version':
        return 'coreVersion' in options ? options.coreVersion ?? null : '15.0.117';
      case 'get_hq_cli_version':
        if (options.failCliVersion) throw new Error('CLI not on the configured PATH');
        return 'cliVersion' in options ? options.cliVersion ?? null : '5.103.34';
      case 'check_for_updates':
        return null;
      case 'check_core_state':
        return { versionBehind: false };
      case 'check_hq_cli_update':
        if (options.failCliCheck) throw new Error('CLI update service unavailable');
        return null;
      case 'start_daemon':
      case 'stop_daemon':
      case 'apply_dock_icon':
      case 'apply_widget_settings':
        return undefined;
      default:
        return null;
    }
  };
  return {
    adapter: createSyncPlatformAdapter({ invoke }),
    calls,
    persisted: () => ({ ...saved }),
  };
}

function mountPane(
  section: 'general' | 'notifications' | 'sync' | 'meetings' | 'updates',
  adapter: ReturnType<typeof createSyncPlatformAdapter>,
  props: Record<string, unknown> = {},
): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { section, adapter, ...props },
  });
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('embedded HQ Work authoritative settings', () => {
  it('keeps Launch at login through an injected-host component remount', async () => {
    let persisted: Record<string, unknown> = {
      startAtLogin: false,
      dockIcon: true,
      widgetEnabled: true,
    };
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: SyncInvokeFn = async (command, args) => {
      calls.push({ command, args });
      if (command === 'get_settings') return { ...persisted };
      if (command === 'save_settings') {
        persisted = { ...((args?.prefs ?? {}) as Record<string, unknown>) };
        return undefined;
      }
      if (command === 'set_autostart_enabled') return undefined;
      if (command === 'notification_permission_state') return 'granted';
      if (command === 'meetings_list_accounts') return [];
      throw new Error(`Unexpected command: ${command}`);
    };
    const adapter = createSyncPlatformAdapter({ invoke });

    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: 'general', adapter },
    });

    await vi.waitFor(() => {
      expect(
        host.querySelector('[aria-label="Launch at login"]')?.getAttribute('aria-checked'),
      ).toBe('false');
    });

    host.querySelector<HTMLButtonElement>('[aria-label="Launch at login"]')?.click();

    await vi.waitFor(() => {
      expect(calls).toContainEqual({
        command: 'set_autostart_enabled',
        args: { enabled: true },
      });
      expect(calls).toContainEqual({
        command: 'save_settings',
        args: {
          prefs: {
            startAtLogin: true,
            dockIcon: true,
            widgetEnabled: true,
          },
        },
      });
    });
    expect(persisted.startAtLogin).toBe(true);

    await unmount(component);
    component = null;
    host.replaceChildren();
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: 'general', adapter },
    });
    await tick();

    await vi.waitFor(() => {
      expect(
        host.querySelector('[aria-label="Launch at login"]')?.getAttribute('aria-checked'),
      ).toBe('true');
    });
  });

  it('rolls Launch at login back with actionable native-host feedback when macOS rejects it', async () => {
    const { adapter, calls, persisted } = nativeHost(
      { startAtLogin: false },
      { failAutostart: true },
    );
    mountPane('general', adapter);

    await vi.waitFor(() => {
      expect(host.querySelector('[aria-label="Launch at login"]')?.getAttribute('aria-checked')).toBe('false');
    });
    host.querySelector<HTMLButtonElement>('[aria-label="Launch at login"]')?.click();

    await vi.waitFor(() => {
      expect(host.querySelector('[aria-label="Launch at login"]')?.getAttribute('aria-checked')).toBe('false');
      expect(host.querySelector('[data-testid="settings-native-error"]')?.textContent).toContain('macOS rejected this login item');
    });
    expect(calls.some((call) => call.command === 'save_settings')).toBe(false);
    expect(persisted().startAtLogin).toBe(false);
  });

  it('persists Dock and desktop-widget controls through native apply commands across an injected-host component remount', async () => {
    const { adapter, calls, persisted } = nativeHost({
      startAtLogin: false,
      dockIcon: true,
      widgetEnabled: false,
    });
    mountPane('general', adapter);
    await vi.waitFor(() => {
      expect(host.querySelector('[aria-label="Show in Dock"]')?.getAttribute('aria-checked')).toBe('true');
      expect(host.querySelector('[aria-label="Desktop widget"]')?.getAttribute('aria-checked')).toBe('false');
    });
    host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]')?.click();
    host.querySelector<HTMLButtonElement>('[aria-label="Desktop widget"]')?.click();
    await vi.waitFor(() => {
      expect(persisted().dockIcon).toBe(false);
      expect(persisted().widgetEnabled).toBe(true);
    });
    expect(calls).toContainEqual({ command: 'apply_dock_icon', args: undefined });
    expect(calls).toContainEqual({ command: 'apply_widget_settings', args: undefined });

    await unmount(component!);
    component = null;
    host.replaceChildren();
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: 'general', adapter },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[aria-label="Show in Dock"]')?.getAttribute('aria-checked')).toBe('false');
      expect(host.querySelector('[aria-label="Desktop widget"]')?.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('keeps a saved custom HQ root ahead of the general config root after an injected-host component remount', async () => {
    const { adapter } = nativeHost(
      { hqPath: '/custom/HQ' },
      { configRoot: '/configured/default-HQ' },
    );
    mountPane('sync', adapter);
    await vi.waitFor(() => {
      expect(host.textContent).toContain('/custom/HQ');
      expect(host.textContent).not.toContain('/configured/default-HQ');
    });
  });

  it('shows account-owned company rows without pretending that localStorage changes sync', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(CompaniesSettingsPane, {
      target: host,
      props: {
        companies: [
          {
            slug: 'acme', displayName: 'Acme', kind: 'company', state: 'synced',
            cloudUid: 'co_acme', bucketName: null, hasLocalFolder: true,
            localPath: '/tmp/acme', membershipStatus: 'active', role: 'member',
            lastSyncedAt: null, brokenReason: null, invitedBy: null, invitedAt: null,
          },
          {
            slug: 'former', displayName: 'Former company', kind: 'company', state: 'synced',
            cloudUid: 'co_former', bucketName: null, hasLocalFolder: false,
            localPath: null, membershipStatus: 'revoked', role: 'member',
            lastSyncedAt: null, brokenReason: null, invitedBy: null, invitedAt: null,
          },
        ],
      },
    });
    await tick();
    expect(host.querySelector('[data-testid="settings-company-sync-unavailable"]')?.textContent).toContain('not configurable');
    expect(host.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(host.textContent).toContain('Acme');
    expect(host.textContent).not.toContain('Former company');
  });

  it('writes sync, notification, meeting, and recording-company controls through native settings only', async () => {
    const { adapter, calls, persisted } = nativeHost({
      syncOnLaunch: true,
      realtimeSync: true,
      instantSync: true,
      personalSyncEnabled: true,
      notifications: true,
      shareNotifications: true,
      dmNotifications: true,
      meetingDetectNotify: { enabled: true, platforms: ['zoom', 'meet'] },
      defaultRecordingCompanyUid: 'co_stale_account',
    });

    mountPane('sync', adapter);
    await vi.waitFor(() => {
      const control = host.querySelector<HTMLButtonElement>('[aria-label="Sync on launch"]');
      expect(control?.getAttribute('aria-checked')).toBe('true');
      expect(control?.disabled).toBe(false);
    });
    host.querySelector<HTMLButtonElement>('[aria-label="Sync on launch"]')?.click();
    await vi.waitFor(() => expect(persisted().syncOnLaunch).toBe(false));
    expect(calls).toContainEqual({ command: 'save_settings', args: { prefs: expect.objectContaining({ syncOnLaunch: false }) } });
    host.querySelector<HTMLButtonElement>('[aria-label="Auto-sync"]')?.click();
    await vi.waitFor(() => expect(persisted().realtimeSync).toBe(false));
    expect(calls).toContainEqual({ command: 'stop_daemon', args: undefined });
    host.querySelector<HTMLButtonElement>('[aria-label="Instant sync"]')?.click();
    await vi.waitFor(() => expect(persisted().instantSync).toBe(false));
    host.querySelector<HTMLButtonElement>('[aria-label="Sync personal vault"]')?.click();
    await vi.waitFor(() => expect(persisted().personalSyncEnabled).toBe(false));

    await unmount(component!);
    component = null;
    host.replaceChildren();
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: 'notifications', adapter },
    });
    await vi.waitFor(() => {
      const control = host.querySelector<HTMLButtonElement>('[aria-label="Share notifications"]');
      expect(control?.getAttribute('aria-checked')).toBe('true');
      expect(control?.disabled).toBe(false);
    });
    host.querySelector<HTMLButtonElement>('[aria-label="Share notifications"]')?.click();
    await vi.waitFor(() => expect(persisted().shareNotifications).toBe(false));
    host.querySelector<HTMLButtonElement>('[aria-label="Meeting notifications"]')?.click();
    await vi.waitFor(() => expect(persisted().notifications).toBe(false));
    host.querySelector<HTMLButtonElement>('[aria-label="DM notifications"]')?.click();
    await vi.waitFor(() => expect(persisted().dmNotifications).toBe(false));

    await unmount(component);
    component = null;
    host.replaceChildren();
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: {
        section: 'meetings',
        adapter,
        companies: [
          {
            slug: 'acme', displayName: 'Acme', kind: 'company', state: 'synced',
            cloudUid: 'co_acme', bucketName: null, hasLocalFolder: true,
            localPath: '/tmp/acme', membershipStatus: 'active', role: 'member',
            lastSyncedAt: null, brokenReason: null, invitedBy: null, invitedAt: null,
          },
          {
            slug: 'other', displayName: 'Other', kind: 'company', state: 'synced',
            cloudUid: 'co_other', bucketName: null, hasLocalFolder: false,
            localPath: null, membershipStatus: 'pending', role: 'member',
            lastSyncedAt: null, brokenReason: null, invitedBy: null, invitedAt: null,
          },
        ],
      },
    });
    await vi.waitFor(() => {
      const select = host.querySelector<HTMLSelectElement>('#recording-company');
      expect(select?.value).toBe('');
      expect(select?.disabled).toBe(false);
    });
    expect(host.textContent).toContain('Acme');
    expect(host.textContent).not.toContain('Other');
    const recording = host.querySelector<HTMLSelectElement>('#recording-company');
    if (!recording) throw new Error('recording company select was not rendered');
    recording.value = 'co_acme';
    recording.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(persisted().defaultRecordingCompanyUid).toBe('co_acme'));
    host.querySelector<HTMLButtonElement>('[aria-label="Detected-meeting alerts"]')?.click();
    await vi.waitFor(() => {
      expect((persisted().meetingDetectNotify as { enabled?: boolean }).enabled).toBe(false);
    });
    const zoom = Array.from(host.querySelectorAll<HTMLButtonElement>('.theme-pills .chip'))
      .find((button) => button.textContent?.trim() === 'Zoom');
    zoom?.click();
    await vi.waitFor(() => {
      expect((persisted().meetingDetectNotify as { platforms?: string[] }).platforms).not.toContain('zoom');
    });
  });

  it('preserves successful version probes, never labels failed CLI data current, and refreshes on focus', async () => {
    const { adapter, calls, persisted } = nativeHost(
      { autoUpdate: false, hqPath: '/custom/HQ' },
      { failCliVersion: true, failCliCheck: true },
    );
    const refreshAppVersion = vi.fn(async () => '0.10.170');
    mountPane('updates', adapter, { version: '0.10.169', refreshAppVersion });

    await vi.waitFor(() => {
      const coreRow = Array.from(host.querySelectorAll<HTMLElement>('.set-row')).find(
        (row) => row.querySelector('.sn')?.textContent?.trim() === 'HQ Core',
      );
      const cliRow = Array.from(host.querySelectorAll<HTMLElement>('.set-row')).find(
        (row) => row.querySelector('.sn')?.textContent?.trim() === 'HQ CLI',
      );
      expect(coreRow?.textContent).toContain('UP TO DATE');
      expect(cliRow?.textContent).toContain('CHECK FAILED');
      expect(cliRow?.textContent).not.toContain('UP TO DATE');
      expect(host.querySelector('[data-testid="settings-cli-remediation"]')).toBeNull();
      expect(host.textContent).toContain('v0.10.170');
    });
    const checksBeforeFocus = calls.filter((call) => call.command === 'check_for_updates').length;
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.command === 'check_for_updates')).toHaveLength(checksBeforeFocus + 1);
    });

    host.querySelector<HTMLButtonElement>('[aria-label="Automatic updates"]')?.click();
    await vi.waitFor(() => expect(persisted().autoUpdate).toBe(true));
    expect(calls).toContainEqual({ command: 'save_settings', args: { prefs: expect.objectContaining({ autoUpdate: true, hqPath: '/custom/HQ' }) } });
  });

  it('replaces missing Core and CLI probes with actionable location status', async () => {
    const { adapter } = nativeHost(
      { hqPath: '/custom/HQ' },
      { coreVersion: null, cliVersion: null },
    );
    mountPane('updates', adapter);

    await vi.waitFor(() => {
      const coreRow = Array.from(host.querySelectorAll<HTMLElement>('.set-row')).find(
        (row) => row.querySelector('.sn')?.textContent?.trim() === 'HQ Core',
      );
      const cliRow = Array.from(host.querySelectorAll<HTMLElement>('.set-row')).find(
        (row) => row.querySelector('.sn')?.textContent?.trim() === 'HQ CLI',
      );
      expect(coreRow?.textContent).toContain('ROOT NEEDED');
      expect(cliRow?.textContent).toContain('CLI NEEDED');
      expect(coreRow?.textContent).not.toContain('Not detected');
      expect(cliRow?.textContent).not.toContain('Not checked');
      expect(cliRow?.textContent).not.toContain('Not detected');
    });
  });
});
