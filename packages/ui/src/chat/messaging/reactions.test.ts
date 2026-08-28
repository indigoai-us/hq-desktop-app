import { describe, expect, it } from "vitest";

import {
  mergeReactionMaps,
  messageScopeForRow,
  reactionMapFromMessages,
  reactionsFromPayload,
  setMessageReactions,
  toggleIsAdd,
  toggleReaction,
} from "./reactions.js";

describe("messageScopeForRow", () => {
  it("uses dm:<uid> for pair DMs and chan:<id> for channels", () => {
    expect(messageScopeForRow({ kind: "dm", personUid: "prs_jacob" })).toBe(
      "dm:prs_jacob",
    );
    expect(messageScopeForRow({ kind: "channel", channelId: "ch_1" })).toBe(
      "chan:ch_1",
    );
    expect(messageScopeForRow({ kind: "dm" })).toBe("");
  });
});

describe("reactionsFromPayload", () => {
  it("unwraps the hq-pro envelope and a bare list", () => {
    expect(
      reactionsFromPayload({
        reactions: [
          { emoji: "👍", count: 2, reactedByMe: true },
          { emoji: " ", count: 1 },
        ],
      }),
    ).toEqual([{ emoji: "👍", count: 2, reactedByMe: true }]);
    expect(
      reactionsFromPayload([{ emoji: "🎉", reacted_by_me: true }]),
    ).toEqual([{ emoji: "🎉", count: 0, reactedByMe: true }]);
  });
});

describe("reactionMapFromMessages", () => {
  it("indexes cached aggregates by event id", () => {
    expect(
      reactionMapFromMessages([
        {
          eventId: "m1",
          reactions: [{ emoji: "👍", count: 1, reactedByMe: true }],
        },
        { eventId: "m2" },
      ]),
    ).toEqual({
      m1: [{ emoji: "👍", count: 1, reactedByMe: true }],
    });
  });
});

describe("toggleIsAdd", () => {
  it("POSTs when the caller has not reacted yet", () => {
    expect(toggleIsAdd(undefined, "👍")).toBe(true);
    expect(
      toggleIsAdd([{ emoji: "👍", count: 1, reactedByMe: true }], "👍"),
    ).toBe(false);
    expect(toggleReaction(undefined, "🎉")).toEqual([
      { emoji: "🎉", count: 1, reactedByMe: true },
    ]);
  });
});

describe("setMessageReactions / mergeReactionMaps", () => {
  it("lets an empty live list unreact past a cached aggregate", () => {
    const cached = {
      m1: [{ emoji: "👍", count: 1, reactedByMe: true }],
    };
    const live = setMessageReactions({}, "m1", []);
    expect(mergeReactionMaps(cached, live)).toEqual({ m1: [] });
  });
});

describe("reactionsFromPayload — reactor identities", () => {
  it("parses a reactors[] list when the server supplies it", () => {
    const out = reactionsFromPayload({
      reactions: [
        {
          emoji: "👍",
          count: 2,
          reactedByMe: true,
          reactors: [
            { personUid: "prs_a", displayName: "Ada" },
            { personUid: "prs_b", displayName: "Bo" },
          ],
        },
      ],
    });
    expect(out[0].reactors).toEqual([
      { personUid: "prs_a", displayName: "Ada" },
      { personUid: "prs_b", displayName: "Bo" },
    ]);
  });

  it("omits reactors when the server sends none (older builds)", () => {
    const out = reactionsFromPayload({
      reactions: [{ emoji: "🎉", count: 1, reactedByMe: false }],
    });
    expect(out[0].reactors).toBeUndefined();
  });

  it("falls back displayName to personUid when missing", () => {
    const out = reactionsFromPayload({
      reactions: [
        {
          emoji: "👍",
          count: 1,
          reactedByMe: false,
          reactors: [{ personUid: "prs_x" }],
        },
      ],
    });
    expect(out[0].reactors).toEqual([
      { personUid: "prs_x", displayName: "prs_x" },
    ]);
  });
});
