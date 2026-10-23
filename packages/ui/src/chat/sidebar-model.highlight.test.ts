import { describe, expect, it } from "vitest";

import { highlightMatches } from "./sidebar-model.js";

describe("highlightMatches", () => {
  it("marks every case-insensitive run of the query", () => {
    expect(highlightMatches("Sync ran, then sync again", "sync")).toEqual([
      { text: "Sync", match: true },
      { text: " ran, then ", match: false },
      { text: "sync", match: true },
      { text: " again", match: false },
    ]);
  });

  it("keeps the original casing of the matched text", () => {
    const parts = highlightMatches("HQ Sync", "sync");
    expect(parts.find((p) => p.match)?.text).toBe("Sync");
  });

  it("returns the whole string unmarked when there is no query", () => {
    expect(highlightMatches("anything", "   ")).toEqual([
      { text: "anything", match: false },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(highlightMatches("", "sync")).toEqual([]);
  });

  // Message text is arbitrary; a naive regex build would throw on these.
  it("treats the query as literal text, not a pattern", () => {
    expect(highlightMatches("a (b) c", "(b)")).toEqual([
      { text: "a ", match: false },
      { text: "(b)", match: true },
      { text: " c", match: false },
    ]);
    expect(() => highlightMatches("cost is $5", "[")).not.toThrow();
  });

  it("does not loop forever on a query that is only whitespace inside", () => {
    expect(highlightMatches("a a a", "a")).toHaveLength(5);
  });
});
