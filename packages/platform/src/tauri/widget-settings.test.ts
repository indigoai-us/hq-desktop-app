import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";
import { WebPlatformAdapter } from "../web/index.js";

describe("setDesktopWidget", () => {
  it("desktop invokes apply_widget_settings with enabled", async () => {
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
      { cmd: "apply_widget_settings", args: { enabled: false } },
    ]);
  });

  it("desktop posts native banners via show_os_notification", async () => {
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
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      {
        cmd: "show_os_notification",
        args: {
          title: "Corey",
          body: "New message",
          route: '{"kind":"dm","personUid":"prs_corey"}',
        },
      },
    ]);
  });

  it("web reports desktop-only", async () => {
    const adapter = new WebPlatformAdapter({ baseUrl: "https://api.test" });
    const res = await adapter.appShell.setDesktopWidget(true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
  });
});
