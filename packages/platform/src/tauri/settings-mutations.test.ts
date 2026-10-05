import { describe, expect, it, vi } from "vitest";

import {
  SettingsMutationQueue,
  type SettingsInvoker,
} from "./settings-mutations.js";

describe("SettingsMutationQueue", () => {
  it("logs a rejected save and still runs the next patch", async () => {
    const prefs: Record<string, unknown> = { existing: 1 };
    let fail = true;
    const invoke: SettingsInvoker = async (command, args) => {
      if (command === "get_settings") return { ...prefs };
      if (command === "save_settings") {
        if (fail) throw new Error("disk full");
        Object.assign(prefs, (args?.prefs ?? {}) as Record<string, unknown>);
        return undefined;
      }
      throw new Error(`unexpected ${command}`);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const queue = new SettingsMutationQueue(invoke);
      await expect(
        queue.update({ a: 1, note: "sekret-prefs-value" }),
      ).rejects.toThrow("disk full");
      expect(warn).toHaveBeenCalledWith(
        "settings-mutations: mutation failed",
        "disk full",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "sekret-prefs-value",
      );
      fail = false;
      await expect(queue.update({ b: 2 })).resolves.toBeUndefined();
      expect(prefs).toEqual({ existing: 1, b: 2 });
    } finally {
      warn.mockRestore();
    }
  });
});
