import { describe, expect, it } from "vitest";
import { atlasFocusOrbit, atlasFocusPlaced } from "./atlas-focus.js";
import type { AtlasPlaced } from "./atlas-layout.js";

const at = (id: string, type: AtlasPlaced["type"], x: number, y: number, r = 3): AtlasPlaced => ({
  id,
  type,
  label: id,
  path: id,
  folder: false,
  count: 1,
  x,
  y,
  r,
});

describe("focus mode orbit", () => {
  const center = at("p", "project", 100, 100, 8);

  it("gathers repos, knowledge and policies around a project, repos first, none overlapping", () => {
    const related = [
      at("policy-a", "policy", 900, 0),
      at("know-b", "knowledge", -400, 300),
      at("repo-c", "repo", 50, -600),
      at("worker-d", "worker", 0, 0),
    ];
    const orbit = atlasFocusOrbit(center, related);
    expect([...orbit.keys()]).toEqual(["repo-c", "know-b", "policy-a"]);
    const spots = [...orbit.values()];
    for (const s of spots) {
      const d = Math.hypot(s.x - center.x, s.y - center.y);
      expect(d).toBeGreaterThan(center.r + 3);
      expect(d).toBeLessThan(60);
    }
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++)
        expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y)).toBeGreaterThan(6);
    // The first one sits straight above the project; offsets lead from home to target.
    const repo = orbit.get("repo-c")!;
    expect(repo.x).toBeCloseTo(100);
    expect(repo.y).toBeLessThan(100);
    expect(repo.dx).toBeCloseTo(repo.x - 50);
    expect(repo.dy).toBeCloseTo(repo.y + 600);
  });

  it("adds outer rings when the first is full", () => {
    const many = Array.from({ length: 40 }, (_, i) => at(`k${String(i).padStart(2, "0")}`, "knowledge", i, i));
    const orbit = atlasFocusOrbit(center, many);
    expect(orbit.size).toBe(40);
    const radii = new Set([...orbit.values()].map((s) => Math.round(Math.hypot(s.x - center.x, s.y - center.y))));
    expect(radii.size).toBeGreaterThan(1);
  });

  it("does nothing for a non-project or with nothing to gather", () => {
    expect(atlasFocusOrbit(at("r", "repo", 0, 0), [at("k", "knowledge", 5, 5)]).size).toBe(0);
    expect(atlasFocusOrbit(center, [at("w", "worker", 5, 5)]).size).toBe(0);
    expect(atlasFocusOrbit(null, []).size).toBe(0);
  });

  it("moves only gathered objects, and clearing the focus restores every home position", () => {
    const placed = [center, at("repo-c", "repo", 50, -600), at("skill", "skill", 7, 7)];
    const orbit = atlasFocusOrbit(center, placed);
    const moved = atlasFocusPlaced(placed, orbit);
    expect(moved.find((n) => n.id === "repo-c")!.y).not.toBe(-600);
    expect(moved.find((n) => n.id === "skill")).toBe(placed[2]);
    expect(atlasFocusPlaced(placed, null)).toEqual(placed);
    expect(atlasFocusPlaced(placed, new Map())).toBe(placed);
  });
});
