import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

describe("TauriPlatformAdapter hasFeature", () => {
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
