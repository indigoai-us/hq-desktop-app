import { describe, expect, it, vi } from "vitest";
import type { FlagClient, FlagSnapshot } from "@indigoai-us/hq-flags-client";
import { failure, ok } from "./adapter.js";
import {
  FIRST_LAUNCH_JOIN_KEY_FLAG as PUBLIC_FIRST_LAUNCH_JOIN_KEY_FLAG,
  HQ_ANYWHERE_RUNTIME_FLAG as PUBLIC_HQ_ANYWHERE_RUNTIME_FLAG,
  POST_READY_DROP_REASON_FLAG as PUBLIC_POST_READY_DROP_REASON_FLAG,
} from "./index.js";
import {
  CLAUDE_PROVIDER_FLAG,
  COMPANY_NAME_PREFILL_FLAG,
  COMPANY_ROUTE_LOOKUP_RETRY_FLAG,
  DESKTOP_LIMIT_STATUS_PUSH_FLAG,
  FIRST_LAUNCH_JOIN_KEY_FLAG,
  FLAG_REFRESH_INTERVAL_MS,
  HQ_ANYWHERE_RUNTIME_FLAG,
  LOGIN_RECEIPT_DURABILITY_FLAG,
  MEETINGS_LEGACY_FLAG,
  MEETINGS_REGISTRY_KEY,
  PERSONAL_WORKSPACE_BOARD_FLAG,
  PERSONAL_TRANSCRIPTS_FLAG,
  POST_READY_ACTION_TELEMETRY_FLAG,
  POST_READY_DROP_REASON_FLAG,
  READY_FIRST_ACTION_FLAG,
  SETUP_DEPS_TIMEOUT_RETRY_FLAG,
  VISUAL_FIRST_RUN_FLAG,
  bearerTokenFromHeaders,
  createFeatureFlagGate,
  createHqProFlagFetch,
  registryKeyFor,
} from "./flags.js";
import { createSyncPlatformAdapter } from "./tauri/sync-adapter.js";

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
  it("maps HQ Anywhere availability to the admin rollout flag", () => {
    expect(HQ_ANYWHERE_RUNTIME_FLAG).toBe("hq-anywhere-runtime");
    expect(PUBLIC_HQ_ANYWHERE_RUNTIME_FLAG).toBe(HQ_ANYWHERE_RUNTIME_FLAG);
    expect(registryKeyFor(HQ_ANYWHERE_RUNTIME_FLAG)).toBe(HQ_ANYWHERE_RUNTIME_FLAG);
  });

  it("exports the first-launch join-key flag through the public platform entrypoint", () => {
    expect(PUBLIC_FIRST_LAUNCH_JOIN_KEY_FLAG).toBe(FIRST_LAUNCH_JOIN_KEY_FLAG);
  });

  it("maps company name prefill to its hq-flags key", () => {
    expect(COMPANY_NAME_PREFILL_FLAG).toBe("desktop.company-name-prefill-v1");
    expect(registryKeyFor(COMPANY_NAME_PREFILL_FLAG)).toBe(COMPANY_NAME_PREFILL_FLAG);
  });

  it("maps the meetings and Claude provider registry flags", () => {
    expect(registryKeyFor("meetings")).toBe(MEETINGS_REGISTRY_KEY);
    expect(registryKeyFor(MEETINGS_LEGACY_FLAG)).toBe("desktop.meetings");
    expect(registryKeyFor(CLAUDE_PROVIDER_FLAG)).toBe(CLAUDE_PROVIDER_FLAG);
    expect(registryKeyFor("is_indigo_user")).toBeUndefined();
    expect(registryKeyFor("anything-else")).toBeUndefined();
  });

  it("registers the first-launch join-key rollout through the default-off hq-flags mapping", () => {
    expect(FIRST_LAUNCH_JOIN_KEY_FLAG).toBe("desktop.first-launch-join-key-v1");
    expect(registryKeyFor(FIRST_LAUNCH_JOIN_KEY_FLAG)).toBe(
      FIRST_LAUNCH_JOIN_KEY_FLAG,
    );
  });

  it("maps the personal workspace board through the default-off hq-flags gate", () => {
    expect(PERSONAL_WORKSPACE_BOARD_FLAG).toBe(
      "desktop.personal-workspace-board-v1",
    );
    expect(registryKeyFor(PERSONAL_WORKSPACE_BOARD_FLAG)).toBe(
      PERSONAL_WORKSPACE_BOARD_FLAG,
    );
  });

  it("maps personal meeting transcripts to the hq-flags registry", () => {
    expect(PERSONAL_TRANSCRIPTS_FLAG).toBe(
      "desktop.meetings-personal-transcripts",
    );
    expect(registryKeyFor(PERSONAL_TRANSCRIPTS_FLAG)).toBe(
      PERSONAL_TRANSCRIPTS_FLAG,
    );
  });

  it("registers desktop limit status push as a default-off hq-flags key", () => {
    expect(DESKTOP_LIMIT_STATUS_PUSH_FLAG).toBe("desktop.limit-status-push");
    expect(registryKeyFor(DESKTOP_LIMIT_STATUS_PUSH_FLAG)).toBe(
      DESKTOP_LIMIT_STATUS_PUSH_FLAG,
    );
  });

  it("maps the first-folder onboarding flag using the registry key format", () => {
    const key = "desktop.first-folder-sync-step-v1";
    expect(key).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/);
    expect(registryKeyFor(key)).toBe(key);
  });

  it("maps the company-route lookup retry through its hq-flags registry key", () => {
    expect(COMPANY_ROUTE_LOOKUP_RETRY_FLAG).toBe(
      "desktop.company-route-lookup-retry-v1",
    );
    expect(registryKeyFor(COMPANY_ROUTE_LOOKUP_RETRY_FLAG)).toBe(
      COMPANY_ROUTE_LOOKUP_RETRY_FLAG,
    );
  });



  it("maps receipt durability through the hq-flags registry", () => {
    expect(LOGIN_RECEIPT_DURABILITY_FLAG).toBe(
      "desktop.login-receipt-durable-before-return-v1",
    );
    expect(registryKeyFor(LOGIN_RECEIPT_DURABILITY_FLAG)).toBe(
      LOGIN_RECEIPT_DURABILITY_FLAG,
    );
  });

  it("maps post-ready action telemetry through its default-off hq-flags key", () => {
    expect(POST_READY_ACTION_TELEMETRY_FLAG).toBe("desktop.post-ready-action-telemetry-v1");
    expect(registryKeyFor(POST_READY_ACTION_TELEMETRY_FLAG)).toBe(POST_READY_ACTION_TELEMETRY_FLAG);
  });

  it("maps the ready first action through its default-off hq-flags key", () => {
    expect(READY_FIRST_ACTION_FLAG).toBe("desktop.ready-first-action-v1");
    expect(registryKeyFor(READY_FIRST_ACTION_FLAG)).toBe(READY_FIRST_ACTION_FLAG);
  });

  it("maps dependency setup timeout retries through the default-off hq-flags key", () => {
    expect(SETUP_DEPS_TIMEOUT_RETRY_FLAG).toBe(
      "desktop.setup-deps-timeout-retry-v1",
    );
    expect(registryKeyFor(SETUP_DEPS_TIMEOUT_RETRY_FLAG)).toBe(
      SETUP_DEPS_TIMEOUT_RETRY_FLAG,
    );
  });

  it("keeps dependency setup timeout retries off unless hq-flags enables them", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({ version: 1, flags: {} }),
          isEnabled,
        }),
    });

    await expect(
      adapter.identity.hasFeature(SETUP_DEPS_TIMEOUT_RETRY_FLAG),
    ).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("fails closed when the dependency setup timeout retry flag cannot be read", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({
          ready: async () => {
            throw new Error("registry unavailable");
          },
          snapshot: () => null,
          isEnabled,
        }),
    });

    await expect(
      adapter.identity.hasFeature(SETUP_DEPS_TIMEOUT_RETRY_FLAG),
    ).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("uses an explicitly enabled dependency setup timeout retry flag", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({
            version: 1,
            flags: { [SETUP_DEPS_TIMEOUT_RETRY_FLAG]: true },
          }),
          isEnabled,
        }),
    });

    await expect(
      adapter.identity.hasFeature(SETUP_DEPS_TIMEOUT_RETRY_FLAG),
    ).resolves.toEqual(ok(true));
    expect(isEnabled).toHaveBeenCalledWith(SETUP_DEPS_TIMEOUT_RETRY_FLAG);
  });

  it("maps visual first-run setup through its desktop hq-flags key", () => {
    expect(VISUAL_FIRST_RUN_FLAG).toBe("desktop.visual-first-run");
    expect(registryKeyFor(VISUAL_FIRST_RUN_FLAG)).toBe(VISUAL_FIRST_RUN_FLAG);
  });

  it("keeps visual first-run setup off when hq-flags has no value for it", async () => {
    const isEnabled = vi.fn(() => true);
    const invoke = vi.fn(async () => undefined);
    const adapter = createSyncPlatformAdapter({
      invoke,
      createFlagClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({ version: 1, flags: {} }),
          isEnabled,
        }),
    });

    await expect(adapter.identity.hasFeature(VISUAL_FIRST_RUN_FLAG)).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
    // Off without asking hq-pro's per-feature route either.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps visual first-run setup off when the registry cannot be read", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({
          ready: async () => {
            throw new Error("registry unavailable");
          },
          snapshot: () => null,
          isEnabled,
        }),
    });

    await expect(adapter.identity.hasFeature(VISUAL_FIRST_RUN_FLAG)).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("turns visual first-run setup on only for an explicit hq-flags value", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({ version: 1, flags: { [VISUAL_FIRST_RUN_FLAG]: true } }),
          isEnabled,
        }),
    });

    await expect(adapter.identity.hasFeature(VISUAL_FIRST_RUN_FLAG)).resolves.toEqual(ok(true));
    expect(isEnabled).toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
  });

  it("keeps the ready first action off until hq-flags configures it", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () => fakeClient({
        ready: async () => {},
        snapshot: () => ({ version: 1, flags: {} }),
        isEnabled,
      }),
    });

    await expect(adapter.identity.hasFeature(READY_FIRST_ACTION_FLAG)).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("keeps post-ready action telemetry off until hq-flags configures it", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () => fakeClient({
        ready: async () => {},
        snapshot: () => ({ version: 1, flags: {} }),
        isEnabled,
      }),
    });

    await expect(adapter.identity.hasFeature(POST_READY_ACTION_TELEMETRY_FLAG)).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("keeps post-ready drop diagnostics off until hq-flags configures them", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () => fakeClient({
        ready: async () => {},
        snapshot: () => ({ version: 1, flags: {} }),
        isEnabled,
      }),
    });

    await expect(adapter.identity.hasFeature(POST_READY_DROP_REASON_FLAG)).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
    expect(PUBLIC_POST_READY_DROP_REASON_FLAG).toBe("desktop.post-ready-drop-reason-v1");
  });

  it("keeps login receipt durability off when the registry is unavailable", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({ ready: async () => {}, snapshot: () => null, isEnabled }),
    });
    await expect(
      adapter.identity.hasFeature(LOGIN_RECEIPT_DURABILITY_FLAG),
    ).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
  });
});

describe("createFeatureFlagGate", () => {

  it("keeps personal workspace board reads off when hq-flags has no configured value", async () => {
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({ version: 1, flags: {} }),
          isEnabled,
        }),
    });

    await expect(
      adapter.identity.hasFeature(PERSONAL_WORKSPACE_BOARD_FLAG),
    ).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("exposes configured versus fallback status through the sync adapter", async () => {
    const key = SETUP_DEPS_TIMEOUT_RETRY_FLAG;
    const configured = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () => fakeClient({
        ready: async () => {},
        snapshot: () => ({ version: 1, flags: { [key]: false } }),
        isEnabled: () => false,
      }),
    });
    await expect(configured.identity.resolveFeatureFlagStatus?.(key)).resolves.toEqual(
      ok({ enabled: false, configured: true }),
    );

    const missing = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () => fakeClient({
        ready: async () => {},
        snapshot: () => null,
        isEnabled: () => false,
      }),
    });
    await expect(missing.identity.resolveFeatureFlagStatus?.(key)).resolves.toEqual(
      ok({ enabled: false, configured: false }),
    );
  });

  it("uses the first-folder registry override when it is explicitly enabled", async () => {
    const key = "desktop.first-folder-sync-step-v1";
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => ({ version: 1, flags: { [key]: true } }),
          isEnabled,
        }),
    });

    await expect(adapter.identity.hasFeature(key)).resolves.toEqual(ok(true));
    expect(isEnabled).toHaveBeenCalledExactlyOnceWith(key);
  });

  it("keeps the first-folder gate off when the flag registry is unavailable", async () => {
    const key = "desktop.first-folder-sync-step-v1";
    const isEnabled = vi.fn(() => true);
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async () => undefined),
      createFlagClient: () =>
        fakeClient({
          ready: async () => {},
          snapshot: () => null,
          isEnabled,
        }),
    });

    await expect(adapter.identity.hasFeature(key)).resolves.toEqual(ok(false));
    expect(isEnabled).not.toHaveBeenCalled();
  });





  it("reports whether a value was explicitly configured instead of fallback", async () => {
    const key = SETUP_DEPS_TIMEOUT_RETRY_FLAG;
    const configured = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () => fakeClient({
        ready: async () => {},
        snapshot: () => ({ version: 1, flags: { [key]: false } }),
        isEnabled: () => false,
      }),
    });
    await expect(configured.resolveStatus(key, async () => ok(false))).resolves.toEqual(
      ok({ enabled: false, configured: true }),
    );

    const missing = createFeatureFlagGate({
      endpoint: "https://api.test",
      getToken: () => "token",
      createClient: () => fakeClient({
        ready: async () => {},
        snapshot: () => ({ version: 1, flags: {} }),
        isEnabled: () => false,
      }),
    });
    await expect(missing.resolveStatus(key, async () => ok(false))).resolves.toEqual(
      ok({ enabled: false, configured: false }),
    );
  });


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
