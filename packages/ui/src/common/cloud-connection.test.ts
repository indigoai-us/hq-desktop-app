import { beforeEach, describe, expect, it } from "vitest";

import {
  CLOUD_PAUSED_STORAGE_KEY,
  CLOUD_PAUSED_CHANGED_EVENT,
  parseCloudPaused,
  resolveCloudPaused,
  loadCloudPaused,
  setCloudPaused,
  readCloudPaused,
  type CloudSettingsIo,
  type StorageLike,
} from "./cloud-connection";

describe("hq-desktop-v2 US-001/US-016: Cloud Connected/Off flag", () => {
  it("parses the storage mirror contract", () => {
    expect(parseCloudPaused(null)).toBe(false);
    expect(parseCloudPaused("0")).toBe(false);
    expect(parseCloudPaused("1")).toBe(true);
    expect(parseCloudPaused("true")).toBe(true);
    expect(CLOUD_PAUSED_STORAGE_KEY).toBe("hq-sync.desktop.cloud-paused.v1");
    expect(CLOUD_PAUSED_CHANGED_EVENT).toBe("hq:cloud-paused-changed");
  });

  it("settings value wins; legacy localStorage applies (and migrates) only when settings is silent", () => {
    // Explicit settings boolean dominates whatever localStorage says.
    expect(resolveCloudPaused(true, null)).toEqual({
      paused: true,
      migrateLegacy: false,
    });
    expect(resolveCloudPaused(false, "1")).toEqual({
      paused: false,
      migrateLegacy: false,
    });
    // Settings never stored the flag → legacy pause applies AND migrates so
    // the native sync gates (which only read the settings store) see it.
    expect(resolveCloudPaused(undefined, "1")).toEqual({
      paused: true,
      migrateLegacy: true,
    });
    expect(resolveCloudPaused(null, "true")).toEqual({
      paused: true,
      migrateLegacy: true,
    });
    // Nothing anywhere → connected, nothing to migrate.
    expect(resolveCloudPaused(undefined, null)).toEqual({
      paused: false,
      migrateLegacy: false,
    });
  });
});

describe("hq-desktop-v2 US-001/US-016: settings write-through (the store the native gates read)", () => {
  let settingsOnDisk: Record<string, unknown>;
  let ioBroken: boolean;

  // Adapter-seam fake replacing the former Tauri get/save_settings mock.
  const io: CloudSettingsIo = {
    async getSettings() {
      if (ioBroken)
        return { ok: false, reason: "error", message: "backend down" };
      return { ok: true, value: { ...settingsOnDisk } };
    },
    async updateSettings(patch) {
      if (ioBroken)
        return { ok: false, reason: "error", message: "backend down" };
      settingsOnDisk = { ...settingsOnDisk, ...patch };
      return { ok: true, value: undefined };
    },
  };

  const store = new Map<string, string>();
  const memStorage: StorageLike = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  };
  let events: boolean[] = [];
  const env = {
    storage: memStorage,
    dispatch: (paused: boolean) => events.push(paused),
  };

  beforeEach(() => {
    store.clear();
    settingsOnDisk = {};
    ioBroken = false;
    events = [];
  });

  it("toggle round-trips through the settings io and mirrors to storage", async () => {
    await setCloudPaused(io, true, env);
    expect(settingsOnDisk.cloudPaused).toBe(true);
    expect(readCloudPaused(env)).toBe(true);
    expect(await loadCloudPaused(io, env)).toBe(true);

    // Toggling back on restores all sync paths (flag cleared in settings).
    await setCloudPaused(io, false, env);
    expect(settingsOnDisk.cloudPaused).toBe(false);
    expect(readCloudPaused(env)).toBe(false);
    expect(await loadCloudPaused(io, env)).toBe(false);
    // set(true), load(true), set(false), load(false) each broadcast the change.
    expect(events).toEqual([true, true, false, false]);
  });

  it("migrates a legacy storage-only pause into settings on first read", async () => {
    memStorage.setItem(CLOUD_PAUSED_STORAGE_KEY, "1");
    expect(await loadCloudPaused(io, env)).toBe(true);
    // The migration writes through the settings io so native gates see the pause.
    expect(settingsOnDisk.cloudPaused).toBe(true);
  });

  it("falls back to the storage mirror when settings are unreachable", async () => {
    ioBroken = true;
    memStorage.setItem(CLOUD_PAUSED_STORAGE_KEY, "1");
    expect(await loadCloudPaused(io, env)).toBe(true);
  });

  it("surfaces a failed save so the initiating control can roll back", async () => {
    ioBroken = true;
    await expect(setCloudPaused(io, true, env)).rejects.toThrow("backend down");
  });
});
