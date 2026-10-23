import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Owner, 2026-10-22: the company menu stretched across the window. The shared
// `.chat-popover` rule comes later in the sheet and won on equal specificity
// (`right: 0`, `min-width: 160px`), so the menu's own 252px never applied.
// Layout is not something happy-dom computes, so this reads the stylesheet.
describe("company scope menu width", () => {
  const css = readFileSync(resolve(process.cwd(), "src/chat/ChatSidebar.svelte"), "utf8");

  it("outranks the shared popover rule and keeps its 252px", () => {
    const rule = css.match(/\n  \.chat-popover\.chat-scope-menu \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/right: auto/);
    expect(rule).toMatch(/\bwidth: 252px/);
    expect(rule).toMatch(/min-width: 252px/);
  });
});
