import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  agentAvatarAssets,
  agentAvatarFor,
  authorAvatarUrl,
} from "./agent-avatars";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "agent-avatars.ts"),
  "utf8",
);

describe("agent-avatars", () => {
  it("bundles a discovered, sorted asset set", () => {
    expect(agentAvatarAssets.length).toBeGreaterThanOrEqual(2);
    expect([...agentAvatarAssets]).toEqual(agentAvatarAssets);
    for (const url of agentAvatarAssets) expect(typeof url).toBe("string");
  });

  it("maps the same uid to the same asset every time", () => {
    const first = agentAvatarFor("agt_parker");
    expect(first).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(agentAvatarFor("agt_parker")).toBe(first);
    }
    // Whitespace does not change the mapping.
    expect(agentAvatarFor("  agt_parker  ")).toBe(first);
  });

  it("distributes different uids across the set", () => {
    const uids = Array.from({ length: 40 }, (_, i) => `agt_worker_${i}`);
    const picks = new Set(uids.map((uid) => agentAvatarFor(uid)));
    expect(picks.size).toBeGreaterThanOrEqual(2);
    for (const pick of picks) {
      expect(agentAvatarAssets).toContain(pick);
    }
  });

  it("returns null for blank uids", () => {
    expect(agentAvatarFor("")).toBeNull();
    expect(agentAvatarFor("   ")).toBeNull();
    expect(agentAvatarFor(null)).toBeNull();
    expect(agentAvatarFor(undefined)).toBeNull();
  });

  it("returns null when the bundled set is empty", () => {
    expect(agentAvatarFor("agt_parker", [])).toBeNull();
  });

  it("returns a roster photo for any uid and null otherwise", () => {
    expect(authorAvatarUrl("prs_ada", { prs_ada: "https://cdn/ada.jpg" })).toBe(
      "https://cdn/ada.jpg",
    );
    expect(authorAvatarUrl(" agt_x ", { agt_x: " https://cdn/x.jpg " })).toBe(
      "https://cdn/x.jpg",
    );
    expect(authorAvatarUrl("prs_ada", {})).toBeNull();
    expect(authorAvatarUrl("prs_ada", null)).toBeNull();
    expect(authorAvatarUrl("", { prs_ada: "https://cdn/ada.jpg" })).toBeNull();
    expect(authorAvatarUrl(null, { prs_ada: "https://cdn/ada.jpg" })).toBeNull();
  });

  it("does not guard import.meta.glob behind typeof", () => {
    // The guard survives bundling (Vite only rewrites the *call*) and
    // disables the set in production, where import.meta.glob is undefined.
    const code = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/typeof\s+import\.meta\.glob/);
    expect(code).toMatch(/import\.meta\.glob\(/);
  });
});
