// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import {
  CLOUD_SWITCH_CACHE_KEY,
  announceCloudSwitch,
  cloudEnabledFromSettings,
  loadCloudEnabled,
  onCloudSwitchChanged,
  readCachedCloudEnabled,
} from "./cloud-switch.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

afterEach(() => {
  memoryStorage.clear();
});

function adapterWith(
  getCloudEnabled?: NonNullable<PlatformAdapter["sync"]["getCloudEnabled"]>,
  canSync = true,
): PlatformAdapter {
  return {
    isAvailable: (capability: string) => capability === "canSync" && canSync,
    sync: getCloudEnabled ? { getCloudEnabled } : {},
  } as unknown as PlatformAdapter;
}

describe("cloud-switch helpers (US-016)", () => {
  it("reads cloudPaused from a settings payload and ignores anything else", () => {
    expect(cloudEnabledFromSettings({ cloudPaused: true })).toBe(false);
    expect(cloudEnabledFromSettings({ cloudPaused: false })).toBe(true);
    expect(cloudEnabledFromSettings({})).toBeNull();
    expect(cloudEnabledFromSettings({ cloudPaused: "yes" })).toBeNull();
    expect(cloudEnabledFromSettings(null)).toBeNull();
  });

  it("caches the last-known value for the next paint", () => {
    expect(readCachedCloudEnabled()).toBeNull();
    announceCloudSwitch(false);
    expect(memoryStorage.getItem(CLOUD_SWITCH_CACHE_KEY)).toBe("off");
    expect(readCachedCloudEnabled()).toBe(false);
    announceCloudSwitch(true);
    expect(readCachedCloudEnabled()).toBe(true);
  });

  it("loads from the host and refreshes the cache", async () => {
    const value = await loadCloudEnabled(adapterWith(async () => ok(false)));
    expect(value).toBe(false);
    expect(readCachedCloudEnabled()).toBe(false);
  });

  it("keeps the painted value when the host has no switch, is web, or fails", async () => {
    expect(await loadCloudEnabled(adapterWith(undefined))).toBeNull();
    expect(await loadCloudEnabled(adapterWith(async () => ok(false), false))).toBeNull();
    expect(
      await loadCloudEnabled(adapterWith(async () => failure("error", "nope"))),
    ).toBeNull();
    expect(readCachedCloudEnabled()).toBeNull();
  });

  it("notifies subscribers in this window and stops after unsubscribe", () => {
    const seen = vi.fn();
    const stop = onCloudSwitchChanged(seen);
    announceCloudSwitch(false);
    stop();
    announceCloudSwitch(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(false);
  });
});
