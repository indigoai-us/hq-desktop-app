import { describe, expect, it } from "vitest";

import { createSyncPlatformAdapter } from "./sync-adapter.js";

/** US-009: forwards go over hq_pro_fetch and keep the server's refusal body. */

function makeAdapter(reply: unknown) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const adapter = createSyncPlatformAdapter({
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (reply instanceof Error) throw reply;
      return reply;
    }) as never,
    fetch: (() => {
      throw new Error("window.fetch must not be used");
    }) as never,
    requestPolicy: { sleep: async () => {}, random: () => 0 },
  });
  return { adapter, calls };
}

const body = { toPersonUid: "prs_ana", body: "fyi", forwardOf: { conversationId: "ch_1", eventId: "e1" } };

describe("sync adapter forwardMessage", () => {
  it("POSTs the path and JSON body through hq_pro_fetch", async () => {
    const { adapter, calls } = makeAdapter({ status: 201, body: JSON.stringify({ eventId: "e9", omittedAttachments: 1 }) });
    const res = await adapter.messaging.forwardMessage!({ path: "/v1/notify/dm", body });
    expect(calls).toEqual([
      { cmd: "hq_pro_fetch", args: { url: "/v1/notify/dm", method: "POST", body: JSON.stringify(body) } },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe(201);
    expect(JSON.parse(res.value.body)).toEqual({ eventId: "e9", omittedAttachments: 1 });
  });

  it("returns a refusal's status and body so the server code reaches the picker", async () => {
    const refusal = JSON.stringify({ code: "CROSS_COMPANY_ACK_REQUIRED", error: "x" });
    const { adapter } = makeAdapter({ status: 409, body: refusal });
    const res = await adapter.messaging.forwardMessage!({ path: "/v1/notify/channels/c/messages", body });
    expect(res).toEqual({ ok: true, value: { status: 409, body: refusal } });
  });

  it("fails when HQ cannot be reached", async () => {
    const { adapter } = makeAdapter(new Error("offline"));
    const res = await adapter.messaging.forwardMessage!({ path: "/v1/notify/dm", body });
    expect(res.ok).toBe(false);
  });
});
