import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Depth and texture stay static and quiet: the vignette and grain sit under
// the map (labels draw over them), nothing in them animates, no backdrop
// filter, and the strengths stay low enough that labels keep their contrast
// in both themes (measured: at most 0.1 contrast ratio lost at the far corners).
const HERE = dirname(fileURLToPath(import.meta.url));
const map = readFileSync(join(HERE, "AtlasMap.svelte"), "utf8");
const block = (sel: string) => map.match(new RegExp(`\\n  ${sel.replace(/[.:]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Atlas depth and texture", () => {
  it("draws the ground under the SVG, static, with no backdrop filter", () => {
    expect(map.indexOf('<div class="ground"')).toBeLessThan(map.indexOf("<svg"));
    const ground = block(".ground") + block(".ground::after");
    expect(ground).toMatch(/z-index:\s*-1/);
    expect(ground).not.toMatch(/animation|transition/);
    expect(map).not.toMatch(/backdrop-filter/);
  });

  it("keeps the vignette and grain faint", () => {
    const vignette = Number(block(".ground").match(/rgb\(0 0 0 \/ ([\d.]+)\)/)?.[1]);
    expect(vignette).toBeGreaterThan(0);
    expect(vignette).toBeLessThanOrEqual(0.12);
    const grain = Number(block(".ground::after").match(/opacity:\s*([\d.]+)/)?.[1]);
    expect(grain).toBeGreaterThan(0);
    expect(grain).toBeLessThanOrEqual(0.06);
  });

  it("glows active objects with a static, monochrome radial gradient instead of a blur filter", () => {
    expect(map).toMatch(/<radialGradient id=\{glowId\}/);
    expect(map).not.toMatch(/feGaussianBlur/);
    for (const stop of [".glow-core", ".glow-mid", ".glow-edge"]) {
      expect(block(stop)).toMatch(/stop-color:\s*var\(--v4-text-1\)/);
      expect(Number(block(stop).match(/stop-opacity:\s*([\d.]+)/)?.[1])).toBeLessThanOrEqual(0.2);
    }
  });
});
