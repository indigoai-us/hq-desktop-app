import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";
import { WebPlatformAdapter } from "../web/index.js";

describe("setDesktopWidget", () => {
  it("persists then invokes the Sync host widget apply command without arguments", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return undefined;
      },
    });
    const res = await adapter.appShell.setDesktopWidget(false);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      { cmd: "get_settings", args: undefined },
      { cmd: "save_settings", args: { prefs: { widgetEnabled: false } } },
      { cmd: "apply_widget_settings", args: undefined },
    ]);
  });

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

  it("web reports desktop-only", async () => {
    const adapter = new WebPlatformAdapter({ baseUrl: "https://api.test" });
    const res = await adapter.appShell.setDesktopWidget(true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
  });
});
