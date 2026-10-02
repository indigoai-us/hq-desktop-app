import { describe, expect, it } from "vitest";
import {
  activeGrants,
  filesForSection,
  personalLibraryFixture,
  sharedGrantPreview,
} from "./personal-library.js";
import { beginRedeploy, filterDeployments, personalDeploymentsFixture, progressFor } from "./personal-deployments.js";

describe("personal library (US-031)", () => {
  it("shows the selected shared file in the preview model", () => {
    const cache = personalLibraryFixture();
    const active = activeGrants(cache.grants);
    expect(active).toHaveLength(3);
    const selected = sharedGrantPreview(cache.grants, "billing");
    expect(selected?.name).toBe("agent-billing-seams.md");
    expect(selected?.preview).toContain("Agent billing seams");
    expect(selected?.access).toBe("read");
  });

  it("keeps starred files as a subset of my files", () => {
    const cache = personalLibraryFixture();
    expect(filesForSection(cache, "mine").length).toBeGreaterThan(
      filesForSection(cache, "starred").length,
    );
  });
});

describe("personal deployments (US-031)", () => {
  it("keeps the old build serving while a redeploy is in progress", () => {
    const row = personalDeploymentsFixture().rows[0]!;
    const deploying = beginRedeploy(row);
    expect(deploying.status).toBe("deploying");
    const progress = progressFor(deploying);
    expect(progress.step).toBe(3);
    expect(progress.serving).toBe(row.liveVersion);
    expect(progress.swapped).toBe(false);
    expect(deploying.detail).toContain("stays live until swap");
  });

  it("filters sleeping rows without dropping the cache", () => {
    const rows = personalDeploymentsFixture().rows;
    const sleeping = filterDeployments(rows, "sleeping", "");
    expect(sleeping.map((row) => row.id)).toEqual(["sleep"]);
    expect(filterDeployments(rows, "all", "cut30").map((row) => row.id)).toEqual(["cut30"]);
  });
});
