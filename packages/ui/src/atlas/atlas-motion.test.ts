// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATLAS_PULSE_CAP,
  ATLAS_TRAIL_CAP,
  ATLAS_TRAILS_PER_PROJECT,
  atlasMotionAllowed,
  atlasPulseIds,
  atlasTouchedIndex,
  atlasTrails,
  atlasWorkState,
} from "./atlas-motion.js";
import type { AtlasNode, AtlasPresence } from "./atlas-model.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const DAY = 86_400_000;
const p = (id: string, touched?: number, type: AtlasNode["type"] = "project"): AtlasNode => ({
  id,
  type,
  label: id,
  path: id,
  folder: true,
  count: 1,
  touched,
});

afterEach(() => vi.unstubAllGlobals());

describe("work pulses", () => {
  it("pulses nothing on the first read", () => {
    expect(atlasPulseIds({ nodes: [p("a", NOW)], prevTouched: null, presence: [], prevWork: null })).toEqual([]);
  });

  it("pulses a project whose touched time moved forward, not one that stayed or a non-project", () => {
    const before = atlasTouchedIndex([p("a", NOW - DAY), p("b", NOW - DAY), p("r", NOW - DAY, "repo")]);
    const ids = atlasPulseIds({
      nodes: [p("a", NOW), p("b", NOW - DAY), p("r", NOW, "repo"), p("new", NOW)],
      prevTouched: before,
      presence: [],
      prevWork: null,
    });
    expect(ids).toEqual(["a"]);
  });

  it("pulses when a live session on a project moves off its task or goes idle", () => {
    const was: AtlasPresence[] = [
      { nodeId: "a", actorUid: "u1", name: "Ann", bot: false, signal: "US-1" },
      { nodeId: "b", actorUid: "u2", name: "bot", bot: true, signal: "US-9" },
      { nodeId: "c", actorUid: "u3", name: "Cy", bot: false, signal: "US-3" },
    ];
    const now: AtlasPresence[] = [
      { nodeId: "a", actorUid: "u1", name: "Ann", bot: false, signal: "US-2" },
      { nodeId: "b", actorUid: "u2", name: "bot", bot: true, idle: true },
      { nodeId: "c", actorUid: "u3", name: "Cy", bot: false, signal: "US-3" },
    ];
    const nodes = [p("a", NOW), p("b", NOW - 1), p("c", NOW)];
    expect(atlasPulseIds({ nodes, prevTouched: null, presence: now, prevWork: atlasWorkState(was) })).toEqual(["a", "b"]);
  });

  it("caps pulses, newest first", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => p(`p${i}`, NOW - i));
    const prev = new Map(nodes.map((n) => [n.id, NOW - DAY]));
    const ids = atlasPulseIds({ nodes, prevTouched: prev, presence: [], prevWork: null });
    expect(ids).toHaveLength(ATLAS_PULSE_CAP);
    expect(ids[0]).toBe("p0");
  });
});

describe("work trails", () => {
  it("connects a project active now to its freshest linked items, capped per project", () => {
    const nodes = [p("proj", NOW - DAY * 3), ...Array.from({ length: 8 }, (_, i) => p(`k${i}`, NOW - i * 60_000, "knowledge")), p("old", NOW - DAY * 5, "knowledge")];
    const edges = nodes.slice(1).map((n) => ({ source: "proj", target: n.id, kind: "cites" as const }));
    const trails = atlasTrails({ nodes, edges, live: new Set(["proj"]), nowMs: NOW });
    expect(trails).toHaveLength(ATLAS_TRAILS_PER_PROJECT);
    expect(trails[0]).toEqual({ from: "proj", to: "k0" });
    expect(trails.some((t) => t.to === "old")).toBe(false);
  });

  it("draws nothing on an idle map and never more than the screen cap", () => {
    const idle = [p("proj", NOW - DAY * 3), p("k", NOW, "knowledge")];
    const edges = [{ source: "proj", target: "k", kind: "cites" as const }];
    expect(atlasTrails({ nodes: idle, edges, live: new Set(), nowMs: NOW })).toEqual([]);
    const many: AtlasNode[] = [];
    const manyEdges = [];
    for (let i = 0; i < 6; i++) {
      many.push(p(`p${i}`, NOW));
      for (let j = 0; j < 5; j++) {
        many.push(p(`k${i}-${j}`, NOW, "knowledge"));
        manyEdges.push({ source: `p${i}`, target: `k${i}-${j}`, kind: "cites" as const });
      }
    }
    expect(atlasTrails({ nodes: many, edges: manyEdges, live: new Set(), nowMs: NOW })).toHaveLength(ATLAS_TRAIL_CAP);
  });

  it("skips objects that are not drawn on the map", () => {
    const nodes = [p("proj", NOW), p("k", NOW, "knowledge")];
    const edges = [{ source: "proj", target: "k", kind: "cites" as const }];
    expect(atlasTrails({ nodes, edges, live: new Set(), nowMs: NOW, drawn: new Set(["proj"]) })).toEqual([]);
  });
});

describe("motion gate", () => {
  it("is off with motion off, under reduced motion, and while the page is hidden", () => {
    expect(atlasMotionAllowed(false)).toBe(false);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(atlasMotionAllowed(true)).toBe(false);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(atlasMotionAllowed(true)).toBe(true);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    expect(atlasMotionAllowed(true)).toBe(false);
    hidden.mockRestore();
  });
});
