import { describe, expect, it } from "vitest";

import { evaluateMeshSetup, isMeshCacheReady } from "./setup.js";

const readyDisk = {
  hasUpgradeMarker: true,
  hasHelper: true,
  hasPack: true,
  hasCache: true,
  hqRootValid: true,
};

const missingDisk = {
  hasUpgradeMarker: false,
  hasHelper: false,
  hasPack: true,
  hasCache: false,
  hqRootValid: true,
};

const live = {
  hosted: false,
  forceSetup: false,
  skipSetup: false,
  sessionOk: false,
  e2eHarness: false,
};

describe("isMeshCacheReady", () => {
  it("requires the upgrade marker, helper, and cache directory", () => {
    expect(isMeshCacheReady(readyDisk)).toBe(true);
    expect(isMeshCacheReady({ ...readyDisk, hasCache: false })).toBe(false);
    expect(isMeshCacheReady({ ...readyDisk, hasHelper: false })).toBe(false);
    expect(isMeshCacheReady({ ...readyDisk, hasUpgradeMarker: false })).toBe(
      false,
    );
  });
});

describe("evaluateMeshSetup", () => {
  it("gates first access when the local cache is not installed", () => {
    const verdict = evaluateMeshSetup(missingDisk, live);
    expect(verdict.needed).toBe(true);
    expect(verdict.ready).toBe(false);
    expect(verdict.canInstall).toBe(true);
    expect(verdict.reason).toBe("not-installed");
  });

  it("lets a ready machine through to the shell", () => {
    const verdict = evaluateMeshSetup(readyDisk, live);
    expect(verdict).toMatchObject({
      needed: false,
      ready: true,
      reason: "ready",
    });
  });

  it("FORCE_SETUP mocks a missing cache even when disk is ready", () => {
    const verdict = evaluateMeshSetup(readyDisk, { ...live, forceSetup: true });
    expect(verdict.needed).toBe(true);
    expect(verdict.ready).toBe(false);
    expect(verdict.reason).toBe("forced");
  });

  it("a completed session wins over FORCE_SETUP so dry-run can reach the shell", () => {
    const verdict = evaluateMeshSetup(readyDisk, {
      ...live,
      forceSetup: true,
      sessionOk: true,
    });
    expect(verdict.needed).toBe(false);
    expect(verdict.reason).toBe("session-complete");
  });

  it("never gates hosted Vercel or the Playwright harness", () => {
    expect(
      evaluateMeshSetup(missingDisk, { ...live, hosted: true }).needed,
    ).toBe(false);
    expect(
      evaluateMeshSetup(missingDisk, { ...live, e2eHarness: true }).needed,
    ).toBe(false);
    expect(
      evaluateMeshSetup(missingDisk, { ...live, skipSetup: true }).needed,
    ).toBe(false);
  });

  it("cannot install when the HQ tree or pack is missing", () => {
    const verdict = evaluateMeshSetup(
      { ...missingDisk, hqRootValid: false, hasPack: false },
      live,
    );
    expect(verdict.needed).toBe(true);
    expect(verdict.canInstall).toBe(false);
  });
});
