import { describe, expect, it } from "vitest";
import type { Objective } from "../projects/local-projects.js";
import type { Project } from "../projects/projects-model.js";
import {
  goalGlyph,
  krProgress,
  matchesPeriod,
  metadata,
  objectiveProgress,
  unlinkedProjects,
} from "./goals-model.js";

const objective: Objective = {
  id: "o1",
  title: "Desktop",
  description: "",
  status: "on_track",
  timeframe: "2026",
  owner: "Corey",
  keyResults: [
    { id: "k1", title: "Stories", current: 1, target: 9, unit: "stories" },
    { id: "k2", title: "Crash free", current: 50, target: 100, unit: "%" },
  ],
  initiativeIds: [],
};

describe("goals model", () => {
  it("averages measurable key results and maps status glyphs", () => {
    expect(krProgress(objective.keyResults[0]!)).toBe(11);
    expect(objectiveProgress(objective)).toBe(31);
    expect(goalGlyph("at_risk").mark).toBe("◐");
    expect(goalGlyph("on_track").label).toBe("on track");
    expect(goalGlyph("").label).toBe("not started");
  });

  it("filters timeframes and lists projects that are not linked", () => {
    expect(matchesPeriod("H2 2026", "H2")).toBe(true);
    expect(matchesPeriod("2026", "H2")).toBe(false);
    expect(matchesPeriod("2026", "2026")).toBe(true);
    const projects = [
      { id: "p1", company: "indigo", description: "", status: "active", prdPath: "", storiesTotal: 0, storiesComplete: 0 },
      { id: "p2", company: "indigo", description: "", status: "active", prdPath: "", storiesTotal: 0, storiesComplete: 0 },
    ] as Project[];
    expect(unlinkedProjects(projects, [{ objectiveId: "o1", krKey: "k1", projectId: "p1", projectName: "one" }]).map((p) => p.id)).toEqual(["p2"]);
  });

  it("keeps the list scroll budget", () => {
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBeLessThanOrEqual(0.01);
  });
});
