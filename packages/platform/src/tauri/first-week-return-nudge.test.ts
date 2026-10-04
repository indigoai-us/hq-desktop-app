import { describe, expect, it } from "vitest";
import { WEB_PATHS } from "../web/index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

describe("Sync PlatformAdapter first-week return nudge", () => {
  it("reads company eligibility through the authenticated hq-pro bridge", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return {
          status: 200,
          body: JSON.stringify({ eligible: true, dayIndex: 2, reason: "eligible" }),
        };
      },
    });

    const result = await adapter.company.getFirstWeekReturnNudge("cmp_team/a");

    expect(result).toMatchObject({
      ok: true,
      value: { eligible: true, dayIndex: 2, reason: "eligible" },
    });
    expect(calls).toEqual([
      {
        cmd: "hq_pro_fetch",
        args: {
          url: WEB_PATHS.firstWeekReturnNudge("cmp_team/a"),
          method: "GET",
          body: null,
        },
      },
    ]);
  });
});
