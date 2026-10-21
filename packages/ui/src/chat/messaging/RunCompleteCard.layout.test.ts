import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Owner, #772: the run card hugs its content like the document cards, with
// the artifact card's width as its minimum, and no card in the chat column
// carries a resting outline. Layout is not something happy-dom computes, so
// the contract is read from the stylesheet.
describe("RunCompleteCard layout", () => {
  const css = readFileSync(resolve(process.cwd(), "src/chat/messaging/RunCompleteCard.svelte"), "utf8");
  const rule = css.match(/\n  \.run-card \{([^}]*)\}/)?.[1] ?? "";

  it("hugs its content with the artifact card's minimum width", () => {
    expect(rule).toMatch(/width: fit-content/);
    expect(rule).toMatch(/min-width: min\(440px, 100%\)/);
    expect(rule).toMatch(/max-width: 100%/);
  });

  it("has no resting outline", () => {
    expect(rule).toMatch(/border: 1px solid transparent/);
  });
});
