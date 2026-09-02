import { describe, expect, it } from "vitest";

import { canEditAgentProfile } from "./can-edit.js";

describe("canEditAgentProfile", () => {
  it("is false for humans and for agents when the caller is not admin", () => {
    expect(
      canEditAgentProfile({ agentUid: "prs_ada", isAdmin: true }),
    ).toBe(false);
    expect(
      canEditAgentProfile({ agentUid: "agt_scout", isAdmin: false }),
    ).toBe(false);
    expect(canEditAgentProfile({ agentUid: "agt_scout" })).toBe(false);
  });

  it("honors an explicit admin flag for agents", () => {
    expect(
      canEditAgentProfile({ agentUid: "agt_scout", isAdmin: true }),
    ).toBe(true);
  });

  it("derives admin from the agent's company membership", () => {
    expect(
      canEditAgentProfile({
        agentUid: "agt_scout",
        agentCompanyUid: "cmp_indigo",
        companies: [
          { slug: "indigo", cloudUid: "cmp_indigo", role: "admin" },
        ],
      }),
    ).toBe(true);
    expect(
      canEditAgentProfile({
        agentUid: "agt_scout",
        agentCompanyUid: "cmp_indigo",
        companies: [
          { slug: "indigo", cloudUid: "cmp_indigo", role: "member" },
        ],
      }),
    ).toBe(false);
  });
});
