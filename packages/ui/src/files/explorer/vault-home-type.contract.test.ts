import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AUDIT-2: the Library vault home follows the console-rail type scale
 * (docs/design-standard-console-rail.md): the vault name is the one 20px/500
 * title, everything else on the home is 13px, weight at most 500, and the
 * eyebrow is sentence case rather than tracked caps.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "VaultExplorer.svelte"), "utf8");
const css = src.slice(src.indexOf("<style>"));
const home = css.slice(css.indexOf("/* ---- vault home ---- */"), css.indexOf(".vx-list {"));

describe("AUDIT-2 Library vault home type", () => {
  it("has the vault home block", () => {
    expect(home.length).toBeGreaterThan(100);
  });

  it("uses the title token for the heading and 13px for everything else", () => {
    expect(home).toMatch(/\.vx-home h1 \{[^}]*font-size: var\(--type-title/);
    const sizes = [...home.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.filter((px) => px !== 13)).toEqual([]);
  });

  it("caps weight at 500 and has no tracked caps", () => {
    const weights = [...home.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(weights.filter((w) => w > 500)).toEqual([]);
    expect(home).not.toMatch(/text-transform:\s*uppercase/);
  });
});
