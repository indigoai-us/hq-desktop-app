// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import {
  CLOUD_PAUSED_STORAGE_KEY,
  CLOUD_PAUSED_CHANGED_EVENT,
  parseCloudPaused,
  resolveCloudPaused,
  loadCloudPaused,
  setCloudPaused,
  readCloudPaused,
} from './cloud-connection';

describe('hq-desktop-v2 US-001/US-016: Cloud Connected/Off flag', () => {
  it('parses the storage mirror contract', () => {
    expect(parseCloudPaused(null)).toBe(false);
    expect(parseCloudPaused('0')).toBe(false);
    expect(parseCloudPaused('1')).toBe(true);
    expect(parseCloudPaused('true')).toBe(true);
    expect(CLOUD_PAUSED_STORAGE_KEY).toBe('hq-sync.desktop.cloud-paused.v1');
    expect(CLOUD_PAUSED_CHANGED_EVENT).toBe('hq:cloud-paused-changed');
  });

  it('settings value wins; legacy localStorage applies (and migrates) only when settings is silent', () => {
    // Explicit settings boolean dominates whatever localStorage says.
    expect(resolveCloudPaused(true, null)).toEqual({ paused: true, migrateLegacy: false });
    expect(resolveCloudPaused(false, '1')).toEqual({ paused: false, migrateLegacy: false });
    // Settings never stored the flag → legacy pause applies AND migrates so
    // the Rust sync gates (which only read menubar.json) see it.
    expect(resolveCloudPaused(undefined, '1')).toEqual({ paused: true, migrateLegacy: true });
    expect(resolveCloudPaused(null, 'true')).toEqual({ paused: true, migrateLegacy: true });
    // Nothing anywhere → connected, nothing to migrate.
    expect(resolveCloudPaused(undefined, null)).toEqual({ paused: false, migrateLegacy: false });
  });
});

describe('hq-desktop-v2 US-001/US-016: settings write-through (the store the Rust gates read)', () => {
  let settingsOnDisk: Record<string, unknown>;

  // happy-dom under this Node delegates window.localStorage to Node's
  // experimental localStorage (unavailable without --localstorage-file), so
  // stub the flat key/value surface the module touches — same approach as
  // meetingsCache.test.ts.
  const store = new Map<string, string>();
  const memStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: memStorage, configurable: true });

  beforeEach(() => {
    window.localStorage.clear();
    settingsOnDisk = {};
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'get_settings') return { ...settingsOnDisk };
      if (command === 'save_settings') {
        settingsOnDisk = { ...(args?.prefs as Record<string, unknown>) };
        return undefined;
      }
      throw new Error(`unexpected command ${command}`);
    });
  });

  it('toggle round-trips through get/save_settings and mirrors to localStorage', async () => {
    const events: boolean[] = [];
    window.addEventListener(CLOUD_PAUSED_CHANGED_EVENT, (e) =>
      events.push((e as CustomEvent<boolean>).detail),
    );

    await setCloudPaused(true);
    expect(settingsOnDisk.cloudPaused).toBe(true);
    expect(readCloudPaused()).toBe(true);
    expect(await loadCloudPaused()).toBe(true);

    // Toggling back on restores all sync paths (flag cleared in settings).
    await setCloudPaused(false);
    expect(settingsOnDisk.cloudPaused).toBe(false);
    expect(readCloudPaused()).toBe(false);
    expect(await loadCloudPaused()).toBe(false);
    // set(true), load(true), set(false), load(false) each broadcast the change.
    expect(events).toEqual([true, true, false, false]);
  });

  it('migrates a legacy localStorage-only pause into settings on first read', async () => {
    window.localStorage.setItem(CLOUD_PAUSED_STORAGE_KEY, '1');
    expect(await loadCloudPaused()).toBe(true);
    // The migration writes through save_settings so Rust gates see the pause.
    expect(settingsOnDisk.cloudPaused).toBe(true);
  });

  it('falls back to the localStorage mirror when settings are unreachable', async () => {
    mocks.invoke.mockRejectedValue(new Error('backend down'));
    window.localStorage.setItem(CLOUD_PAUSED_STORAGE_KEY, '1');
    expect(await loadCloudPaused()).toBe(true);
  });
});
