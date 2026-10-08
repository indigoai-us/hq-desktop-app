import { describe, expect, it, vi } from "vitest";
import { failure, ok, type PlatformAdapter } from "./adapter.js";
import {
  ensureHqAnywhereGlobalRuntime,
  hqAnywhereRuntimeEnabled,
  retryHqAnywhereRequest,
  setHqAnywhereGlobalRuntime,
} from "./hq-anywhere-setting.js";

describe("HQ Anywhere setting support", () => {
  it("fails closed unless the rollout flag is explicitly configured and enabled", async () => {
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => ok({ enabled: true, configured: false })),
    } as unknown as PlatformAdapter["identity"];

    await expect(hqAnywhereRuntimeEnabled(identity)).resolves.toBe(false);
    expect(identity.resolveFeatureFlagStatus).toHaveBeenCalledWith("hq-anywhere-runtime");

    identity.resolveFeatureFlagStatus = vi.fn(async () => ok({ enabled: true, configured: true }));
    await expect(hqAnywhereRuntimeEnabled(identity)).resolves.toBe(true);
  });

  it("logs an unreadable rollout flag while failing closed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => {
        throw new Error("private flag service detail");
      }),
    } as unknown as PlatformAdapter["identity"];

    await expect(hqAnywhereRuntimeEnabled(identity)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[hq-anywhere] runtime flag lookup failed:",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("retries a setting request three times with increasing backoff", async () => {
    const pause = vi.fn(async (_milliseconds: number) => {});
    const request = vi
      .fn()
      .mockResolvedValueOnce(failure("network", "temporary"))
      .mockResolvedValueOnce(failure("token-refresh", "refreshed"))
      .mockResolvedValueOnce(ok(true));

    await expect(
      retryHqAnywhereRequest(request, { pause }),
    ).resolves.toEqual(ok(true));
    expect(request).toHaveBeenCalledTimes(3);
    expect(pause.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 750]);
  });

  it("returns the last failure after three attempts", async () => {
    const pause = vi.fn(async (_milliseconds: number) => {});
    const request = vi.fn(async () => failure("network", "private transport detail"));

    await expect(
      retryHqAnywhereRequest(request, { pause }),
    ).resolves.toEqual(failure("network", "private transport detail"));
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("installs on startup only when the flag and saved person setting are on", async () => {
    const syncHqAnywhereGlobal = vi.fn(async () => ok(undefined));
    const settings = {
      getHqAnywherePersonSetting: vi.fn(async () => ok(true)),
      syncHqAnywhereGlobal,
    } as unknown as PlatformAdapter["settings"];
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => ok({ enabled: true, configured: true })),
    } as unknown as PlatformAdapter["identity"];

    await expect(ensureHqAnywhereGlobalRuntime(identity, settings, { pause: async () => {} }))
      .resolves.toEqual(ok(undefined));
    expect(settings.getHqAnywherePersonSetting).toHaveBeenCalledTimes(1);
    expect(syncHqAnywhereGlobal).toHaveBeenCalledWith(true);
  });

  it("does not read or change global files while the runtime flag is off", async () => {
    const syncHqAnywhereGlobal = vi.fn(async () => ok(undefined));
    const getHqAnywherePersonSetting = vi.fn(async () => ok(true));
    const settings = {
      getHqAnywherePersonSetting,
      syncHqAnywhereGlobal,
    } as unknown as PlatformAdapter["settings"];
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => ok({ enabled: false, configured: true })),
    } as unknown as PlatformAdapter["identity"];

    await expect(setHqAnywhereGlobalRuntime(identity, settings, false, { pause: async () => {} }))
      .resolves.toEqual(ok(undefined));
    await expect(ensureHqAnywhereGlobalRuntime(identity, settings, { pause: async () => {} }))
      .resolves.toEqual(ok(undefined));
    expect(getHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(syncHqAnywhereGlobal).not.toHaveBeenCalled();
  });

  it("retries a global runtime change three times with backoff", async () => {
    const pause = vi.fn(async (_milliseconds: number) => {});
    const syncHqAnywhereGlobal = vi
      .fn()
      .mockResolvedValueOnce(failure("network", "private runtime detail"))
      .mockResolvedValueOnce(failure("network", "private runtime detail"))
      .mockResolvedValueOnce(ok(undefined));
    const settings = { syncHqAnywhereGlobal } as unknown as PlatformAdapter["settings"];
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => ok({ enabled: true, configured: true })),
    } as unknown as PlatformAdapter["identity"];

    await expect(setHqAnywhereGlobalRuntime(identity, settings, true, { pause }))
      .resolves.toEqual(ok(undefined));
    expect(syncHqAnywhereGlobal).toHaveBeenCalledTimes(3);
    expect(pause.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 750]);
  });
});
