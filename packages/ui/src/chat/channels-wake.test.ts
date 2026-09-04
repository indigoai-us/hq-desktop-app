import { describe, expect, it } from "vitest";

import {
  applyChannelMessageWake,
  mergeDirectoryUnread,
  removeChannel,
  shouldBumpChannelUnread,
  type Channel,
} from "./channels.js";

function ch(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: "chn_x",
    name: "general",
    scope: "company",
    unread: 0,
    lastMessageAt: "2026-08-17T01:00:00.000Z",
    lastActivityAt: "2026-08-17T01:00:00.000Z",
    ...overrides,
  };
}

describe("applyChannelMessageWake", () => {
  it("patches only the matching row and leaves other rows identical", () => {
    const other = ch({ channelId: "chn_other", name: "other" });
    const target = ch();
    const list = [other, target];
    const next = applyChannelMessageWake(list, {
      channelId: "chn_x",
      createdAt: "2026-08-17T02:00:00.000Z",
      unreadDelta: 1,
    });
    expect(next).not.toBe(list);
    expect(next[0]).toBe(other);
    expect(next[1]).toEqual(
      expect.objectContaining({
        channelId: "chn_x",
        unread: 1,
        lastMessageAt: "2026-08-17T02:00:00.000Z",
        lastActivityAt: "2026-08-17T02:00:00.000Z",
      }),
    );
  });

  it("is a no-op when the channel is not in the cache", () => {
    const list = [ch()];
    expect(
      applyChannelMessageWake(list, {
        channelId: "chn_missing",
        unreadDelta: 1,
      }),
    ).toBe(list);
  });

  it("advances the activity stamp without bumping unread", () => {
    const list = [ch({ unread: 0 })];
    const next = applyChannelMessageWake(list, {
      channelId: "chn_x",
      createdAt: "2026-09-02T03:19:00.000Z",
    });
    expect(next[0]).toEqual(
      expect.objectContaining({
        unread: 0,
        lastMessageAt: "2026-09-02T03:19:00.000Z",
        lastActivityAt: "2026-09-02T03:19:00.000Z",
      }),
    );
  });
});

describe("shouldBumpChannelUnread", () => {
  it("bumps when another conversation is selected", () => {
    expect(
      shouldBumpChannelUnread({
        selectedId: "dm:agt_deacon",
        channelId: "chn_x",
        fromPersonUid: "agt_deacon",
        selfUid: "prs_stefan",
      }),
    ).toBe(true);
  });

  it("does not bump the open channel or the caller's own message", () => {
    expect(
      shouldBumpChannelUnread({
        selectedId: "ch:chn_x",
        channelId: "chn_x",
      }),
    ).toBe(false);
    expect(
      shouldBumpChannelUnread({
        selectedId: "dm:agt_deacon",
        channelId: "chn_x",
        fromPersonUid: "prs_stefan",
        selfUid: "prs_stefan",
      }),
    ).toBe(false);
  });
});

describe("mergeDirectoryUnread", () => {
  it("keeps a newer local bump when the snapshot omits unread or is older", () => {
    expect(
      mergeDirectoryUnread({
        incomingUnread: null,
        prevUnread: 2,
        prevActivityAt: "2026-08-22T12:00:00.000Z",
      }),
    ).toBe(2);
    expect(
      mergeDirectoryUnread({
        incomingUnread: 0,
        incomingActivityAt: "2026-08-22T11:00:00.000Z",
        prevUnread: 1,
        prevActivityAt: "2026-08-22T12:00:00.000Z",
      }),
    ).toBe(1);
  });

  it("trusts a same-or-newer directory unread", () => {
    expect(
      mergeDirectoryUnread({
        incomingUnread: 0,
        incomingActivityAt: "2026-08-22T12:00:00.000Z",
        prevUnread: 1,
        prevActivityAt: "2026-08-22T11:00:00.000Z",
      }),
    ).toBe(0);
  });
});

describe("removeChannel", () => {
  it("drops the matching row and keeps the rest in order", () => {
    const a = ch({ channelId: "chn_a", name: "a" });
    const b = ch({ channelId: "chn_b", name: "b" });
    const c = ch({ channelId: "chn_c", name: "c" });
    const next = removeChannel([a, b, c], "chn_b");
    expect(next).toEqual([a, c]);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(c);
  });

  it("returns the same array when the id is unknown or blank", () => {
    const list = [ch({ channelId: "chn_a" })];
    expect(removeChannel(list, "chn_zzz")).toBe(list);
    expect(removeChannel(list, "")).toBe(list);
    expect(removeChannel(list, "   ")).toBe(list);
  });

  it("trims the id before matching", () => {
    const list = [ch({ channelId: "chn_a" }), ch({ channelId: "chn_b" })];
    expect(removeChannel(list, " chn_a ").map((c) => c.channelId)).toEqual([
      "chn_b",
    ]);
  });
});
