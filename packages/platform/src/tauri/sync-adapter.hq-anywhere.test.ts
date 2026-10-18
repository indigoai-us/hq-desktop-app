import { describe, expect, it, vi } from "vitest";
import { ok } from "../adapter.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

describe("sync adapter HQ Anywhere person setting", () => {
  it("maps reads and writes to the authenticated Tauri commands", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "get_hq_anywhere_person_setting") return false;
      return undefined;
    });
    const adapter = createSyncPlatformAdapter({ invoke });

    await expect(adapter.settings.getHqAnywherePersonSetting?.()).resolves.toEqual(ok(false));
    await expect(adapter.settings.putHqAnywherePersonSetting?.(true)).resolves.toEqual(ok(undefined));
    await expect(adapter.settings.syncHqAnywhereGlobal?.(true)).resolves.toEqual(ok(undefined));

    expect(invoke.mock.calls).toEqual([
      ["get_hq_anywhere_person_setting", undefined],
      ["put_hq_anywhere_person_setting", { value: true }],
      ["set_hq_anywhere_global_install", { enabled: true }],
    ]);
  });

  it("installs the runtime setup for one coding tool", async () => {
    const invoke = vi.fn(async () => undefined);
    const adapter = createSyncPlatformAdapter({ invoke });

    await expect(adapter.settings.installRuntimeForTool?.("codex")).resolves.toEqual(ok(undefined));

    expect(invoke.mock.calls).toEqual([["install_hq_runtime_for_tool", { runtime: "codex" }]]);
  });

  it("reads whether one tool's HQ Anywhere setup is installed", async () => {
    const invoke = vi.fn(async () => true);
    const adapter = createSyncPlatformAdapter({ invoke });

    await expect(adapter.settings.hqAnywhereRuntimeInstalled?.("claude")).resolves.toEqual(ok(true));

    expect(invoke.mock.calls).toEqual([["hq_anywhere_runtime_installed", { runtime: "claude" }]]);
  });
});
