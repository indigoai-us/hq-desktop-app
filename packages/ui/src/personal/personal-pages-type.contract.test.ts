import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Personal pages follow the Messages type scale
 * (docs/design-standard-console-rail.md): one 20px/500 page title, 13px for
 * everything else, weight capped at 500, no tracked mono-caps headers, no
 * bordered status pills, and list rows at the 31px Messages row height.
 * This reads each page's <style> block so a regression to the old 24px mono
 * stat numbers, 17px titles, or 600/700 weights fails here.
 */
const ROOT = join(__dirname, "..");
const PAGES = [
  "personal/PersonalRailPage.svelte",
  "telemetry/TelemetryView.svelte",
  "shell/TelemetryRailHost.svelte",
  "library/PersonalDeploymentsPage.svelte",
  "outpost/OutpostPage.svelte",
  "account/AccountPages.svelte",
];

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

function styleOf(file: string): string {
  const match = read(file).match(/<style>([\s\S]*?)<\/style>/);
  return match ? match[1]! : "";
}

describe("personal pages type scale contract", () => {
  for (const file of PAGES) {
    describe(file, () => {
      const css = styleOf(file);

      it("has no font size above 13px and no inflated type tokens", () => {
        const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
        expect(sizes.filter((px) => px > 13)).toEqual([]);
        expect(css).not.toMatch(/var\(--type-(section|body|secondary|detail)\)/);
      });

      it("caps font weight at 500", () => {
        const weights = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(weights.filter((w) => w > 500)).toEqual([]);
      });

      it("has no tracked uppercase headers", () => {
        expect(css).not.toMatch(/text-transform:\s*uppercase/);
        expect(css).not.toMatch(/letter-spacing:\s*0\.\d+em/);
      });

      it("uses no backdrop-filter", () => {
        expect(css).not.toMatch(/backdrop-filter/);
      });
    });
  }

  it("titles each routed personal page at 20px through the title token, once", () => {
    for (const file of [
      "personal/PersonalRailPage.svelte",
      "telemetry/TelemetryView.svelte",
      "library/PersonalDeploymentsPage.svelte",
      "outpost/OutpostPage.svelte",
      "account/AccountPages.svelte",
    ]) {
      expect(styleOf(file)).toMatch(/h1 \{[^}]*font-size: var\(--type-title, 20px\)/);
      // The side pane no longer repeats the page title above the nav.
      expect(read(file)).not.toMatch(/class="pane-head">(Secrets|Connections|My Telemetry|Deployments)/);
    }
  });

  it("draws status as a dot plus text, not a bordered pill", () => {
    for (const file of ["personal/PersonalRailPage.svelte", "telemetry/TelemetryView.svelte", "outpost/OutpostPage.svelte", "account/AccountPages.svelte"]) {
      expect(read(file)).not.toMatch(/class="chip[ "]/);
      expect(styleOf(file)).toMatch(/\.dot \{[^}]*width: 6px; height: 6px/);
    }
  });

  it("keeps list rows at the 31px Messages row height", () => {
    expect(styleOf("personal/PersonalRailPage.svelte")).toMatch(/\.srow \{[^}]*height: 31px/);
    expect(styleOf("telemetry/TelemetryView.svelte")).toMatch(/\.srow, \.trow \{[^}]*height: 31px/);
    expect(styleOf("outpost/OutpostPage.svelte")).toMatch(/\.jrow \{[^}]*height: 31px/);
  });

  it("spaces the connection name from its account (QA-035)", () => {
    expect(styleOf("personal/PersonalRailPage.svelte")).toMatch(/\.cell \{[^}]*gap: 8px/);
  });

  it("stacks Telemetry's right column under the sessions table on narrow windows (QA-039)", () => {
    expect(styleOf("telemetry/TelemetryView.svelte")).toMatch(/@media \(max-width: 1180px\) \{\s*\.two \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  it("never collapses the Deployments app name; narrow windows drop lesser columns (QA-040)", () => {
    const css = styleOf("library/PersonalDeploymentsPage.svelte");
    expect(css).toMatch(/\.drow, \.hd \{[^}]*grid-template-columns: minmax\(140px, 1fr\) 96px 96px 104px/);
    expect(css).toMatch(/@media \(max-width: 1180px\) \{[^@]*:nth-child\(n \+ 4\)[^}]*display: none/);
  });

  it("renders telemetry stat numbers in 13px sans, not mono", () => {
    const css = styleOf("telemetry/TelemetryView.svelte");
    expect(css).toMatch(/\.stat \.n \{[^}]*font-size: 13px/);
    expect(css).not.toMatch(/\.n \{[^}]*font-mono/);
  });
});
