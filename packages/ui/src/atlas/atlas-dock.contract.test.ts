import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Not on the map dock: one shape language. Every chip (person, bot, +N) is the
// same circle with one 1px hairline; live presence is a thin ring with a gap,
// drawn outside the chip; the header is sentence case like the inspector's.
const HERE = dirname(fileURLToPath(import.meta.url));
const map = readFileSync(join(HERE, "AtlasMap.svelte"), "utf8");
const block = (sel: string) => map.match(new RegExp(`\\n  ${sel.replace(/[.:()]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Atlas Not on the map dock", () => {
  it("draws every chip as the same circle with one hairline border", () => {
    const away = block(".away");
    expect(away).toMatch(/border-radius:\s*50%/);
    expect(away).toMatch(/border:\s*1px solid var\(--v4-control-border\)/);
    expect(away).toMatch(/width:\s*22px/);
    expect(away).toMatch(/height:\s*22px/);
    // No square bot tiles, no pill overflow, no second outline colour.
    expect(block(".away.bot")).toBe("");
    expect(block(".away.more")).not.toMatch(/border-radius|width|border-color/);
    expect(block(".away.idle")).toBe("");
  });

  it("marks live presence only, with a 2px ring and a 1px gap on the dock surface", () => {
    const live = block(".away:not(.idle):not(.more)");
    expect(live).toMatch(/box-shadow:\s*0 0 0 1px var\(--v4-ground\),\s*0 0 0 3px var\(--v4-ok\)/);
  });

  it("titles the dock in sentence case with a muted count, and shows a focus ring", () => {
    expect(map).toContain('Not on the map <span class="unplaced-count"');
    expect(block(".unplaced-cap")).not.toMatch(/uppercase/);
    expect(block(".unplaced-count")).toMatch(/color:\s*var\(--v4-text-3\)/);
    expect(block(".away:focus-visible")).toMatch(/--v4-focus-ring/);
  });
});
