/**
 * Owner, 2026-10-14, on the rail's badges card: "backdrop blur not working, so
 * should probably have solid background". The overlay surface (--overlay-bg)
 * turns translucent as window transparency goes up, so the badges card and a
 * badge's hover card let the sidebar read through. Both paint the solid
 * variant, which every theme file defines without alpha.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ui = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ui, rel), "utf8");

const TOKEN_FILES = ["chat/tokens.css", "home/tokens.css", "../../../apps/sync/src/desktop-alt/v4/tokens.css"];

describe("badge hover cards are solid at every window-transparency setting", () => {
  it.each(TOKEN_FILES)("%s defines a solid popover surface with no alpha", (file) => {
    const css = read(file);
    const solids = [...css.matchAll(/--v4-popover-solid:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(solids.length).toBeGreaterThanOrEqual(3);
    for (const value of solids) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    expect(css).toMatch(/--overlay-bg-solid:\s*var\(--v4-popover-solid, var\(--overlay-bg\)\);/);
    // The translucent overlay token itself is unchanged for every other overlay.
    expect(css).toMatch(/--overlay-bg:\s*var\(--v4-popover-strong\);/);
  });

  it("the rail's badges card paints the solid surface", () => {
    const card = read("shell/RailYouCard.svelte").match(/\.card \{[^}]+\}/)?.[0] ?? "";
    expect(card).toMatch(/background:\s*var\(--overlay-bg-solid, var\(--overlay-bg\)\);/);
  });

  it("a badge's hover card paints the solid surface", () => {
    const hc = read("badges/ProfileBadges.svelte").match(/\.hc \{[^}]+\}/)?.[0] ?? "";
    expect(hc).toMatch(/background:\s*var\(--overlay-bg-solid,/);
  });
});
