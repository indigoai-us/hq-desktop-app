import { describe, expect, it } from "vitest";

import { smokeAtlasGraph } from "./atlas-model.js";
import { layoutAtlas } from "./atlas-layout.js";
import {
  atlasActorNodeIds,
  atlasDistinctActors,
  atlasDockedChips,
  atlasInitials,
  atlasPresenceFromActors,
  atlasProjectSlug,
} from "./atlas-presence.js";

const graph = smokeAtlasGraph();
const rail = "project:projects/hq-desktop-console-rail/";

describe("atlas presence (US-013)", () => {
  it("maps a project session onto the project node, others keep a person id", () => {
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
      { nodeId: "person:u_corey", actorUid: "u_corey", name: "Corey L", bot: false, signal: undefined },
    ]);
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
});
