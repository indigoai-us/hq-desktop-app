import { describe, expect, it, vi } from "vitest";
import type { FlagClient, FlagSnapshot } from "@indigoai-us/hq-flags-client";
import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";
import {
  COMPANY_NAME_PREFILL_FLAG,
  COMPANY_ROUTE_LOOKUP_RETRY_FLAG,
  PERSONAL_TRANSCRIPTS_FLAG,
  registryKeyFor,
} from "../flags.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

/** A flag client whose unlisted methods are inert. */
function fakeClient(over: Partial<FlagClient>): FlagClient {
  return {
    ready: async () => {},
    snapshot: () => null,
    isEnabled: () => false,
    refresh: async () => {},
    explain: () => ({ value: false, source: "fallback" }),
    observeVersion: () => {},
    onSnapshotChange: () => () => {},
    version: () => 1,
    close: () => {},
    ...over,
  } as FlagClient;
}

function makeFlagClient(
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

describe("TauriPlatformAdapter hasFeature", () => {
  it("personal transcript flag fails closed when its registry is unavailable", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") return { status: 503, body: "down" };
        if (cmd === "has_feature") return true;
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await expect(adapter.identity.hasFeature(PERSONAL_TRANSCRIPTS_FLAG)).resolves.toEqual({
      ok: true,
      value: false,
    });
    expect(calls.map((call) => call.cmd)).toEqual(["hq_pro_fetch"]);
  });

  it("Claude provider flag reads the signed-in user's registry value", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") {
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: { "agents.claude-provider": true },
            }),
          };
        }
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(
      adapter.identity.hasFeature("agents.claude-provider"),
    ).resolves.toEqual({ ok: true, value: true });
    expect(calls.map((call) => call.cmd)).toEqual(["hq_pro_fetch"]);
  });

  it("Claude provider flag fails closed when the registry is unavailable", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") return { status: 503, body: "down" };
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(
      adapter.identity.hasFeature("agents.claude-provider"),
    ).resolves.toEqual({ ok: true, value: false });
    expect(calls.map((call) => call.cmd)).toEqual(["hq_pro_fetch"]);
  });

  it("meetings: snapshot missing → legacy has_feature command", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") {
          return { status: 503, body: "down" };
        }
        if (cmd === "has_feature") return true;
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(adapter.identity.hasFeature("meetings")).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(calls.map((c) => c.cmd)).toEqual(["hq_pro_fetch", "has_feature"]);
    expect(calls[1]?.args).toEqual({ flag: "meetings" });
  });

  it("is_indigo_user never probes the registry", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "has_feature") return false;
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(
      adapter.identity.hasFeature("is_indigo_user"),
    ).resolves.toEqual({ ok: true, value: false });
    expect(calls).toEqual([
      { cmd: "has_feature", args: { flag: "is_indigo_user" } },
    ]);
  });
});

describe("createSyncPlatformAdapter hasFeature", () => {
  it('falls back to hq-pro when the company-route lookup retry registry snapshot is unavailable', async () => {
    expect(registryKeyFor(COMPANY_ROUTE_LOOKUP_RETRY_FLAG)).toBe(COMPANY_ROUTE_LOOKUP_RETRY_FLAG);
    const enabledSnapshot = vi.fn(() => ({ version: 1, flags: { [COMPANY_ROUTE_LOOKUP_RETRY_FLAG]: true } }));
    const enabledCheck = vi.fn(() => true);
    const enabled = createSyncPlatformAdapter({
      invoke: async (cmd) => {
        if (cmd === 'hq_pro_fetch') return { status: 200, body: 'true' };
        throw new Error(`unexpected ${cmd}`);
      },
      createFlagClient: () => makeFlagClient({
        ready: async () => {},
        snapshot: enabledSnapshot,
        isEnabled: enabledCheck,
      }),
    });
    const enabledResult = await enabled.identity.hasFeature(COMPANY_ROUTE_LOOKUP_RETRY_FLAG);
    expect(enabledSnapshot).toHaveBeenCalled();
    expect(enabledCheck).toHaveBeenCalledWith(COMPANY_ROUTE_LOOKUP_RETRY_FLAG);
    expect(enabledResult).toEqual({
      ok: true,
      value: true,
    });

    const unavailable = createSyncPlatformAdapter({
      invoke: async (cmd) => {
        if (cmd === 'hq_pro_fetch') return { status: 200, body: 'true' };
        throw new Error(`unexpected ${cmd}`);
      },
      createFlagClient: () => makeFlagClient({
        ready: async () => { throw new Error('offline'); },
        snapshot: () => null,
        isEnabled: () => true,
      }),
    });
    await expect(unavailable.identity.hasFeature(COMPANY_ROUTE_LOOKUP_RETRY_FLAG)).resolves.toEqual({
      ok: true,
      value: true,
    });
  });

  it('force-refreshes the hq-flags client for identity-scoped route resolution', async () => {
    const refresh = vi.fn(async () => {});
    const adapter = createSyncPlatformAdapter({
      invoke: async () => undefined,
      createFlagClient: () => ({
        ready: async () => {},
        snapshot: () => ({ version: 1, flags: {} }),
        isEnabled: () => false,
        refresh,
        explain: () => ({ value: false, source: 'fallback' }),
        observeVersion: () => {},
        onSnapshotChange: () => () => {},
        version: () => 1,
        close: () => {},
      }),
    });

    await adapter.identity.refreshFeatureFlags?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps company-name prefill off when the registry snapshot is missing or unavailable', async () => {
    const absent = createSyncPlatformAdapter({
      invoke: async (cmd) => {
        if (cmd === 'hq_pro_fetch') return { status: 200, body: 'true' };
        throw new Error(`unexpected ${cmd}`);
      },
      createFlagClient: () => makeFlagClient({
        ready: async () => {},
        snapshot: () => null,
        isEnabled: () => true,
      }),
    });
    await expect(absent.identity.hasFeature(COMPANY_NAME_PREFILL_FLAG)).resolves.toEqual({ ok: true, value: false });

    const unavailable = createSyncPlatformAdapter({
      invoke: async (cmd) => {
        if (cmd === 'hq_pro_fetch') return { status: 200, body: 'true' };
        throw new Error(`unexpected ${cmd}`);
      },
      createFlagClient: () => makeFlagClient({
        ready: async () => { throw new Error('offline'); },
        snapshot: () => null,
        isEnabled: () => true,
      }),
    });
    await expect(unavailable.identity.hasFeature(COMPANY_NAME_PREFILL_FLAG)).resolves.toEqual({ ok: true, value: false });
  });

  it("personal transcript flag reads true from the registry snapshot", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") {
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: { [PERSONAL_TRANSCRIPTS_FLAG]: true },
            }),
          };
        }
        if (cmd === "has_feature") return true;
        throw new Error(`unexpected ${cmd}`);
      },
    });

    await expect(adapter.identity.hasFeature(PERSONAL_TRANSCRIPTS_FLAG)).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(calls.map((call) => call.cmd)).toEqual(["hq_pro_fetch"]);
  });

  it("personal transcript flag fails closed when absent or the registry errors", async () => {
    const absent = createSyncPlatformAdapter({
      invoke: async (cmd) => {
        if (cmd === "hq_pro_fetch") {
          return { status: 200, body: JSON.stringify({ version: 1, flags: {} }) };
        }
        if (cmd === "has_feature") return true;
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(absent.identity.hasFeature(PERSONAL_TRANSCRIPTS_FLAG)).resolves.toEqual({
      ok: true,
      value: false,
    });

    const unavailable = createSyncPlatformAdapter({
      invoke: async (cmd) => {
        if (cmd === "hq_pro_fetch") throw new Error("offline");
        if (cmd === "has_feature") return true;
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(unavailable.identity.hasFeature(PERSONAL_TRANSCRIPTS_FLAG)).resolves.toEqual({
      ok: true,
      value: false,
    });
  });

  it("personal transcript subscription emits the updated registry snapshot", async () => {
    let snapshot: FlagSnapshot = {
      version: 1,
      flags: { [PERSONAL_TRANSCRIPTS_FLAG]: false },
    };
    const listeners = new Set<() => void>();
    const client = {
      ready: vi.fn(async () => {}),
      snapshot: () => snapshot,
      isEnabled: (key: string) => snapshot.flags[key] === true,
      onSnapshotChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refresh: async () => {},
      close: () => {},
      explain: () => ({ value: false, source: "fallback" }),
    } as unknown as FlagClient;
    const adapter = createSyncPlatformAdapter({
      invoke: async () => undefined,
      createFlagClient: () => client,
    });
    const seen: unknown[] = [];
    const unsubscribe = adapter.identity.subscribeFeature?.(
      PERSONAL_TRANSCRIPTS_FLAG,
      (result) => seen.push(result),
    );
    snapshot = { version: 2, flags: { [PERSONAL_TRANSCRIPTS_FLAG]: true } };
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(seen).toEqual([{ ok: true, value: true }]));
    unsubscribe?.();
  });

  it("Claude provider flag fails closed when the registry is unavailable", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") return { status: 503, body: "down" };
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(
      adapter.identity.hasFeature("agents.claude-provider"),
    ).resolves.toEqual({ ok: true, value: false });
    expect(calls.map((call) => call.cmd)).toEqual(["hq_pro_fetch"]);
  });

  it("meetings: configured registry value wins over meetings_feature_enabled", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") {
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: { "desktop.meetings": false },
            }),
          };
        }
        if (cmd === "meetings_feature_enabled") return true;
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(adapter.identity.hasFeature("meetings")).resolves.toEqual({
      ok: true,
      value: false,
    });
    expect(calls.map((c) => c.cmd)).toEqual(["hq_pro_fetch"]);
    expect(calls.some((c) => c.cmd === "meetings_feature_enabled")).toBe(
      false,
    );
  });

  it("meetings: registry configured true stays true (desktop path untouched)", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") {
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: { "desktop.meetings": true },
            }),
          };
        }
        if (cmd === "meetings_feature_enabled") return false;
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(adapter.identity.hasFeature("meetings")).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(calls.map((c) => c.cmd)).toEqual(["hq_pro_fetch"]);
    expect(calls.some((c) => c.cmd === "meetings_feature_enabled")).toBe(
      false,
    );
  });

  it("is_indigo_user stays on the Rust command", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "is_indigo_user") return false;
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(
      adapter.identity.hasFeature("is_indigo_user"),
    ).resolves.toEqual({ ok: true, value: false });
    expect(calls).toEqual([{ cmd: "is_indigo_user", args: undefined }]);
  });
});

describe("desktop.human-only-conversations is on by default in desktop adapters", () => {
  const FLAG = "desktop.human-only-conversations";
  function registryOff(calls: Invocation[]) {
    return async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "hq_pro_fetch") {
        return {
          status: 200,
          body: JSON.stringify({ version: 1, flags: { [FLAG]: false } }),
        };
      }
      if (cmd === "has_feature") return false;
      throw new Error(`unexpected ${cmd}`);
    };
  }

  it("sync adapter resolves true even when the registry says false", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({ invoke: registryOff(calls) });
    await expect(adapter.identity.hasFeature(FLAG)).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(calls).toEqual([]);
  });

  it("sync adapter resolves true when the registry is unavailable", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        throw new Error("offline");
      },
    });
    await expect(adapter.identity.hasFeature(FLAG)).resolves.toEqual({
      ok: true,
      value: true,
    });
  });

  it("sync adapter subscription never pushes a value for the flag", () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({ invoke: registryOff(calls) });
    const seen: unknown[] = [];
    const unsubscribe = adapter.identity.subscribeFeature?.(FLAG, (r) =>
      seen.push(r),
    );
    expect(typeof unsubscribe).toBe("function");
    unsubscribe?.();
    expect(seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("TauriPlatformAdapter resolves true even when the registry says false", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({ invoke: registryOff(calls) });
    await expect(adapter.identity.hasFeature(FLAG)).resolves.toEqual({
      ok: true,
      value: true,
    });
    const seen: unknown[] = [];
    adapter.identity.subscribeFeature?.(FLAG, (r) => seen.push(r))?.();
    expect(seen).toEqual([]);
    expect(calls).toEqual([]);
  });
});
