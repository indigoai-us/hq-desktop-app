import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";

describe("showOsNotification", () => {
  it("reports host-owned native banners instead of invoking an unregistered command", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return undefined;
      },
    });
    const res = await adapter.appShell.showOsNotification({
      title: "Corey",
      body: "New message",
      route: '{"kind":"dm","personUid":"prs_corey"}',
    });
    expect(res).toMatchObject({ ok: false, reason: "unavailable", code: "host-owned" });
    expect(calls).toEqual([]);
  });
});
