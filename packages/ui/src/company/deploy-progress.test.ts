import { describe, expect, it } from "vitest";
import { deployProgress } from "./deploy-progress.js";

describe("deployProgress (US-031)", () => {
  it("keeps the old build live until the swap step", () => {
    const mid = deployProgress({ step: 3, liveVersion: "v4", nextVersion: "v5" });
    expect(mid.serving).toBe("v4");
    expect(mid.swapped).toBe(false);
    expect(mid.percent).toBe(60);
    expect(mid.label).toContain("v4");

    const swap = deployProgress({ step: 4, liveVersion: "v4", nextVersion: "v5" });
    expect(swap.serving).toBe("v5");
    expect(swap.swapped).toBe(true);
  });

  it("clamps a missing step to the upload step so a deploy never blanks the live build", () => {
    const progress = deployProgress({});
    expect(progress.step).toBe(3);
    expect(progress.serving).toBe("current");
  });
});
