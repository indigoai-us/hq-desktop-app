import { describe, expect, it, vi } from "vitest";
import { failure, ok, type PlatformAdapter } from "./adapter.js";
import {
  ensureHqAnywhereGlobalRuntime,
  hqAnywhereRuntimeEnabled,
  retryHqAnywhereRequest,
  isHqAnywhereSetupPending,
  setHqAnywhereGlobalRuntime,
  subscribeHqAnywhereGlobalRuntimeStatus,
} from "./hq-anywhere-setting.js";

describe("HQ Anywhere setting support", () => {
  it("is on unless the flag is explicitly configured and false", async () => {
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => ok({ enabled: false, configured: false })),
    } as unknown as PlatformAdapter["identity"];

    await expect(hqAnywhereRuntimeEnabled(identity)).resolves.toBe(true);
    expect(identity.resolveFeatureFlagStatus).toHaveBeenCalledWith("hq-anywhere-runtime");

    identity.resolveFeatureFlagStatus = vi.fn(async () => ok({ enabled: true, configured: true }));
    await expect(hqAnywhereRuntimeEnabled(identity)).resolves.toBe(true);

    identity.resolveFeatureFlagStatus = vi.fn(async () => ok({ enabled: false, configured: true }));
    await expect(hqAnywhereRuntimeEnabled(identity)).resolves.toBe(false);

    identity.resolveFeatureFlagStatus = vi.fn(async () => failure("network", "down"));
    await expect(hqAnywhereRuntimeEnabled(identity)).resolves.toBe(true);
  });

  it("logs an unreadable rollout flag and treats it as on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => {
        throw new Error("private flag service detail");
      }),
    } as unknown as PlatformAdapter["identity"];

    await expect(hqAnywhereRuntimeEnabled(identity)).resolves.toBe(true);
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
    expect(syncHqAnywhereGlobal).toHaveBeenCalledWith(true, false);
  });

  it("applies a saved opt-out during startup reconciliation", async () => {
    const syncHqAnywhereGlobal = vi.fn(async () => ok(undefined));
    const settings = {
      getHqAnywherePersonSetting: vi.fn(async () => ok(false)),
      syncHqAnywhereGlobal,
    } as unknown as PlatformAdapter["settings"];
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => ok({ enabled: true, configured: true })),
    } as unknown as PlatformAdapter["identity"];

    await expect(ensureHqAnywhereGlobalRuntime(identity, settings, { pause: async () => {} }))
      .resolves.toEqual(ok(undefined));
    expect(syncHqAnywhereGlobal).toHaveBeenCalledWith(false, false);
  });

  // The desktop removes a setup whose record no longer matches only when the
  // person turned the switch off themselves (hq_anywhere.rs GlobalInstallTrigger).
  it("passes a person's own choice to the desktop and keeps launch sync a reconcile", async () => {
    const syncHqAnywhereGlobal = vi.fn(async () => ok(undefined));
    const settings = {
      getHqAnywherePersonSetting: vi.fn(async () => ok(false)),
      syncHqAnywhereGlobal,
    } as unknown as PlatformAdapter["settings"];
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => ok({ enabled: true, configured: true })),
    } as unknown as PlatformAdapter["identity"];

    await expect(
      setHqAnywhereGlobalRuntime(identity, settings, false, { pause: async () => {}, explicit: true }),
    ).resolves.toEqual(ok(undefined));
    await expect(setHqAnywhereGlobalRuntime(identity, settings, false, { pause: async () => {} }))
      .resolves.toEqual(ok(undefined));
    await expect(ensureHqAnywhereGlobalRuntime(identity, settings, { pause: async () => {} }))
      .resolves.toEqual(ok(undefined));
    expect(syncHqAnywhereGlobal.mock.calls).toEqual([[false, true], [false, false], [false, false]]);
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

  // HQ Anywhere is GA: a missing or unreadable flag is on, so launch sync
  // passes the saved setting (false by default) to the desktop. The desktop
  // removes only a setup it turned on itself, so a CLI-made
  // `hq install --global` survives (hq_anywhere.rs launch_sync_leaves_* tests).
  it.each([
    ["missing", async () => ok({ enabled: false, configured: false })],
    ["failing", async () => failure("network", "down")],
    [
      "throwing",
      async () => {
        throw new Error("private flag service detail");
      },
    ],
  ])("runs launch sync with the saved setting when the flag lookup is %s", async (_case, lookup) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const syncHqAnywhereGlobal = vi.fn(async () => ok(undefined));
    const getHqAnywherePersonSetting = vi.fn(async () => ok(false));
    const settings = {
      getHqAnywherePersonSetting,
      syncHqAnywhereGlobal,
    } as unknown as PlatformAdapter["settings"];
    const identity = {
      resolveFeatureFlagStatus: vi.fn(lookup),
    } as unknown as PlatformAdapter["identity"];

    await expect(ensureHqAnywhereGlobalRuntime(identity, settings, { pause: async () => {} }))
      .resolves.toEqual(ok(undefined));
    expect(getHqAnywherePersonSetting).toHaveBeenCalledTimes(1);
    expect(syncHqAnywhereGlobal).toHaveBeenCalledTimes(1);
    expect(syncHqAnywhereGlobal).toHaveBeenCalledWith(false, false);
    warn.mockRestore();
  });

  it("clears pending setup when the flag turns off before global files are touched", async () => {
    const syncHqAnywhereGlobal = vi.fn(async () => ok(undefined));
    const settings = {
      getHqAnywherePersonSetting: vi.fn(async () => ok(true)),
      syncHqAnywhereGlobal,
    } as unknown as PlatformAdapter["settings"];
    const identity = {
      resolveFeatureFlagStatus: vi
        .fn()
        .mockResolvedValueOnce(ok({ enabled: true, configured: true }))
        .mockResolvedValueOnce(ok({ enabled: false, configured: true })),
    } as unknown as PlatformAdapter["identity"];
    const statuses: Array<{ state: string }> = [];
    const unsubscribe = subscribeHqAnywhereGlobalRuntimeStatus((status) => {
      statuses.push(status);
    });

    try {
      await expect(
        ensureHqAnywhereGlobalRuntime(identity, settings, { pause: async () => {} }),
      ).resolves.toEqual(ok(undefined));
      expect(statuses).toContainEqual({ state: "running", enabled: null });
      expect(statuses.at(-1)).toEqual({ state: "idle" });
      expect(syncHqAnywhereGlobal).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
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

  it("recognizes setup_pending by code or by an invoke message prefix", () => {
    expect(isHqAnywhereSetupPending(failure("setup_pending", "waiting"))).toBe(true);
    expect(
      isHqAnywhereSetupPending(
        failure("invoke", "setup_pending: HQ Anywhere waits for HQ setup to finish installing hq"),
      ),
    ).toBe(true);
    expect(isHqAnywhereSetupPending(failure("invoke", "hq not found"))).toBe(false);
    expect(isHqAnywhereSetupPending(ok(undefined))).toBe(false);
  });

  it("does not retry a request that is waiting for first-run setup", async () => {
    const pause = vi.fn(async (_milliseconds: number) => {});
    const pending = failure(
      "invoke",
      "setup_pending: HQ Anywhere waits for HQ setup to finish installing hq",
    );
    const request = vi.fn(async () => pending);

    await expect(retryHqAnywhereRequest(request, { pause })).resolves.toEqual(pending);
    expect(request).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("publishes a pending status when the runtime change waits for setup", async () => {
    const syncHqAnywhereGlobal = vi.fn(async () =>
      failure("invoke", "setup_pending: HQ Anywhere waits for HQ setup to finish installing hq"),
    );
    const settings = { syncHqAnywhereGlobal } as unknown as PlatformAdapter["settings"];
    const identity = {
      resolveFeatureFlagStatus: vi.fn(async () => ok({ enabled: true, configured: true })),
    } as unknown as PlatformAdapter["identity"];
    const statuses: Array<{ state: string }> = [];
    const unsubscribe = subscribeHqAnywhereGlobalRuntimeStatus((status) => {
      statuses.push(status);
    });

    try {
      const result = await setHqAnywhereGlobalRuntime(identity, settings, true, {
        pause: async () => {},
      });
      expect(isHqAnywhereSetupPending(result)).toBe(true);
      expect(syncHqAnywhereGlobal).toHaveBeenCalledTimes(1);
      expect(statuses.at(-1)).toEqual({ state: "pending", enabled: true });
    } finally {
      unsubscribe();
    }
  });
});
