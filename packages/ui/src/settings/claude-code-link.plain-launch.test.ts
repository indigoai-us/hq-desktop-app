import { describe, expect, it } from "vitest";
import { buildClaudeCodeUrl } from "./claude-code-link";

// Optional-prompt behavior added for the titlebar "Launch" menu: a plain
// workspace launch omits `q` entirely so Claude Code opens the folder with
// an empty composer instead of a pre-typed `/setup`. Existing prompt-ful
// call sites keep the historical `q=` shape (covered by
// src/files/claude-code-link.test.ts against the files/ twin module).

describe("buildClaudeCodeUrl plain launch (no prompt)", () => {
  it("omits q when prompt is undefined", () => {
    const parsed = new URL(buildClaudeCodeUrl({ folder: "/p" }));
    expect(parsed.searchParams.has("q")).toBe(false);
    expect(parsed.searchParams.get("folder")).toBe("/p");
  });

  it("omits q for empty / whitespace prompts", () => {
    for (const prompt of ["", "   "]) {
      const parsed = new URL(buildClaudeCodeUrl({ folder: "/p", prompt }));
      expect(parsed.searchParams.has("q")).toBe(false);
    }
  });

  it("keeps the q shape when a prompt is provided", () => {
    const parsed = new URL(
      buildClaudeCodeUrl({ folder: "/p", prompt: "/setup" }),
    );
    expect(parsed.searchParams.get("q")).toBe("/setup");
    expect(parsed.searchParams.get("folder")).toBe("/p");
  });

  it("still parses when both folder and prompt are empty", () => {
    expect(buildClaudeCodeUrl({ folder: "" })).toBe("claude://code/new");
  });
});
