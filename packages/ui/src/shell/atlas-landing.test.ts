import { describe, expect, it } from "vitest";
import type { PresenceEntry } from "@hq/core";

import { atlasLiveActors, atlasRoster, atlasWorkingNow, rosterNamesFromRows,
  atlasNodeDestination,
} from "./atlas-landing.js";

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
  // Bots with no photo get the app's generated bot avatar, as in Messages.
  const botPicture = expect.stringContaining("agent-avatars");
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
      { actorUid: "b_scout", name: "scout", bot: true, avatarUrl: botPicture, projectId: "billing-v2", signal: "US-7" },
    ]);
  });

  it("marks an actor idle when every session is idle or ended", () => {
    const quiet = {
      participants: [
        { actorUid: "b_nap", actorType: "agent", displayName: "nap", presence: "online", sessions: [{ projectId: "p", status: "idle" }, { status: "ended" }] },
      ],
    };
    expect(atlasLiveActors(quiet, new Map(), "co_a", new Map())).toEqual([
      { actorUid: "b_nap", name: "nap", bot: true, avatarUrl: botPicture, projectId: "p", signal: undefined, idle: true },
    ]);
  });

  it("carries the app's profile and bot pictures, keyed by actor uid", () => {
    const pics = {
      participants: [
        { actorUid: "u_pic", actorType: "human", displayName: "Pia", presence: "online", sessions: [{ projectId: "p", status: "active" }] },
        { actorUid: "u_none", actorType: "human", displayName: "Ned", presence: "online", sessions: [{ projectId: "p", status: "active" }] },
        { actorUid: "b_pic", actorType: "agent", displayName: "Bo", presence: "online", sessions: [{ projectId: "p", status: "active" }] },
        { actorUid: "u_web", actorType: "human", displayName: "Wes", presence: "online", sessions: [{ projectId: "p", status: "active" }] },
      ],
    };
    const avatars = {
      u_pic: "data:image/png;base64,AAAA",
      b_pic: "data:image/png;base64,BBBB",
      // Not paintable under the app's CSP: dropped, initials instead.
      u_web: "https://example.com/wes.png",
    };
    const byUid = new Map(atlasLiveActors(pics, new Map(), "co_a", new Map(), null, avatars).map((a) => [a.actorUid, a]));
    expect(byUid.get("u_pic")?.avatarUrl).toBe("data:image/png;base64,AAAA");
    expect(byUid.get("b_pic")?.avatarUrl).toBe("data:image/png;base64,BBBB");
    expect(byUid.get("u_none")).not.toHaveProperty("avatarUrl");
    expect(byUid.get("u_web")).not.toHaveProperty("avatarUrl");
  });

  it("returns nothing without a live read", () => {
    expect(atlasLiveActors(undefined, snapshot, "co_a", new Map())).toEqual([]);
  });

  it("keeps where a session with no project runs: repo, cwd, worker, task", () => {
    const away = {
      participants: [
        {
          actorUid: "b_box",
          actorType: "agent",
          displayName: "box",
          presence: "online",
          sessions: [
            { repo: "hq-pro", taskId: "US-2", status: "active" },
            { cwd: "/srv/work/hq-console/", status: "open" },
            { cwd: "/srv/work/hq-console/", status: "open" },
            { workerId: "reviewer", status: "ended" },
          ],
        },
        { actorUid: "b_bare", actorType: "agent", displayName: "bare", presence: "online", sessions: [{ status: "active" }] },
      ],
    };
    expect(atlasLiveActors(away, new Map(), "co_a", new Map())).toEqual([
      { actorUid: "b_bare", name: "bare", bot: true, avatarUrl: botPicture },
      { actorUid: "b_box", name: "box", bot: true, avatarUrl: botPicture, cwd: "/srv/work/hq-console/", signal: undefined },
      { actorUid: "b_box", name: "box", bot: true, avatarUrl: botPicture, repo: "hq-pro", taskId: "US-2", signal: "US-2" },
    ]);
  });
});

describe("atlasNodeDestination: Open files shows a file, not a tree", () => {
  it("opens a folder on its main file in the Files explorer", () => {
    const skill = { type: "skill", path: "skills/deploy/", folder: true, file: "skills/deploy/SKILL.md" };
    expect(atlasNodeDestination(skill, "indigo", "files")).toEqual({
      kind: "explorer",
      vault: "company:indigo",
      path: "companies/indigo/skills/deploy/SKILL.md",
    });
  });

  it("opens a project on its main file, and keeps Open board on the Tasks tab", () => {
    const project = { type: "project", path: "projects/billing-v2/", folder: true, file: "projects/billing-v2/README.md" };
    expect(atlasNodeDestination(project, "indigo", "files")).toEqual({
      kind: "explorer",
      vault: "company:indigo",
      path: "companies/indigo/projects/billing-v2/README.md",
    });
    expect(atlasNodeDestination(project, "indigo", "board", "co_indigo")).toEqual({
      kind: "extra",
      page: "company-page-projects",
      companyUid: "co_indigo",
      param: "project=billing-v2&tab=tasks",
    });
  });

  it("keeps Open board in the company pane, never the cross-company Projects view", () => {
    const board = atlasNodeDestination({ type: "knowledge", path: "knowledge/brand/", folder: true }, "indigo", "board", "co_indigo");
    expect(board).toEqual({ kind: "extra", page: "company-page-projects", companyUid: "co_indigo" });
  });

  it("falls back when a folder has no file to show", () => {
    expect(atlasNodeDestination({ type: "project", path: "projects/empty/", folder: true }, "indigo", "files")).toEqual({
      kind: "extra",
      page: "company-page-projects",
      companyUid: "indigo",
      param: "project=empty&tab=files",
    });
    expect(atlasNodeDestination({ type: "knowledge", path: "knowledge/brand/", folder: true }, "indigo", "files")).toEqual({
      kind: "explorer",
      vault: "company:indigo",
      path: null,
    });
  });
});
