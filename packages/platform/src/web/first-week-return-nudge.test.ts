import { describe, expect, it } from "vitest";
import { WebPlatformAdapter } from "./index.js";

describe("WebPlatformAdapter first-week return nudge", () => {
  it("reads the membership-scoped eligibility route with the company selector in the query", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      headers: { Authorization: "Bearer test-token" },
      fetch: async (input, init) => {
        calls.push({ method: init?.method ?? "GET", path: String(input).replace("https://api.test", "") });
        return new Response(JSON.stringify({ eligible: false, dayIndex: 2, reason: "used_today" }), { status: 200 });
      },
    });

    await expect(adapter.company.getFirstWeekReturnNudge("cmp_team/a")).resolves.toEqual({
      ok: true,
      value: { eligible: false, dayIndex: 2, reason: "used_today" },
    });
    expect(calls).toEqual([{
      method: "GET",
      path: "/membership/first-week-return-nudge?companyUid=cmp_team%2Fa",
    }]);
  });
});
