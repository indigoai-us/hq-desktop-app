import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Owner, 2026-10-22: the company mark in a channel header sat above the
// title. The title row aligns on the text baseline, which seats an icon
// box's bottom edge on the baseline; the mark has to be centred instead.
// Layout is not something happy-dom computes, so this reads the stylesheet.
describe("channel header icon", () => {
  const src = readFileSync(resolve(process.cwd(), "src/shell/DesktopApp.svelte"), "utf8");

  it("centres the company mark on the title row", () => {
    expect(src).toMatch(/\n  \.channel-title \{[^}]*align-items: baseline/);
    expect(src).toMatch(/\n  \.channel-title > :global\(\.company-icon\) \{[^}]*align-self: center/);
  });
});
