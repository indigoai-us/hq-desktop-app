import { describe, expect, it, vi } from "vitest";
import type { FlagClient, FlagSnapshot } from "@indigoai-us/hq-flags-client";
import { failure, ok } from "./adapter.js";
import {
  FLAG_REFRESH_INTERVAL_MS,
  MEETINGS_LEGACY_FLAG,
  MEETINGS_REGISTRY_KEY,
  bearerTokenFromHeaders,
  createFeatureFlagGate,
  createHqProFlagFetch,
  registryKeyFor,
} from "./flags.js";

function fakeClient(
  overrides: Pick<FlagClient, "ready" | "snapshot" | "isEnabled"> &
    Partial<Pick<FlagClient, "refresh">>,
): FlagClient {
  return {
    explain: () => ({ value: false, source: "fallback" }),
    refresh: async () => {},
    observeVersion: () => {},
    onSnapshotChange: () => () => {},
    version: () => overrides.snapshot()?.version ?? null,
    close: () => {},
    ...overrides,
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("registry key mapping", () => {
  it("maps meetings only", () => {
    expect(registryKeyFor("meetings")).toBe(MEETINGS_REGISTRY_KEY);
    expect(registryKeyFor(MEETINGS_LEGACY_FLAG)).toBe("desktop.meetings");
    expect(registryKeyFor("is_indigo_user")).toBeUndefined();
    expect(registryKeyFor("anything-else")).toBeUndefined();
  });
});

describe("createFeatureFlagGate", () => {
  it("snapshot missing → legacy path used", async () => {
    const isEnabled = vi.fn(() => false);
    const fallback = vi.fn(async () => ok(true));
    const createClient = vi.fn(() =>
      fakeClient({
        ready: async () => {},
        snapshot: () => null,
        isEnabled,
      }),
    );
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient,
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("snapshot present-but-unconfigured → legacy path used", async () => {
    const isEnabled = vi.fn(() => false);
    const fallback = vi.fn(async () => ok(true));
    const snapshot: FlagSnapshot = { version: 4, flags: {} };
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => snapshot,
          isEnabled,
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("snapshot loaded with a different key still uses legacy (unconfigured)", async () => {
    const isEnabled = vi.fn(() => false);
    const fallback = vi.fn(async () => ok(true));
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({ version: 1, flags: { "other.flag": true } }),
          isEnabled,
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(isEnabled).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("snapshot configured true → registry value, no legacy", async () => {
    const fallback = vi.fn(async () => ok(false));
    const isEnabled = vi.fn(() => true);
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({
            version: 2,
            flags: { "desktop.meetings": true },
          }),
          isEnabled,
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(isEnabled).toHaveBeenCalledWith("desktop.meetings");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("snapshot configured false → registry value, no legacy", async () => {
    const fallback = vi.fn(async () => ok(true));
    const isEnabled = vi.fn(() => false);
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({
            version: 2,
            flags: { "desktop.meetings": false },
          }),
          isEnabled,
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(
      ok(false),
    );
    expect(isEnabled).toHaveBeenCalledWith("desktop.meetings");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("registry throws → legacy path used and no rejection escapes", async () => {
    const fallback = vi.fn(async () => ok(true));
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {
            throw new Error("offline");
          },
          snapshot: () => {
            throw new Error("should not snapshot after ready() throw");
          },
          isEnabled: () => {
            throw new Error("should not isEnabled after ready() throw");
          },
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("isEnabled throw after a configured snapshot → legacy, no rejection", async () => {
    const fallback = vi.fn(async () => ok(true));
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({
            version: 1,
            flags: { "desktop.meetings": true },
          }),
          isEnabled: () => {
            throw new Error("client bug");
          },
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("does not construct a client for unmapped flags (is_indigo_user)", async () => {
    const createClient = vi.fn(() => {
      throw new Error("registry must not be touched");
    });
    const fallback = vi.fn(async () => ok(false));
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient,
    });

    await expect(gate.resolve("is_indigo_user", fallback)).resolves.toEqual(
      ok(false),
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("propagates a legacy AdapterResult error rather than swallowing it", async () => {
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => null,
          isEnabled: () => false,
        }),
    });
    const fallback = vi.fn(async () => failure("invoke", "Not signed in"));

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(
      failure("invoke", "Not signed in"),
    );
  });

  it("reuses one FlagClient across resolve calls", async () => {
    const createClient = vi.fn(() =>
      fakeClient({
        ready: async () => {},
        snapshot: () => null,
        isEnabled: () => false,
      }),
    );
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient,
    });
    await gate.resolve("meetings", async () => ok(true));
    await gate.resolve("meetings", async () => ok(true));
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("constructs FlagClient with the five-minute refresh interval", async () => {
    const createClient = vi.fn(() =>
      fakeClient({
        ready: async () => {},
        snapshot: () => null,
        isEnabled: () => false,
      }),
    );
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient,
    });
    await gate.resolve("meetings", async () => ok(true));
    expect(FLAG_REFRESH_INTERVAL_MS).toBe(300_000);
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ refreshIntervalMs: FLAG_REFRESH_INTERVAL_MS }),
    );
  });

  it("first load fails → later resolve recovers once and then returns the registry value", async () => {
    let snapshot: FlagSnapshot | null = null;
    const refresh = vi.fn(async () => {
      snapshot = {
        version: 2,
        flags: { "desktop.meetings": true },
      };
    });
    const isEnabled = vi.fn(() => true);
    const fallback = vi.fn(async () => ok(false));
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => snapshot,
          isEnabled,
          refresh,
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(false));
    expect(refresh).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(isEnabled).not.toHaveBeenCalled();

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(isEnabled).toHaveBeenCalledWith("desktop.meetings");
    expect(fallback).toHaveBeenCalledTimes(1);

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("concurrent hasFeature calls during a pending recovery share one refresh", async () => {
    const started = deferred();
    const finish = deferred();
    let snapshot: FlagSnapshot | null = null;
    const refresh = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      snapshot = {
        version: 1,
        flags: { "desktop.meetings": true },
      };
    });
    const isEnabled = vi.fn(() => true);
    const fallback = vi.fn(async () => ok(false));
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => snapshot,
          isEnabled,
          refresh,
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(false));
    expect(refresh).not.toHaveBeenCalled();

    const pending = [
      gate.resolve("meetings", fallback),
      gate.resolve("meetings", fallback),
      gate.resolve("meetings", fallback),
    ];
    await started.promise;
    expect(refresh).toHaveBeenCalledTimes(1);
    finish.resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      ok(true),
      ok(true),
      ok(true),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(isEnabled).toHaveBeenCalledTimes(3);
  });

  it("rate-limits recovery refresh to once per FLAG_REFRESH_INTERVAL_MS", async () => {
    let nowMs = 50_000;
    const refresh = vi.fn(async () => {});
    const fallback = vi.fn(async () => ok(true));
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      now: () => nowMs,
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => null,
          isEnabled: () => false,
          refresh,
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(refresh).toHaveBeenCalledTimes(1);

    nowMs += FLAG_REFRESH_INTERVAL_MS - 1;
    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(refresh).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(6);
  });

  it("throwing refresh() still yields the legacy answer with no unhandled rejection", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("refresh exploded");
    });
    const fallback = vi.fn(async () => ok(true));
    const gate = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => null,
          isEnabled: () => {
            throw new Error("should not isEnabled after failed refresh");
          },
          refresh,
        }),
    });

    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    await expect(gate.resolve("meetings", fallback)).resolves.toEqual(ok(true));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
    // Vitest fails the file on an unhandled rejection. Extra ticks give a
    // leaked rejection a chance to surface before the test ends.
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("createHqProFlagFetch", () => {
  it("invokes hq_pro_fetch with the path FlagClient would request", async () => {
    const invoke = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ version: 1, flags: { "desktop.meetings": true } }),
    }));
    const fetchFn = createHqProFlagFetch(invoke);
    const res = await fetchFn("https://unused.example/v1/flags/resolve");
    expect(invoke).toHaveBeenCalledWith("hq_pro_fetch", {
      url: "/v1/flags/resolve",
      method: "GET",
      body: null,
    });
    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toEqual({
      version: 1,
      flags: { "desktop.meetings": true },
    });
  });

  it("keeps a relative /v1/flags/resolve path (empty endpoint)", async () => {
    const invoke = vi.fn(async () => ({ status: 503, body: "down" }));
    const fetchFn = createHqProFlagFetch(invoke);
    const res = await fetchFn("/v1/flags/resolve");
    expect(invoke).toHaveBeenCalledWith("hq_pro_fetch", {
      url: "/v1/flags/resolve",
      method: "GET",
      body: null,
    });
    expect(res.status).toBe(503);
  });
});

describe("bearerTokenFromHeaders", () => {
  it("strips a Bearer prefix from either header spelling", () => {
    expect(bearerTokenFromHeaders({ Authorization: "Bearer abc" })).toBe("abc");
    expect(bearerTokenFromHeaders({ authorization: "bearer xyz" })).toBe("xyz");
    expect(bearerTokenFromHeaders({})).toBe("");
  });
});
