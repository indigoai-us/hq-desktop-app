import { describe, expect, it } from "vitest";

import { smokeAtlasGraph } from "./atlas-model.js";
import { layoutAtlas } from "./atlas-layout.js";
import {
  atlasActorNodeIds,
  atlasDistinctActors,
  atlasDockedChips,
  atlasInitials,
  atlasMatchKey,
  atlasPresenceFromActors,
  atlasProjectSlug,
  atlasUnplacedActors,
} from "./atlas-presence.js";

const graph = smokeAtlasGraph();
const rail = "project:projects/hq-desktop-console-rail/";

describe("atlas presence (US-013)", () => {
  it("maps a project session onto the project node; a second, unmatched session of a placed actor is not docked", () => {
    const presence = atlasPresenceFromActors(
      [
        { actorUid: "b_deacon", name: "deacon", bot: true, projectId: "HQ-Desktop-Console-Rail", signal: "US-013" },
        { actorUid: "u_corey", name: "Corey L", bot: false, projectId: "hq-desktop-console-rail" },
        { actorUid: "u_corey", name: "Corey L", bot: false, projectId: "not-on-map" },
      ],
      graph.nodes,
    );
    expect(presence).toEqual([
      { nodeId: rail, actorUid: "b_deacon", name: "deacon", bot: true, signal: "US-013" },
      { nodeId: rail, actorUid: "u_corey", name: "Corey L", bot: false, signal: undefined },
    ]);
    expect(atlasUnplacedActors(presence)).toEqual([]);
    expect(atlasDistinctActors(presence).map((p) => p.actorUid)).toEqual(["b_deacon", "u_corey"]);
    expect([...(atlasActorNodeIds(presence, "b_deacon") ?? [])]).toEqual([rail]);
    expect(atlasActorNodeIds(presence, null)).toBeNull();
  });

  it("derives project slugs only for project nodes", () => {
    expect(atlasProjectSlug({ type: "project", path: "projects/Billing-V2/" })).toBe("billing-v2");
    expect(atlasProjectSlug({ type: "repo", path: "repos/x/" })).toBeNull();
  });

  it("docks chips beside the node rim and stacks them", () => {
    const { placed } = layoutAtlas(graph.nodes);
    const node = placed.find((p) => p.id === rail)!;
    const chips = atlasDockedChips(placed, [
      { nodeId: rail, actorUid: "b", name: "deacon", bot: true },
      { nodeId: rail, actorUid: "u", name: "Corey Lyons", bot: false },
      { nodeId: "person:x", actorUid: "x", name: "Nowhere", bot: false },
    ]);
    expect(chips).toHaveLength(2);
    expect(chips[0].initials).toBe("⌁");
    expect(chips[1].initials).toBe("CL");
    expect(chips[1].x - chips[0].x).toBe(20);
    expect(Math.hypot(chips[0].x1 - node.x, chips[0].y1 - node.y)).toBeCloseTo(node.r);
    expect(atlasInitials("zed")).toBe("ZE");
  });

  it("places an actor with only a repo or a cwd on the matching repo or project node", () => {
    const presence = atlasPresenceFromActors(
      [
        { actorUid: "b_repo", name: "repo bot", bot: true, repo: "HQ_Desktop_App" },
        { actorUid: "b_cwd", name: "cwd bot", bot: true, cwd: "/Users/x/HQ/companies/indigo/projects/hq-desktop-console-rail/" },
        { actorUid: "b_worker", name: "worker bot", bot: true, workerId: "paper_designer" },
      ],
      graph.nodes,
    );
    expect(presence.map((p) => [p.actorUid, p.nodeId, p.unplaced])).toEqual([
      ["b_repo", "repo:repos/private/hq-desktop-app/", undefined],
      ["b_cwd", rail, undefined],
      ["b_worker", "worker:workers/paper-designer/", undefined],
    ]);
  });

  it("tries the project id before other hints, and project folders before repos", () => {
    const [p] = atlasPresenceFromActors(
      [{ actorUid: "b", name: "b", bot: true, projectId: "nowhere", repo: "hq-console" }],
      graph.nodes,
    );
    expect(p.nodeId).toBe("repo:repos/private/hq-console/");
  });

  it("normalises slugs on both sides", () => {
    expect(atlasMatchKey("  HQ_Desktop_App/ ")).toBe("hq-desktop-app");
    expect(atlasMatchKey("repos/private/hq-desktop-app/")).toBe("hq-desktop-app");
    expect(atlasMatchKey("/Users/a/b/Billing_V2//")).toBe("billing-v2");
    expect(atlasMatchKey("C:\\work\\Billing-V2")).toBe("billing-v2");
    expect(atlasMatchKey("")).toBe("");
    expect(atlasMatchKey(undefined)).toBe("");
  });

  it("docks unmatched actors (people first) with a plain reason, never on a node", () => {
    const presence = atlasPresenceFromActors(
      [
        { actorUid: "b_far", name: "far", bot: true, repo: "some-other-repo" },
        { actorUid: "b_none", name: "none", bot: true },
        { actorUid: "u_amy", name: "Amy", bot: false, idle: true },
      ],
      graph.nodes,
    );
    const away = atlasUnplacedActors(presence);
    expect(away.map((p) => [p.actorUid, p.unplaced])).toEqual([
      ["u_amy", "Online, no session in progress"],
      ["b_far", "Working in some-other-repo, which is not on this map"],
      ["b_none", "In a session with no project"],
    ]);
    const { placed } = layoutAtlas(graph.nodes);
    expect(atlasDockedChips(placed, presence)).toEqual([]);
  });

  it("loses no live actor: each one is on a node or in the dock", () => {
    const actors = Array.from({ length: 30 }, (_, i) => ({
      actorUid: `a${i}`,
      name: `Actor ${i}`,
      bot: i % 3 !== 0,
      ...(i % 2 ? { repo: i % 4 === 1 ? "hq-pro" : `elsewhere-${i}` } : {}),
    }));
    const presence = atlasPresenceFromActors(actors, graph.nodes);
    const { placed } = layoutAtlas(graph.nodes);
    const onMap = new Set(atlasDockedChips(placed, presence).map((c) => c.actorUid));
    const docked = new Set(atlasUnplacedActors(presence).map((p) => p.actorUid));
    for (const a of actors) {
      expect(onMap.has(a.actorUid) !== docked.has(a.actorUid)).toBe(true);
    }
    expect(onMap.size).toBeGreaterThan(0);
  });

  // Fixture of what the live read carries once the server sends a session's
  // repo and branch (it does not yet; see the PR).
  it("places a person with a repo but no project next to that repo, and says where they work", () => {
    const repo = "repo:repos/private/hq-desktop-app/";
    const presence = atlasPresenceFromActors(
      [
        { actorUid: "u_stefan", name: "Stefan Johnson", bot: false, repo: "indigoai-us/hq-desktop-app", branch: "corey/map" },
        { actorUid: "u_ada", name: "Ada", bot: false, projectId: "hq-desktop-console-rail", repo: "hq-desktop-app" },
        { actorUid: "u_zed", name: "Zed", bot: false },
      ],
      graph.nodes,
    );
    expect(presence.map((p) => [p.actorUid, p.nodeId, p.working, p.unplaced])).toEqual([
      ["u_stefan", repo, "Working in hq-desktop-app · corey/map", undefined],
      // Project placement wins; the repo rides along as a second line.
      ["u_ada", rail, "Working in hq-desktop-app", undefined],
      ["u_zed", "person:u_zed", undefined, "In a session with no project"],
    ]);
    expect(atlasUnplacedActors(presence).map((p) => p.actorUid)).toEqual(["u_zed"]);
    const { placed } = layoutAtlas(graph.nodes);
    const chip = atlasDockedChips(placed, presence).find((c) => c.actorUid === "u_stefan")!;
    expect(chip.nodeId).toBe(repo);
    expect(chip.working).toBe("Working in hq-desktop-app · corey/map");
  });
});
