import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "@hq/platform";

import { asReplyThread, createConversationApi, unwrapAdapter } from "./conversation-api.js";

type Messaging = Record<string, unknown>;

function adapterWith(messaging: Messaging): PlatformAdapter {
  return { messaging } as unknown as PlatformAdapter;
}

const ok = <T>(value: T) => ({ ok: true as const, value });

describe("unwrapAdapter", () => {
  it("returns the value of a successful result", () => {
    expect(unwrapAdapter(ok(42))).toBe(42);
  });

  it("throws the message, prefixed with the code when there is one", () => {
    expect(() => unwrapAdapter({ ok: false, message: "nope", code: "E1" })).toThrow("[E1] nope");
    expect(() => unwrapAdapter({ ok: false, message: "nope" })).toThrow(/^nope$/);
  });

  it("falls back to the reason, then a generic message", () => {
    expect(() => unwrapAdapter({ ok: false, reason: "unavailable" })).toThrow("unavailable");
    expect(() => unwrapAdapter({})).toThrow("request failed");
  });
});

describe("asReplyThread", () => {
  it("normalizes root and replies and keeps an explicit reply count", () => {
    const thread = asReplyThread({
      scope: "dm",
      root: { eventId: "root-1", body: "hi" },
      replies: [{ eventId: "r-1", body: "a" }, { id: "r-2", body: "b" }, { body: "no id" }],
      replyCount: 7,
    });
    expect(thread.scope).toBe("dm");
    expect(thread.root?.eventId).toBe("root-1");
    expect(thread.replies.map((reply) => reply.eventId)).toEqual(["r-1", "r-2"]);
    expect(thread.replyCount).toBe(7);
  });

  it("uses the root's reply count, then the reply length, when none is given", () => {
    expect(
      asReplyThread({ root: { eventId: "root", replyCount: 3 }, replies: [] }).replyCount,
    ).toBe(3);
    expect(asReplyThread({ replies: [{ eventId: "a" }, { eventId: "b" }] }).replyCount).toBe(2);
  });

  it("treats anything that is not an object as an empty channel thread", () => {
    for (const raw of [null, undefined, "x", [1, 2]]) {
      expect(asReplyThread(raw)).toEqual({ scope: "channel", root: null, replies: [], replyCount: 0 });
    }
  });
});

describe("createConversationApi", () => {
  it("unwraps and normalizes a channel page", async () => {
    const fetchChannel = vi.fn(async () =>
      ok({
        messages: [{ eventId: "e1", body: "hello", audience: "humans" }],
        nextCursor: " next ",
        view: "human",
        viewScanTruncated: true,
      }),
    );
    const api = createConversationApi(adapterWith({ fetchChannel }));
    const page = await api.fetchChannel({ channelId: "ch_1", limit: 5 });
    expect(fetchChannel).toHaveBeenCalledWith({ channelId: "ch_1", limit: 5 });
    expect(page.messages.map((m) => m.eventId)).toEqual(["e1"]);
    expect(page.messages[0]?.audience).toBe("humans");
    expect(page.nextCursor).toBe("next");
    expect(page.view).toBe("human");
    expect(page.viewScanTruncated).toBe(true);
  });

  it("leaves view fields off a plain DM page", async () => {
    const api = createConversationApi(
      adapterWith({ fetchDmThread: async () => ok([{ eventId: "d1" }]) }),
    );
    const page = await api.fetchDmThread({ withPersonUid: "p_1" });
    expect(page).toEqual({ messages: [expect.objectContaining({ eventId: "d1" })], nextCursor: null });
  });

  it("passes send arguments through to the adapter and throws on failure", async () => {
    const sendChannelMessage = vi.fn(async () => ok(undefined));
    const sendDm = vi.fn(async () => ({ ok: false as const, message: "blocked" }));
    const api = createConversationApi(adapterWith({ sendChannelMessage, sendDm }));
    await api.sendChannelMessage({ channelId: "c", body: "b", mentions: [], attachments: [] });
    expect(sendChannelMessage).toHaveBeenCalledWith("c", "b", { mentions: [], attachments: [] });
    await expect(api.sendDm({ toPersonUid: "p", body: "x" })).rejects.toThrow("blocked");
    expect(sendDm).toHaveBeenCalledWith("p", "x", { attachments: undefined });
  });

  it("only offers the optional calls the adapter has", () => {
    const bare = createConversationApi(adapterWith({}));
    expect(bare.listChannelAgentTasks).toBeUndefined();
    expect(bare.listAgentTasks).toBeUndefined();
    expect(bare.checkCompanySlug).toBeUndefined();
    expect(bare.activateCompanyCloud).toBeUndefined();
    expect(bare.getCompanyTab).toBeUndefined();
    expect(bare.runCompanyTabAction).toBeUndefined();

    const full = createConversationApi(
      adapterWith({
        listChannelAgentTasks: async () => ok([]),
        listAgentTasks: async () => ok([]),
        checkCompanySlug: async () => ok({ available: true }),
        activateCompanyCloud: async () => ok({}),
        getCompanyTab: async () => ok({}),
        runCompanyTabAction: async () => ok({}),
      }),
    );
    expect(full.listChannelAgentTasks).toBeTypeOf("function");
    expect(full.listAgentTasks).toBeTypeOf("function");
    expect(full.checkCompanySlug).toBeTypeOf("function");
    expect(full.activateCompanyCloud).toBeTypeOf("function");
    expect(full.getCompanyTab).toBeTypeOf("function");
    expect(full.runCompanyTabAction).toBeTypeOf("function");
  });

  it("maps a card action result, keeping the request ids when the server omits them", async () => {
    const api = createConversationApi(
      adapterWith({
        runCardAction: async () =>
          ok({ state: "done", replayed: true, agentChannelId: "ch_a", agentUid: 7, url: "https://x" }),
      }),
    );
    const result = await api.runCardAction({ cardId: "card", actionId: "act" } as never);
    expect(result).toMatchObject({
      cardId: "card",
      actionId: "act",
      state: "done",
      replayed: true,
      agentChannelId: "ch_a",
      agentUid: undefined,
      url: "https://x",
    });
  });

  it("maps a company tab action, keeping only a chat navigation", async () => {
    const run = (navigateTo: unknown) =>
      createConversationApi(
        adapterWith({ runCompanyTabAction: async () => ok({ navigateTo, cardId: "c2" }) }),
      ).runCompanyTabAction!({ cardId: "c1", actionId: "a1" } as never);
    expect(await run("chat")).toMatchObject({ cardId: "c2", actionId: "a1", navigateTo: "chat", state: "" });
    expect((await run("board")).navigateTo).toBeUndefined();
  });

  it("normalizes a reply thread from the adapter", async () => {
    const api = createConversationApi(
      adapterWith({
        fetchReplyThread: async () => ok({ scope: "channel", root: { eventId: "r" }, replies: [] }),
      }),
    );
    const thread = await api.fetchReplyThread({ rootEventId: "r" } as never);
    expect(thread.root?.eventId).toBe("r");
    expect(thread.replyCount).toBe(0);
  });
});
