/**
 * The thinking rows follow the bots that are answering right now, so a bot
 * that posts an interim note mid-turn keeps its indicator.
 */
import { describe, expect, it } from "vitest";
import { startThinkingIn, syncBusyThinking, type ThinkingByRow } from "./agent-thinking.js";

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
