import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * QA-055: in a ~960px window the Deployments table clipped its last column
 * ("Last visit" read "Last", dates read "4d ag…") and sideways scrolling did
 * not reveal it. The rows used paint containment and were sized to the pane,
 * so cells past the pane edge were cut off. This reads the page's <style>
 * block and pins the layout contract that keeps every column reachable.
 */
const style = (() => {
  const src = readFileSync(join(__dirname, "PersonalDeploymentsPage.svelte"), "utf8");
  return src.match(/<style>([\s\S]*?)<\/style>/)![1]!;
})();

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = style.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `missing rule for ${selector}`).not.toBeNull();
  return match![1]!;
}

function columnTemplates(): string[] {
  return [...style.matchAll(/grid-template-columns:\s*([^;]+);/g)]
    .map((m) => m[1]!.trim())
    .filter((t) => t.startsWith("minmax(140px"));
}

describe("PersonalDeploymentsPage table layout (QA-055)", () => {
  it("the table wrapper scrolls horizontally when columns exceed the pane", () => {
    expect(rule(".table")).toMatch(/overflow-x:\s*auto/);
  });

  it("rows grow to their column minimums instead of clipping to the pane", () => {
    const rows = rule(".drow, .hd");
    expect(rows).toMatch(/width:\s*max-content/);
    expect(rows).toMatch(/min-width:\s*100%/);
  });

  it("every column template reserves a minimum width for the last column", () => {
    const templates = columnTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(2);
    for (const template of templates) {
      const last = template.split(/\s+(?![^(]*\))/).at(-1)!;
      expect(last, template).toMatch(/^minmax\((8[8-9]|9\d|\d{3,})px,\s*max-content\)$/);
    }
  });

  it("the name column is the one that shrinks, with ellipsis", () => {
    for (const template of columnTemplates()) expect(template.startsWith("minmax(140px, 1fr)")).toBe(true);
    expect(rule(".nm .t")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("rows do not use paint containment, which clips overflowing cells", () => {
    const drow = rule(".drow");
    expect(drow).not.toMatch(/contain:\s*(content|strict|[^;]*paint)/);
  });
});
