import { describe, expect, it } from "vitest";
import type { PresenceEntry } from "@hq/core";

import { atlasLiveActors, atlasRoster, atlasWorkingNow, rosterNamesFromRows } from "./atlas-landing.js";

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

describe("atlasLiveActors (US-013)", () => {
  const live = {
    participants: [
      {
        actorUid: "b_scout",
        actorType: "agent",
        displayName: "scout",
        presence: "online",
        sessions: [
          { projectId: "Billing-V2", taskId: "US-7", status: "active" },
          { projectId: "billing-v2", status: "open" },
          { projectId: "old", status: "ended" },
        ],
      },
      { actorUid: "u_amy", actorType: "human", displayName: "Amy", presence: "online", sessions: [] },
      { actorUid: "u_off", actorType: "human", displayName: "Off", presence: "online", sessions: [{ projectId: "x", status: "open" }] },
      { actorUid: "u_gone", actorType: "human", displayName: "Gone", presence: "offline", sessions: [] },
    ],
  };
  const snapshot = new Map([
    ["co_a", new Map([["u_off", { status: "offline" as const, actorType: "human" as const, at: "" }]])],
  ]);

  it("keeps online actors, one row per open project, PresenceStore wins", () => {
    const actors = atlasLiveActors(live, snapshot, "co_a", new Map([["u_amy", "Amy B"]]));
    expect(actors).toEqual([
      // Online with no session in progress: kept, but marked so Working now can set it apart.
      { actorUid: "u_amy", name: "Amy B", bot: false, idle: true },
      { actorUid: "b_scout", name: "scout", bot: true, projectId: "billing-v2", signal: "US-7" },
    ]);
  });

  it("marks an actor idle when every session is idle or ended", () => {
    const quiet = {
      participants: [
        { actorUid: "b_nap", actorType: "agent", displayName: "nap", presence: "online", sessions: [{ projectId: "p", status: "idle" }, { status: "ended" }] },
      ],
    };
    expect(atlasLiveActors(quiet, new Map(), "co_a", new Map())).toEqual([
      { actorUid: "b_nap", name: "nap", bot: true, projectId: "p", signal: undefined, idle: true },
    ]);
  });

  it("returns nothing without a live read", () => {
    expect(atlasLiveActors(undefined, snapshot, "co_a", new Map())).toEqual([]);
  });
});
