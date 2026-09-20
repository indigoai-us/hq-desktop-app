import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import {
  botRowDisplayName,
  loadBotDisplayNames,
  rememberBotDisplayName,
  type BotDisplayNames,
} from "./bot-display-names.js";
import { localBotsAsContacts } from "./local-bots.js";

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => Object.fromEntries(map),
  };
}

function bot(partial: Partial<LocalBotRow> & { name: string; agentUid: string }): LocalBotRow {
  return {
    ownerUid: "prs_me",
    runtime: "claude",
    state: "running",
    pid: 1,
    processAlive: true,
    online: true,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/bot",
    ...partial,
  };
}

describe("bot display names", () => {
  it("falls back to the handle for a bot with no display name", () => {
    const row = bot({ name: "scout", agentUid: "agt_scout" });
    expect(botRowDisplayName(row, null)).toBe("scout");
    expect(botRowDisplayName(row, {})).toBe("scout");
    expect(botRowDisplayName(row, { agt_scout: "Scout Prime" })).toBe("Scout Prime");
    // A name reported by the CLI wins over the app's own copy.
    expect(botRowDisplayName({ ...row, displayName: "Scout" }, { agt_scout: "stale" })).toBe("Scout");
  });

  it("round-trips through storage and drops an emptied name", () => {
    const storage = fakeStorage();
    const saved = rememberBotDisplayName({}, "agt_love", "Dr Love", storage);
    expect(saved).toEqual({ agt_love: "Dr Love" });
    expect(loadBotDisplayNames(storage)).toEqual({ agt_love: "Dr Love" });
    expect(rememberBotDisplayName(saved, "agt_love", "  ", storage)).toEqual({});
    expect(loadBotDisplayNames(storage)).toEqual({});
  });

  it("survives a missing, unreadable or malformed record", () => {
    expect(loadBotDisplayNames(null)).toEqual({});
    expect(loadBotDisplayNames(fakeStorage({ "hq.bot-display-names.v1": "not json" }))).toEqual({});
    expect(loadBotDisplayNames(fakeStorage({ "hq.bot-display-names.v1": "[1,2]" }))).toEqual({});
    expect(
      loadBotDisplayNames(fakeStorage({ "hq.bot-display-names.v1": '{"agt_a":"A","agt_b":7,"":"x"}' })),
    ).toEqual({ agt_a: "A" });
  });

  it("labels DM roster rows with the display name, else the handle", () => {
    const bots = [bot({ name: "dr-love", agentUid: "agt_love" }), bot({ name: "scout", agentUid: "agt_scout" })];
    const names: BotDisplayNames = { agt_love: "Dr Love" };
    const rows = localBotsAsContacts([], bots, names) as Array<{ personUid: string; displayName: string }>;
    expect(rows.map((r) => r.displayName)).toEqual(["Dr Love", "scout"]);
  });
});
