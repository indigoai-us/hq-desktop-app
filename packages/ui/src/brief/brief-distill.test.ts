import { describe, expect, it } from "vitest";
import { parsePr, shippedDigest } from "./brief-distill.js";

describe("shippedDigest", () => {
  const lines = [
    "1220 chore(v16): remove /plan stub",
    "1217 feat(conduct): on by default in v16",
    "1215 docs(policies): retire the when:always recommendation",
    "1214 promote(overnight): add /overnight skill",
    "1204 fix(grok): cover the 1.0.40+ hook contract",
    "1173 Policies: keyword-trigger every core policy",
  ].map((label) => ({ label, state: "MERGED" }));

  it("summarizes the mix by kind in one line", () => {
    expect(shippedDigest(lines).mix).toBe("2 features · 1 fix · 1 change · 1 docs · 1 chore");
  });

  it("keeps three highlights, features first, without PR numbers or prefixes", () => {
    expect(shippedDigest(lines).highlights.map((h) => h.label)).toEqual([
      "On by default in v16",
      "Add /overnight skill",
      "Cover the 1.0.40+ hook contract",
    ]);
  });

  it("treats an unprefixed title as a plain change", () => {
    expect(parsePr("88 Bump the logo")).toEqual({ kind: "change", text: "Bump the logo" });
  });
});
