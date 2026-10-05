import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Company pane pages follow the Messages type scale
 * (docs/design-standard-console-rail.md): one 20px/500 page title, 13px for
 * everything else, weight capped at 500, and
 * list rows at the 31px Messages row height. This reads each page's <style>
 * block so a regression to the old 15/17/24px titles or 600/700 weights
 * fails here.
 */
const ROOT = join(__dirname, "..");
const PAGES = [
  "company/TeamPage.svelte",
  "company/BotsPage.svelte",
  "company/CompanySettingsPage.svelte",
  "activity/ActivityView.svelte",
  "goals/GoalsView.svelte",
  "company/brain/BrainPage.svelte",
  "atlas/AtlasView.svelte",
  "atlas/AtlasInspector.svelte",
  "atlas/AtlasScrubber.svelte",
  "shell/CompanySidepane.svelte",
];

function styleOf(file: string): string {
  const source = readFileSync(join(ROOT, file), "utf8");
  const match = source.match(/<style>([\s\S]*?)<\/style>/);
  return match ? match[1]! : "";
}

describe("company pane type scale contract", () => {
  for (const file of PAGES) {
    describe(file, () => {
      const css = styleOf(file);

      it("has no font size above 13px other than the 20px title token", () => {
        const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
        expect(sizes.filter((px) => px > 13)).toEqual([]);
        expect(css).not.toMatch(/var\(--type-(section|body|secondary|detail)\)/);
      });

      it("caps font weight at 500", () => {
        const weights = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(weights.filter((w) => w > 500)).toEqual([]);
      });

      it("uses no backdrop-filter", () => {
        expect(css).not.toMatch(/backdrop-filter/);
      });
    });
  }

  it("titles the Team and Bots pages at 20px through the title token", () => {
    for (const file of ["company/TeamPage.svelte", "company/BotsPage.svelte"]) {
      expect(styleOf(file)).toMatch(/h1 \{[^}]*font-size: var\(--type-title, 20px\)/);
    }
  });

  it("keeps Team and Bots rows at the 31px Messages row height", () => {
    expect(styleOf("company/TeamPage.svelte")).toMatch(/\.row-main \{[^}]*height: 31px/);
    expect(styleOf("company/BotsPage.svelte")).toMatch(/\.bot-row \{[^}]*height: 31px/);
  });
});
