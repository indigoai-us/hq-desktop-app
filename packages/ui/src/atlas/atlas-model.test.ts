import { describe, expect, it } from "vitest";
import {
  ATLAS_EMPTY_LIVE,
  ATLAS_MIXED_LIVE,
  ATLAS_ONE_ACTOR_LIVE,
  atlasCanMigrateSessions,
  buildAtlasView,
} from "./atlas-model.js";

describe("buildAtlasView", () => {
  it("renders an empty company with no project cards", () => {
    const view = buildAtlasView({ live: ATLAS_EMPTY_LIVE });
    expect(view.empty).toBe(true);
    expect(view.projects).toEqual([]);
    expect(view.unassigned).toEqual([]);
    expect(view.onlineCount).toBe(0);
    expect(view.offlineCount).toBe(0);
  });

  it("shows one live actor on their project with task and harness", () => {
    const view = buildAtlasView({ live: ATLAS_ONE_ACTOR_LIVE });
    expect(view.empty).toBe(false);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0]?.projectId).toBe("work-mesh-live");
    expect(view.projects[0]?.onlineActors).toEqual([
      expect.objectContaining({
        actorUid: "prs_corey",
        displayName: "Corey",
        taskId: "US-016",
        harness: "claude-code",
        actorType: "human",
      }),
    ]);
    expect(view.offlineCount).toBe(0);
  });

  it("groups mixed humans and agents across projects and collapses offline", () => {
    const view = buildAtlasView({ live: ATLAS_MIXED_LIVE });
    expect(view.projects.map((p) => p.projectId).sort()).toEqual([
      "hq-desktop",
      "work-mesh-live",
    ]);
    const mesh = view.projects.find((p) => p.projectId === "work-mesh-live");
    expect(mesh?.onlineActors.map((a) => a.actorUid).sort()).toEqual([
      "agt_ralph",
      "prs_corey",
    ]);
    expect(mesh?.onlineActors.some((a) => a.actorType === "agent")).toBe(true);
    expect(
      view.projects.find((p) => p.projectId === "hq-desktop")?.onlineActors,
    ).toEqual([
      expect.objectContaining({ actorUid: "prs_stefan", harness: "codex" }),
    ]);
    expect(view.offlineCount).toBe(1);
    expect(view.unassigned).toEqual([
      expect.objectContaining({
        actorUid: "prs_unassigned",
        harness: "hq-sessions",
      }),
    ]);
  });

  it("gates Move on company owner/admin plus at least one destination", () => {
    expect(
      atlasCanMigrateSessions({
        companyUid: "cmp_indigo",
        companies: [
          { slug: "indigo", cloudUid: "cmp_indigo", role: "admin" },
          { slug: "acme", cloudUid: "cmp_acme", role: "member" },
        ],
      }),
    ).toBe(true);
    expect(
      atlasCanMigrateSessions({
        companyUid: "cmp_indigo",
        companies: [
          { slug: "indigo", cloudUid: "cmp_indigo", role: "member" },
          { slug: "acme", cloudUid: "cmp_acme", role: "admin" },
        ],
      }),
    ).toBe(false);
    expect(
      atlasCanMigrateSessions({
        companyUid: "cmp_indigo",
        companies: [
          { slug: "indigo", cloudUid: "cmp_indigo", role: "admin" },
        ],
        destinations: [],
      }),
    ).toBe(false);
  });

  it("removes a stopped actor from online when the store reports offline (not timestamps)", () => {
    const presenceByActor = new Map<"prs_stefan" | string, "online" | "offline">([
      ["prs_stefan", "offline"],
    ]);
    const view = buildAtlasView({
      live: ATLAS_MIXED_LIVE,
      presenceByActor,
    });
    const desktop = view.projects.find((p) => p.projectId === "hq-desktop");
    expect(desktop?.onlineActors ?? []).toEqual([]);
    expect(desktop?.offlineCount).toBe(1);
    expect(view.onlineCount).toBe(3); // corey, ralph, unassigned — stefan offline
    expect(
      view.projects
        .flatMap((p) => p.onlineActors)
        .some((a) => a.actorUid === "prs_stefan"),
    ).toBe(false);
  });

  it("does not invent online status from lastSeenAt alone", () => {
    const staleOnlineShape = {
      ...ATLAS_ONE_ACTOR_LIVE,
      participants: [
        {
          ...ATLAS_ONE_ACTOR_LIVE.participants[0]!,
          presence: "offline" as const,
          lastSeenAt: new Date().toISOString(),
        },
      ],
    };
    const view = buildAtlasView({ live: staleOnlineShape });
    expect(view.projects[0]?.onlineActors ?? []).toEqual([]);
    expect(view.offlineCount).toBe(1);
  });

  it("hides Unassigned when includeUnassigned is false", () => {
    const view = buildAtlasView({
      live: ATLAS_MIXED_LIVE,
      includeUnassigned: false,
    });
    expect(view.unassigned).toEqual([]);
  });
});
