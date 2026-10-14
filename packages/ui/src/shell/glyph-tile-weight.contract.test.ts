// AUDIT-2-04 / -05: initials glyph tiles (rail company tile, rail You avatar,
// company label chip initials, company sidepane mark) keep their sizes — they
// are icons, sanctioned by the OWNER-010/011 favicon work — but not their 600
// weight. Every tile is capped at 500 like the rest of the console-rail type.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

const TILES: Array<[string, string]> = [
  ["shell/AppRail.svelte", ".co-tile"],
  ["shell/AppRail.svelte", ".avatar"],
  ["company/CompanyLabel.svelte", ".company-label-initials"],
  ["shell/CompanySidepane.svelte", ".company-mark"],
];

function weightsFor(file: string, cls: string): number[] {
  const text = readFileSync(join(src, file), "utf8");
  const style = text.slice(text.lastIndexOf("<style"));
  const out: number[] = [];
  for (const m of style.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim());
    if (!sels.includes(cls)) continue;
    for (const w of m[2].matchAll(/font-weight:\s*(\d+)/g)) out.push(Number(w[1]));
    for (const f of m[2].matchAll(/(?<![-\w])font:\s*(\d{3})\s/g)) out.push(Number(f[1]));
  }
  return out;
}

describe("glyph tile weight (AUDIT-2-04, -05)", () => {
  for (const [file, cls] of TILES) {
    it(`${file} ${cls} declares a weight of at most 500`, () => {
      const weights = weightsFor(file, cls);
      expect(weights.length).toBeGreaterThan(0);
      expect(weights.filter((w) => w > 500)).toEqual([]);
    });
  }
});
