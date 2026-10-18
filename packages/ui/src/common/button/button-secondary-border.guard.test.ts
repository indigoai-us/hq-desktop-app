/**
 * Owner feedback (2026-10-14): "Secondary button should have no border by
 * default and show the border on hover. Check the secondary style button on the
 * desktop app." The titlebar pills (home/V4TitleBar.svelte `.v4-core-pill`) are
 * the standard: a transparent rim at rest, the `--line2` rim on hover.
 * RailButton's secondary variant follows them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(resolve(HERE, "RailButton.svelte"), "utf8");
const titlebar = readFileSync(resolve(HERE, "../../home/V4TitleBar.svelte"), "utf8");

/** The declarations of the first rule whose selector list matches `selector` exactly. */
function rule(source: string, selector: RegExp): string {
  const match = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, "u").exec(source);
  return match?.[1] ?? "";
}

describe("secondary button border", () => {
  it("the titlebar pill standard: no rim at rest, the rim on hover", () => {
    expect(rule(titlebar, /\.v4-core-pill/)).toMatch(/border:\s*1px solid transparent/u);
    expect(rule(titlebar, /\.v4-core-pill:hover,\s*\.v4-core-pill\[aria-expanded="true"\]/)).toMatch(/border-color:\s*var\(--line2\)/u);
  });

  it("RailButton secondary matches it", () => {
    expect(rule(rail, /\.rail-btn\.secondary/)).toMatch(/border-color:\s*transparent/u);
    expect(rule(rail, /\.rail-btn\.secondary:hover:not\(:disabled\)/)).toMatch(/border-color:\s*var\(--line2\b/u);
  });
});
