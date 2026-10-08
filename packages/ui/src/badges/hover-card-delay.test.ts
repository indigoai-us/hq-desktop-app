/**
 * The badge hover cards (what earns a badge) wait before showing, so passing
 * the pointer over the grid does not flash them (owner review 2026-10-08:
 * 250ms was too quick). Both grids share one delay.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("badge hover card delay", () => {
  it.each(["ProfileBadges.svelte", "BadgesPane.svelte"])("%s shows its hover card after 600ms", (file) => {
    const css = readFileSync(join(here, file), "utf8");
    const shown = css.match(/\.b:hover \.hc[^{]*\{([^}]*)\}/)?.[1] ?? "";
    expect(shown).toMatch(/transition:\s*opacity 120ms ease 600ms, visibility 0s linear 600ms;/);
  });
});
