import { describe, expect, it } from "vitest";
import { ATLAS_DOT_CAP, atlasCapDots } from "./atlas-layout.js";

const dots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, r: (i % 50) + 1 }));

describe("atlasCapDots", () => {
  it("draws every dot at or under the cap", () => {
    const placed = dots(ATLAS_DOT_CAP);
    expect(atlasCapDots(placed)).toBe(placed);
  });

  it("never draws more than the cap", () => {
    expect(atlasCapDots(dots(5000))).toHaveLength(ATLAS_DOT_CAP);
  });

  it("keeps the largest dots and the input order", () => {
    const placed = [
      { id: "a", r: 1 },
      { id: "b", r: 9 },
      { id: "c", r: 5 },
      { id: "d", r: 2 },
    ];
    expect(atlasCapDots(placed, [], 2).map((n) => n.id)).toEqual(["b", "c"]);
  });

  it("keeps pinned dots (selected, hovered, live) even when small", () => {
    const placed = [
      { id: "a", r: 1 },
      { id: "b", r: 9 },
      { id: "c", r: 5 },
      { id: "d", r: 2 },
    ];
    expect(atlasCapDots(placed, ["a", null, undefined], 2).map((n) => n.id)).toEqual(["a", "b"]);
  });
});
