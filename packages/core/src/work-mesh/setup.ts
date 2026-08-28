/**
 * Pure "is this machine set up for Work Mesh?" decision.
 *
 * Desktop (Rust) and the web host both implement the same gate: after login,
 * if the local cache is not ready, show the Install + Sync card before the
 * shell. This module is the shared verdict so the two hosts cannot drift.
 *
 * Disk facts are supplied by the host (Node or Rust). This file never touches
 * the filesystem.
 */

export interface MeshDiskState {
  hasUpgradeMarker: boolean;
  hasHelper: boolean;
  hasPack: boolean;
  hasCache: boolean;
  hqRootValid: boolean;
}

export interface MeshSetupEnv {
  /** Vercel / any hosted runtime with no local ~/.hq. */
  hosted: boolean;
  /** Dev mock: pretend the cache is missing even when disk is ready. */
  forceSetup: boolean;
  /** Explicit skip (Playwright isolation, operator override). */
  skipSetup: boolean;
  /** This browser already finished setup this session. */
  sessionOk: boolean;
  /** Preview-server test harness (COGNITO_TEST_JWKS). */
  e2eHarness: boolean;
}

export interface MeshSetupDecision {
  needed: boolean;
  ready: boolean;
  canInstall: boolean;
  reason: string;
}

/** Cache is "set up properly" when the v2 marker, helper, and cache dir exist. */
export function isMeshCacheReady(disk: MeshDiskState): boolean {
  return disk.hasUpgradeMarker && disk.hasHelper && disk.hasCache;
}

export function evaluateMeshSetup(
  disk: MeshDiskState,
  env: MeshSetupEnv,
): MeshSetupDecision {
  const ready = isMeshCacheReady(disk);
  const canInstall = disk.hqRootValid && disk.hasPack;

  if (env.sessionOk) {
    return {
      needed: false,
      ready: true,
      canInstall,
      reason: "session-complete",
    };
  }
  if (env.forceSetup) {
    return { needed: true, ready: false, canInstall, reason: "forced" };
  }
  if (env.skipSetup || env.hosted || env.e2eHarness) {
    return {
      needed: false,
      ready,
      canInstall,
      reason: env.hosted ? "hosted" : env.skipSetup ? "skipped" : "e2e-harness",
    };
  }
  if (ready) {
    return { needed: false, ready: true, canInstall, reason: "ready" };
  }
  return { needed: true, ready: false, canInstall, reason: "not-installed" };
}
