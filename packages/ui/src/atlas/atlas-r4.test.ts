// @vitest-environment happy-dom
// OWNER-R4: sections are tinted with the web type colours and drawn without an
// outline; projects are small dots sized by the web scale; no two sections
// overlap and no two dots in a section overlap.
import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import AtlasMap from "./AtlasMap.svelte";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mapSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "AtlasMap.svelte"), "utf8");
import { ATLAS_TYPE_TINT, atlasDistrictShapes, atlasRadius, frameAll, layoutAtlas } from "./atlas-layout.js";
import { ATLAS_RING_ORDER, type AtlasNode } from "./atlas-model.js";

function crowd(perType: number): AtlasNode[] {
  const nodes: AtlasNode[] = [];
  for (const type of ATLAS_RING_ORDER) {
    for (let i = 0; i < perType; i++) {
      const big = type === "project" && i % 9 === 0;
      nodes.push({
        id: `${type}-${i}`,
        type,
        label: `${type} ${i}`,
        path: `${type}s/${i}`,
        folder: true,
        count: 1 + (i % 4),
        stories: type === "project" ? { done: 0, total: big ? 60 : 1 + (i % 5) } : undefined,
      } as AtlasNode);
    }
  }
  return nodes;
}

describe("OWNER-R4 Atlas layout", () => {
  it("keeps projects small: mostly dots, big projects small circles", () => {
    const one = atlasRadius({ type: "project", count: 1, stories: { done: 0, total: 1 } });
    const big = atlasRadius({ type: "project", count: 1, stories: { done: 0, total: 60 } });
    expect(one).toBeLessThan(4);
    expect(big).toBeLessThan(18);
    // Before R4 a 60-story project was 4 + sqrt(60) * 3.2 ≈ 28.8.
    expect(big).toBeLessThan(28.8 * 0.65);
  });

  it("never overlaps two sections, even when crowded", () => {
    for (const perType of [3, 40, 160]) {
      const { placed, regions } = layoutAtlas(crowd(perType));
      const shapes = atlasDistrictShapes(placed, regions);
      expect(shapes).toHaveLength(ATLAS_RING_ORDER.length);
      for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
          const a = shapes[i]!;
          const b = shapes[j]!;
          expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.type}/${b.type} at ${perType}`).toBeGreaterThanOrEqual(a.r + b.r);
        }
      }
    }
  });

  it("never overlaps two dots in one section", () => {
    const { placed } = layoutAtlas(crowd(60));
    for (const type of ATLAS_RING_ORDER) {
      const dots = placed.filter((n) => n.type === type);
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const a = dots[i]!;
          const b = dots[j]!;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
        }
      }
    }
  });

  it("tints each section with its web type colour, with no outline", () => {
    const { placed, regions } = layoutAtlas(crowd(4));
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(AtlasMap, {
      target,
      props: {
        placed,
        regions,
        edges: [],
        selected: null,
        live: new Set(),
        presence: [],
        filterIds: null,
        filterActor: null,
        timeOpacity: null,
        nothingActive: false,
        nowMs: 0,
        view: frameAll(placed, 1000, 700),
        onselect: () => {},
        onview: () => {},
      } as never,
    });
    flushSync();
    const colours = new Set<string>();
    for (const type of ATLAS_RING_ORDER) {
      const district = target.querySelector<SVGCircleElement>(`[data-testid='atlas-district-${type}']`)!;
      expect(district.getAttribute("vector-effect")).toBeNull();
      expect(district.style.getPropertyValue("--c")).toBe(ATLAS_TYPE_TINT[type]);
      colours.add(ATLAS_TYPE_TINT[type]);
      const node = target.querySelector<SVGGElement>(`[data-kind='${type}'][data-atlas-node]`)!;
      expect(node.style.getPropertyValue("--c")).toBe(ATLAS_TYPE_TINT[type]);
    }
    expect(colours.size).toBe(ATLAS_RING_ORDER.length);
    const districtRule = /\.district\s*\{([^}]*)\}/.exec(mapSource)?.[1] ?? "";
    expect(districtRule).toMatch(/stroke:\s*none/);
    expect(districtRule).toMatch(/fill:[^;]*var\(--c\)/);
    // Six clearly different hues, none of them purple (hue 260-330).
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const hues = [...colours].map(hue);
    for (const h of hues) expect(h < 260 || h > 330, String(h)).toBe(true);
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const gapDeg = Math.min(Math.abs(hues[i]! - hues[j]!), 360 - Math.abs(hues[i]! - hues[j]!));
        expect(gapDeg, `${[...colours][i]} vs ${[...colours][j]}`).toBeGreaterThanOrEqual(12);
      }
    }
    void unmount(component);
  });
});
