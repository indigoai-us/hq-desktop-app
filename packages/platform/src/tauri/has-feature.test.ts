import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

describe("TauriPlatformAdapter hasFeature", () => {
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
