import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Owner, 2026-10-22: "there shouldn't be a box background under the first
// section" and "the description text should fill the width instead of
// switching lines in the middle". Layout is not something happy-dom
// computes, so this reads the stylesheet.
describe("welcome hero layout", () => {
  const css = readFileSync(resolve(process.cwd(), "src/chat/SetupChannelIntro.svelte"), "utf8");
  const rule = (sel: string): string =>
    css.match(new RegExp(`\\n  ${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";

  it("draws no box behind the hero", () => {
    expect(rule(".hero")).toMatch(/background: transparent/);
  });

  it("draws no divider under the welcome copy", () => {
    expect(rule(".hero-copy")).toMatch(/border-bottom: 0/);
    expect(rule(".hero-copy")).not.toMatch(/border-bottom: 1px/);
  });

  it("lets the hero copy fill the column", () => {
    expect(rule(".hero-body")).toMatch(/max-width: none/);
    expect(rule(".launch-error")).toMatch(/max-width: none/);
  });
});
