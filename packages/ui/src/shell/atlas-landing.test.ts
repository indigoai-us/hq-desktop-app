import { describe, expect, it } from "vitest";
import type { PresenceEntry } from "@hq/core";

import { atlasRoster, atlasWorkingNow, rosterNamesFromRows } from "./atlas-landing.js";

function entry(status: "online" | "offline", actorType: "human" | "agent" = "human"): PresenceEntry {
  return { status, actorType, at: "2026-10-01T00:00:00.000Z" };
}

describe("Atlas landing roster (US-009)", () => {
  const snapshot = new Map([
    [
      "co_a",
      new Map([
        ["u_zed", entry("online")],
        ["u_amy", entry("offline")],
        ["b_scout", entry("online", "agent")],
        ["u_self", entry("online")],
      ]),
    ],
    ["co_b", new Map([["u_other", entry("online")]])],
  ]);
  const names = rosterNamesFromRows([
    { personUid: "u_zed", title: "Zed" },
    { personUid: "u_amy", title: "Amy" },
    { personUid: "b_scout", title: "Scout" },
    { personUid: "u_zed", title: "Zed duplicate" },
    { title: "#general" },
  ]);

  it("keeps the first name per person and skips channel rows", () => {
    expect([...names]).toEqual([
      ["u_zed", "Zed"],
      ["u_amy", "Amy"],
      ["b_scout", "Scout"],
    ]);
  });

  it("builds a sorted company roster with bots marked and no other company's people", () => {
    const roster = atlasRoster(snapshot, "co_a", names, "u_self");
    expect(roster).toEqual([
      { uid: "u_amy", name: "Amy", kind: "human", live: false },
      { uid: "b_scout", name: "Scout", kind: "bot", live: true },
      { uid: "u_self", name: "You", kind: "human", live: true },
      { uid: "u_zed", name: "Zed", kind: "human", live: true },
    ]);
    expect(atlasRoster(snapshot, "co_missing", names)).toEqual([]);
  });

  it("lists only live people under Working now", () => {
    const working = atlasWorkingNow(atlasRoster(snapshot, "co_a", names, "u_self"));
    expect(working.map((w) => [w.name, w.bot, w.nodeId])).toEqual([
      ["Scout", true, "person:b_scout"],
      ["You", false, "person:u_self"],
      ["Zed", false, "person:u_zed"],
    ]);
  });
});
