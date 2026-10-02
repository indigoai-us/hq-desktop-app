/**
 * The thinking rows follow the bots that are answering right now, and the
 * bot's reply ends its row the moment it lands, even while the polled `busy`
 * flag for that turn is still set.
 */
import { describe, expect, it } from "vitest";
import {
  applyAgentStatus,
  clearRowOnReply,
  forgetAnswered,
  releaseAnswered,
  startThinkingIn,
  syncBusyThinking,
  visibleThinking,
  type AnsweredWhileBusy,
  type ThinkingByRow,
} from "./agent-thinking.js";

const nameOf = (uid: string) => `bot-${uid}`;

describe("syncBusyThinking", () => {
  it("starts a row in the bot's own DM when it begins answering", () => {
    const next = syncBusyThinking({}, { busy: ["a"], previouslyBusy: [], nameOf, now: 1_000 });
    expect(next["dm:a"]?.[0]).toMatchObject({ agentUid: "a", agentName: "bot-a", phase: "thinking" });
  });

  it("leaves an existing row alone while the bot is still working", () => {
    const map: ThinkingByRow = startThinkingIn({}, "dm:a", { agentUid: "a", agentName: "bot-a" }, 1_000);
    const next = syncBusyThinking(map, { busy: ["a"], previouslyBusy: ["a"], nameOf, now: 9_000 });
    expect(next).toBe(map);
    expect(next["dm:a"]?.[0]?.startedAt).toBe(1_000);
  });

  it("clears the row when the turn ends", () => {
    const map: ThinkingByRow = startThinkingIn({}, "dm:a", { agentUid: "a", agentName: "bot-a" }, 1_000);
    const next = syncBusyThinking(map, { busy: [], previouslyBusy: ["a"], nameOf, now: 9_000 });
    expect(next["dm:a"]).toBeUndefined();
  });

  it("does not touch another bot's row", () => {
    const map: ThinkingByRow = startThinkingIn({}, "dm:b", { agentUid: "b", agentName: "bot-b" }, 1_000);
    const next = syncBusyThinking(map, { busy: ["a"], previouslyBusy: ["a"], nameOf, now: 2_000 });
    expect(next["dm:b"]?.[0]?.agentUid).toBe("b");
  });
});

describe("a bot's reply ends its row at once", () => {
  const T0 = Date.parse("2026-09-27T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const earlier = { fromPersonUid: "a", createdAt: iso(T0 - 60_000) };
  const reply = { fromPersonUid: "a", createdAt: iso(T0 + 20_000) };
  const suggestions = { fromPersonUid: "a", createdAt: iso(T0 + 21_000) };

  /** The person wrote at T0; the row is pinned to the bot's previous reply. */
  function afterSend(): ThinkingByRow {
    return startThinkingIn({}, "dm:a", { agentUid: "a", agentName: "Banjo" }, T0, {
      afterMs: Date.parse(earlier.createdAt),
    });
  }

  it("hides the indicator when the reply arrives, while busy is still set", () => {
    const map = afterSend();
    // Same render as the reply: the visible rows already exclude it.
    expect(visibleThinking(map["dm:a"]!, [earlier, reply])).toEqual([]);
    // And the reply page clears the row outright, busy notwithstanding.
    const next = clearRowOnReply(map, {}, "dm:a", [reply], ["a"]);
    expect(next.map["dm:a"]).toBeUndefined();
    expect(next.answered).toEqual({ a: true });
  });

  it("keeps the indicator while the bot has not replied", () => {
    const map = afterSend();
    expect(visibleThinking(map["dm:a"]!, [earlier])).toBe(map["dm:a"]);
    const next = clearRowOnReply(map, {}, "dm:a", [earlier], ["a"]);
    expect(next.map["dm:a"]).toHaveLength(1);
    expect(next.answered).toEqual({});
  });

  it("does not bring the row back from a stale busy poll after the reply", () => {
    const cleared = clearRowOnReply(afterSend(), {}, "dm:a", [reply], ["a"]);
    const answered = releaseAnswered(cleared.answered, ["a"]);
    const next = syncBusyThinking(cleared.map, {
      busy: ["a"],
      previouslyBusy: ["a"],
      nameOf,
      now: T0 + 26_000,
      answered,
    });
    expect(next["dm:a"]).toBeUndefined();
  });

  it("does not bring the row back from a status older than the reply", () => {
    const cleared = clearRowOnReply(afterSend(), {}, "dm:a", [reply], ["a"]);
    const stale = applyAgentStatus(
      cleared.map["dm:a"] ?? [],
      { channelId: "c", agentUid: "a", status: "is working on it", ts: iso(T0 + 15_000) },
      "Banjo",
      [earlier, reply],
      T0 + 22_000,
    );
    expect(stale).toEqual([]);
  });

  it("does not flicker back on between the reply and its follow-up message", () => {
    let { map, answered } = clearRowOnReply(afterSend(), {}, "dm:a", [reply], ["a"]);
    // A busy poll lands between the text and the suggestions.
    answered = releaseAnswered(answered, ["a"]);
    map = syncBusyThinking(map, { busy: ["a"], previouslyBusy: ["a"], nameOf, now: T0 + 20_500, answered });
    expect(map["dm:a"]).toBeUndefined();
    ({ map, answered } = clearRowOnReply(map, answered, "dm:a", [suggestions], ["a"]));
    map = syncBusyThinking(map, { busy: ["a"], previouslyBusy: ["a"], nameOf, now: T0 + 27_000, answered });
    expect(map["dm:a"]).toBeUndefined();
  });

  it("shows the row again when the bot reports a status newer than its reply", () => {
    const cleared = clearRowOnReply(afterSend(), {}, "dm:a", [reply], ["a"]);
    const next = applyAgentStatus(
      cleared.map["dm:a"] ?? [],
      { channelId: "c", agentUid: "a", status: "is still working", ts: iso(T0 + 25_000) },
      "Banjo",
      [earlier, reply],
      T0 + 25_000,
    );
    expect(next[0]).toMatchObject({ agentUid: "a", afterMs: T0 + 25_000 });
  });

  it("shows the row again after the person writes and the bot works again", () => {
    let { map, answered } = clearRowOnReply(afterSend(), {}, "dm:a", [reply], ["a"]);
    // The person sends another message: an explicit start, pinned past the reply.
    answered = forgetAnswered(answered, "a");
    map = startThinkingIn(map, "dm:a", { agentUid: "a", agentName: "Banjo" }, T0 + 40_000, {
      afterMs: Date.parse(suggestions.createdAt),
    });
    expect(visibleThinking(map["dm:a"]!, [earlier, reply, suggestions])).toHaveLength(1);
    // The next busy poll (a working signal for the new turn) keeps it up.
    const polled = syncBusyThinking(map, { busy: ["a"], previouslyBusy: ["a"], nameOf, now: T0 + 46_000, answered });
    expect(polled["dm:a"]).toHaveLength(1);
  });

  it("shows the row for a new turn once busy has dropped and risen again", () => {
    const cleared = clearRowOnReply(afterSend(), {}, "dm:a", [reply], ["a"]);
    let answered: AnsweredWhileBusy = releaseAnswered(cleared.answered, []);
    expect(answered).toEqual({});
    let map = syncBusyThinking(cleared.map, { busy: [], previouslyBusy: ["a"], nameOf, now: T0 + 30_000, answered });
    answered = releaseAnswered(answered, ["a"]);
    map = syncBusyThinking(map, { busy: ["a"], previouslyBusy: [], nameOf, now: T0 + 60_000, answered });
    expect(map["dm:a"]?.[0]).toMatchObject({ agentUid: "a", startedAt: T0 + 60_000 });
  });

  it("does not mark a bot that was not busy, or a row that is not its own DM", () => {
    const idle = clearRowOnReply(afterSend(), {}, "dm:a", [reply], []);
    expect(idle.map["dm:a"]).toBeUndefined();
    expect(idle.answered).toEqual({});
    const channel = startThinkingIn({}, "ch:c", { agentUid: "a", agentName: "Banjo" }, T0, {
      afterMs: Date.parse(earlier.createdAt),
    });
    const inChannel = clearRowOnReply(channel, {}, "ch:c", [reply], ["a"]);
    expect(inChannel.map["ch:c"]).toBeUndefined();
    expect(inChannel.answered).toEqual({});
  });
});
