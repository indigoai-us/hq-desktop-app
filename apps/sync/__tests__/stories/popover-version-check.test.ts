// @vitest-environment happy-dom
//
// Popover version section — "Check all updates" runs through the SHARED
// checkAllUpdates orchestration (src/lib/update-check.ts), the same module
// the Settings → Updates pane and the macOS app-menu path use. These tests
// pin that wiring: one click fans out to all three update commands, both
// rendered rows (Desktop app + HQ Core) go busy and refresh inline, and the
// CLI target (no row on this surface) can fail without touching the others.

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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountPopout(): HTMLElement {
  component = mount(VersionPopout, {
    target: host,
    props: {
      version: '0.10.170',
      onOpenSettings: vi.fn(),
      onclose: vi.fn(),
    },
  });
  flushSync();
  return host;
}

function text(testId: string): string {
  return host.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '';
}

function checkButton(): HTMLButtonElement {
  const match = host.querySelector<HTMLButtonElement>(
    '[data-testid="version-popout-check"]',
  );
  expect(match).toBeTruthy();
  return match!;
}

async function waitForIdle(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(checkButton().disabled).toBe(false);
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  tauri.listen.mockImplementation(async () => vi.fn(() => tauri.unlisten()));
  settings.update.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('popover version section shared update check', () => {
  it('fans one click out to app, core, and cli checks and refreshes both rows inline', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return null;
      if (command === 'get_settings') return { autoUpdate: true };
      if (command === 'get_hq_version') return '12.4.0';
      if (command === 'check_core_state')
        return {
          channel: 'release',
          versionBehind: false,
          targetVersion: '12.4.0',
          driftReport: { count: 0 },
        };
      if (command === 'check_for_updates') return null;
      if (command === 'check_hq_cli_update') return null;
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForIdle();
    tauri.invoke.mockClear();

    checkButton().click();
    flushSync();
    // Both rendered rows report busy from the single action.
    expect(text('version-popout-status')).toBe('Checking…');
    expect(text('version-popout-core-status')).toBe('Checking channel status…');
    expect(checkButton().disabled).toBe(true);

    await vi.waitFor(() => {
      flushSync();
      expect(text('version-popout-status')).toBe('Up to date');
    });
    expect(text('version-popout-core-status')).toBe('Release · Up to date');
    expect(text('version-popout-core-current')).toBe('v12.4.0');

    // The shared orchestration fanned out to all three targets.
    expect(tauri.invoke).toHaveBeenCalledWith('check_for_updates');
    expect(tauri.invoke).toHaveBeenCalledWith('check_core_state');
    expect(tauri.invoke).toHaveBeenCalledWith('check_hq_cli_update');
  });

  it('keeps app and core results when the row-less CLI target fails', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return null;
      if (command === 'get_settings') return { autoUpdate: true };
      if (command === 'get_hq_version') return '12.4.0';
      if (command === 'check_core_state')
        return {
          channel: 'release',
          versionBehind: true,
          targetVersion: '12.5.0',
          driftReport: { count: 0 },
        };
      if (command === 'check_for_updates') return { version: '0.10.171' };
      if (command === 'check_hq_cli_update') throw new Error('registry offline');
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForIdle();
    checkButton().click();

    await vi.waitFor(() => {
      flushSync();
      expect(text('version-popout-status')).toBe('Update available');
    });
    expect(text('version-popout-latest')).toBe('v0.10.171');
    expect(text('version-popout-core-status')).toContain('Update available to v12.5.0');
  });

  it('marks only the app row failed when its check rejects, core still refreshes', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_pending_update') return null;
      if (command === 'get_settings') return { autoUpdate: true };
      if (command === 'get_hq_version') return '12.4.0';
      if (command === 'check_core_state')
        return {
          channel: 'release',
          versionBehind: false,
          targetVersion: '12.4.0',
          driftReport: { count: 0 },
        };
      if (command === 'check_for_updates') throw new Error('offline');
      if (command === 'check_hq_cli_update') return null;
      throw new Error(`Unexpected invoke: ${command}`);
    });

    mountPopout();
    await waitForIdle();
    checkButton().click();

    await vi.waitFor(() => {
      flushSync();
      expect(text('version-popout-status')).toBe('Check failed');
    });
    expect(text('version-popout-core-status')).toBe('Release · Up to date');
  });
});
