/**
 * Owner feedback (2026-10-05): "please ensure every button has an icon in the
 * app". Pins the four buttons from the owner's screenshots and the shared
 * spacing rule for leading icons inside non-RailButton buttons.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

function buttonAround(src: string, label: string): string {
  const at = src.indexOf(label);
  expect(at, label).toBeGreaterThan(-1);
  const start = src.lastIndexOf("<button", at);
  return src.slice(start, src.indexOf("</button>", at));
}

describe("labelled buttons carry a leading icon", () => {
  it.each([
    ["projects/CompanyProjectsPage.svelte", '"New project"', "plus"],
    ["marketplace/SubmitPanel.svelte", '"Choose folder…"', "folder"],
    ["marketplace/SubmitPanel.svelte", "Submit for review", "send"],
    ["marketplace/ModerationPanel.svelte", "Refresh", "refresh"],
  ])("%s %s has the %s icon", (rel, label, icon) => {
    expect(buttonAround(read(rel), label)).toContain(`<RailIcon name="${icon}" />`);
  });

  it("spaces a leading icon 6px from the label and centres it", () => {
    const css = read("common/button/rail-type.css");
    expect(css).toMatch(/button:not\(\[data-rail-btn\]\) > svg\.rail-icon:first-child \{[^}]*margin-inline-end: 6px/u);
    expect(read("common/button/RailIcon.svelte")).toMatch(/import "\.\/rail-type\.css"/u);
  });
});
