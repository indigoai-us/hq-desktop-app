// @vitest-environment happy-dom
// OWNER-R11: Skills shows team usage beside your own, from the web's company
// telemetry read and /v1/telemetry/me, matching namespaced names, with each
// read failing on its own.
import { describe, expect, it } from "vitest";
import { lastRunCell, mySkillUsage, runsCell, skillUsageRows, teamSkillUsage } from "./skill-usage";

import { COMPANY, ME } from "./skill-usage.fixtures";
const LIB = [
  { name: "handoff", path: "a/handoff" },
  { name: "design-review", path: "a/design-review" },
  { name: "run-project", path: "a/run-project" },
];

describe("OWNER-R11 skill usage model", () => {
  it("joins team and personal runs by namespaced name and sorts by team runs", () => {
    const rows = skillUsageRows(LIB, teamSkillUsage(COMPANY), mySkillUsage(ME));
    expect(rows.map((r) => [r.name, r.teamRuns, r.yourRuns, r.people, r.lastDay])).toEqual([
      ["run-project", 7, 3, 2, "2026-10-01"],
      ["design-review", 1, 0, 1, "2026-10-02"],
      ["handoff", 0, 1, 0, ""],
    ]);
    expect(runsCell(0)).toBe("—");
    expect(runsCell(null)).toBe("—");
    expect(lastRunCell("")).toBe("—");
    expect(lastRunCell("2026-10-02")).toBe("Oct 2");
  });

  it("keeps your runs when the team read is missing, and the reverse", () => {
    const noTeam = skillUsageRows(LIB, null, mySkillUsage(ME));
    expect(noTeam.find((r) => r.name === "run-project")).toMatchObject({ teamRuns: null, yourRuns: 3 });
    const noMine = skillUsageRows(LIB, teamSkillUsage(COMPANY), null);
    expect(noMine.find((r) => r.name === "run-project")).toMatchObject({ teamRuns: 7, yourRuns: null });
    expect(() => teamSkillUsage({})).toThrow();
    expect(() => mySkillUsage({})).toThrow();
  });

});
