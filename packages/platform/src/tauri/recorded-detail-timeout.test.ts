import { describe, expect, it } from "vitest";
import { createSyncPlatformAdapter, RECORDED_DETAIL_TIMEOUT_SECS } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

/**
 * OWNER-019 part 2: GET /v1/meetings/{id}?companyId= for a company meeting
 * with signals answered in 14.4-15.9 s on 2026-10-03; the native client's
 * shared bound is 15 s, so the detail read timed out and the meeting showed
 * "Couldn't load the notes". The detail read asks for a longer bound.
 */
describe("recorded meeting detail read bound", () => {
  it("asks hq_pro_fetch for a bound well past the 15 s default", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      fetch: (() => {
        throw new Error("the adapter must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") {
          return { status: 200, body: JSON.stringify({ meetingId: "m-1", sourceShape: "markdown" }) };
        }
        throw new Error(`unexpected ${cmd}`);
      },
    });
    const res = await adapter.meetings.getRecorded("m-1", "cmp_EXAMPLE");
    expect(res.ok).toBe(true);
    const fetch = calls.find((c) => c.cmd === "hq_pro_fetch");
    expect(fetch?.args?.url).toBe("/v1/meetings/m-1?companyId=cmp_EXAMPLE");
    expect(fetch?.args?.timeoutSecs).toBe(RECORDED_DETAIL_TIMEOUT_SECS);
    expect(RECORDED_DETAIL_TIMEOUT_SECS).toBeGreaterThanOrEqual(30);
  });

  it("other hq-pro reads keep the shared bound", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      fetch: (() => {
        throw new Error("the adapter must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") return { status: 200, body: JSON.stringify({ meetings: [] }) };
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await adapter.meetings.listRecorded("cmp_EXAMPLE");
    expect(calls.find((c) => c.cmd === "hq_pro_fetch")?.args).not.toHaveProperty("timeoutSecs");
  });
});
