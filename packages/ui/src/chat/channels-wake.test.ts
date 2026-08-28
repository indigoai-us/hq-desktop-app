import { describe, expect, it } from "vitest";

import {
  applyChannelMessageWake,
  mergeDirectoryUnread,
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
