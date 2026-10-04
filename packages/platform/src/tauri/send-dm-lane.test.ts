/**
 * A direct message for the bot only (`audience: "agent"`), or one sent under
 * an idempotency key, must leave this adapter with both fields. The native
 * `send_dm` command carries neither, so such a message goes to hq-pro the way
 * the Sync adapter sends it (review A-I12: the hidden hello went out from
 * apps/work as an ordinary direct message).
 */
import { describe, expect, it } from "vitest";

import { TauriPlatformAdapter } from "./index.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function makeAdapter(): { adapter: TauriPlatformAdapter; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const adapter = new TauriPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "hq_pro_fetch") return { status: 200, body: '{"eventId":"evt_1"}' };
      return {};
    },
  });
  return { adapter, calls };
}

describe("TauriPlatformAdapter sendDm", () => {
  it("sends a bot-only message through hq-pro with its lane and its key", async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.messaging.sendDm("agt_nova", "Automatic message from HQ: hello", {
      audience: "agent",
      idempotencyKey: " hello-agt_nova ",
    });

    expect(result).toMatchObject({ ok: true, value: { eventId: "evt_1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("hq_pro_fetch");
    expect(calls[0]!.args).toMatchObject({ url: "/v1/notify/dm", method: "POST" });
    expect(JSON.parse(calls[0]!.args!.body as string)).toEqual({
      toPersonUid: "agt_nova",
      body: "Automatic message from HQ: hello",
      audience: "agent",
      idempotencyKey: "hello-agt_nova",
    });
  });

  it("sends a keyed message through hq-pro even without a lane", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.messaging.sendDm("prs_ada", "hi", { idempotencyKey: "k1" });

    expect(calls.map((call) => call.cmd)).toEqual(["hq_pro_fetch"]);
    expect(JSON.parse(calls[0]!.args!.body as string)).toEqual({
      toPersonUid: "prs_ada",
      body: "hi",
      idempotencyKey: "k1",
    });
  });

  it("keeps the native command for an ordinary message", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.messaging.sendDm("prs_ada", "hi");
    await adapter.messaging.sendDm("prs_ada", "hi", { idempotencyKey: "   " });

    expect(calls).toEqual([
      { cmd: "send_dm", args: { toPersonUid: "prs_ada", body: "hi", attachments: null } },
      { cmd: "send_dm", args: { toPersonUid: "prs_ada", body: "hi", attachments: null } },
    ]);
  });
});
