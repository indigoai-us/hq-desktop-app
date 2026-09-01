import { describe, expect, it } from "vitest";

import { agentAvatarAssets, agentAvatarFor } from "./agent-avatars";

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
});
