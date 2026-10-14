import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Callouts stay quiet: neutral surface, no tone fill or left accent bar,
// with the semantic tone color carried by the icon only.
const source = readFileSync(
  fileURLToPath(new URL("./RichMessageContent.svelte", import.meta.url)),
  "utf8",
);

function rule(selector: string): string {
  const match = source.match(new RegExp(`\\n\\s*${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`));
  if (!match) throw new Error(`missing CSS rule ${selector}`);
  return match[1];
}

describe("rich callout styling", () => {
  it("uses a neutral surface with no tone fill, tone border, or left accent bar", () => {
    const css = rule(".rich-callout");
    expect(css).not.toMatch(/--tone-(tint|line|ink)/);
    expect(css).not.toMatch(/border-left/);
    expect(css).toContain("var(--raised");
    expect(css).toContain("var(--line");
  });

  it("puts the tone color on the icon only", () => {
    expect(rule(".rich-callout-icon")).toContain("var(--tone-ink)");
    const title = rule(".rich-callout-title");
    expect(title).not.toContain("--tone-ink");
    expect(title).toMatch(/font-weight: (400|500);/);
    expect(rule(".rich-callout-body")).toContain("var(--t2");
  });
});
