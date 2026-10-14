// Contract for the shared "document card" (doc-card.css): artifact cards and
// file attachment cards are the same object — "there is more here than the
// message shows" — so they share one shell. Before this, the artifact card had
// a 44px animated gradient mesh tile, an outline, 12px radius and bold
// uppercase "DETAILS"; the file card was a separate outlined grey pill.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function svelteCss(file: string): string {
  return stripComments(read(file).split("<style>")[1] ?? "");
}

/** Declarations of the first rule whose selector list is exactly `selector`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`),
  );
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

function prop(declarations: string, name: string): string | undefined {
  return declarations
    .match(new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+);`))?.[1]
    .trim();
}

const css = stripComments(read("./doc-card.css"));
const artifactCard = read("./ArtifactCard.svelte");
const attachments = read("./MessageAttachments.svelte");

describe("doc card shell", () => {
  it("is a 10px-radius raised fill with no visible outline, max 440 wide", () => {
    const card = rule(css, ".doc-card");
    expect(prop(card, "border-radius")).toBe("10px");
    expect(prop(card, "border")).toBe("1px solid transparent");
    expect(prop(card, "background-color")).toBe("var(--raised)");
    expect(prop(card, "max-width")).toBe("440px");
  });

  it("lifts the fill with the hover token instead of drawing an edge on hover", () => {
    const hover = rule(css, ".doc-card:hover:not(:disabled)");
    expect(hover).toContain("var(--hover)");
    expect(hover).not.toMatch(/border/);
  });

  it("uses theme tokens for every colour (light and dark both hold)", () => {
    const colours = [...css.matchAll(/(?:^|[;{\s])(?:color|background(?:-color)?|border-color):\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((value) => value !== "transparent" && value !== "inherit");
    expect(colours.length).toBeGreaterThan(0);
    for (const value of colours) {
      expect(value).toMatch(/var\(--/);
    }
  });

  it("has a 32px icon well, 13/500 title, 12px summary", () => {
    const well = rule(css, ".doc-card-icon");
    expect(prop(well, "width")).toBe("32px");
    expect(prop(well, "height")).toBe("32px");
    expect(prop(rule(css, ".doc-card-title"), "font")).toMatch(/^500 13px\//);
    expect(prop(rule(css, ".doc-card-summary"), "font")).toMatch(/^400 12px\//);
  });

  it("captions in one plain 10px mono style — no bold, uppercase or wide tracking", () => {
    const meta = rule(css, ".doc-card-meta");
    expect(prop(meta, "font")).toMatch(/^400 10px\/[\d.]+ var\(--font-mono/);
    expect(meta).not.toMatch(/text-transform/);
    expect(css).not.toMatch(/\.doc-card-kind/);
    expect(artifactCard).not.toContain("doc-card-kind");
    expect(artifactCard).not.toMatch(/text-transform:\s*uppercase/);
  });

  it("keeps actions as square standard-height icon buttons, hidden until hover or keyboard focus", () => {
    const btn = rule(css, ".doc-card-btn");
    // Square on the console-rail beta's one button height (button-standard.css).
    expect(prop(btn, "width")).toBe("var(--hq-btn-h)");
    expect(prop(btn, "height")).toBe("var(--hq-btn-h)");
    expect(prop(rule(css, ".doc-card-actions"), "opacity")).toBe("0");
    const reveal = css.match(/([^{}]+)\{\s*opacity:\s*1;\s*\}/)?.[1] ?? "";
    expect(reveal).toContain(".doc-card:hover .doc-card-actions");
    expect(reveal).toContain(".doc-card:has(:focus-visible) .doc-card-actions");
  });
});

describe("both cards wear the shared shell", () => {
  it("the artifact card uses doc-card and drops the gradient mesh tile", () => {
    expect(artifactCard).toContain('import "./doc-card.css"');
    expect(artifactCard).toMatch(/class="doc-card artifact-card/);
    expect(artifactCard).not.toContain("artifact-tile");
    expect(artifactCard).not.toContain("radial-gradient");
    expect(svelteCss("./ArtifactCard.svelte")).not.toMatch(/border:\s*1px solid var\(--line/);
  });

  it("the file card uses doc-card with the same icon well, title and caption", () => {
    expect(attachments).toContain('import "./doc-card.css"');
    expect(attachments).toMatch(/class="doc-card is-compact att-card"/);
    expect(attachments).toContain('class="doc-card-icon"');
    expect(attachments).toContain('class="doc-card-title"');
    expect(attachments).toMatch(/class="doc-card-meta"/);
    // No private card chrome left to drift from the shared one.
    const local = svelteCss("./MessageAttachments.svelte");
    expect(local).not.toMatch(/\.att-card\s*\{[^}]*border:/);
    expect(local).not.toMatch(/\.att-icon\b/);
  });
});
