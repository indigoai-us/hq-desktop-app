import { describe, expect, it } from "vitest";

import {
  buildMessageLink,
  buildShortMessageLink,
  parseMessageLink,
} from "./message-link";

describe("message link builder", () => {
  it("writes the long form for a channel message", () => {
    expect(
      buildMessageLink({
        companyUid: "cmp_1",
        conversationId: "chn_eng",
        eventId: "evt_9",
      }),
    ).toBe("https://work.hq.computer/conversation/cmp_1/chn_eng/message/evt_9");
  });

  it("writes the long form for a DM using the other person's uid", () => {
    expect(
      buildMessageLink({
        companyUid: "cmp_1",
        conversationId: "psn_ada",
        eventId: "evt_9",
      }),
    ).toBe("https://work.hq.computer/conversation/cmp_1/psn_ada/message/evt_9");
  });

  it("writes the short form without a company", () => {
    expect(
      buildShortMessageLink({ conversationId: "chn_eng", eventId: "evt_9" }),
    ).toBe("https://work.hq.computer/c/chn_eng/evt_9");
  });
});

describe("message link parser round trip", () => {
  it("reads back what the long form builder wrote", () => {
    const parts = { companyUid: "cmp_1", conversationId: "psn_ada", eventId: "evt_9" };
    expect(parseMessageLink(buildMessageLink(parts))).toEqual(parts);
  });

  it("reads the short form and both hq:// forms", () => {
    expect(parseMessageLink("https://work.hq.computer/c/chn_eng/evt_9")).toEqual({
      companyUid: null,
      conversationId: "chn_eng",
      eventId: "evt_9",
    });
    expect(parseMessageLink("hq://c/chn_eng/evt_9")?.eventId).toBe("evt_9");
    expect(
      parseMessageLink("hq://conversation/cmp_1/chn_eng/message/evt_9"),
    ).toEqual({ companyUid: "cmp_1", conversationId: "chn_eng", eventId: "evt_9" });
  });

  it("rejects other hosts and malformed paths", () => {
    expect(parseMessageLink("https://example.com/c/chn_eng/evt_9")).toBeNull();
    expect(parseMessageLink("https://work.hq.computer/c/chn_eng")).toBeNull();
    expect(parseMessageLink("not a url")).toBeNull();
  });
});
