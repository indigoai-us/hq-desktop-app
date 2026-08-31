/**
 * DEV-ONLY local session bypass — guard matrix.
 *
 * The synthetic local-dev session must be produced ONLY when BOTH guards are
 * on (`import.meta.env.DEV` AND `HQ_LOCAL_MESH === "1"`) and NEVER otherwise.
 * This is the safety contract that keeps the bypass impossible in production:
 * a production build has `dev === false` (statically), so the branch is gone,
 * and even in dev the explicit env flag must be exactly "1".
 */
import { describe, expect, it } from "vitest";

import {
  LOCAL_DEV_EMAIL,
  LOCAL_DEV_SUB,
  localDevSession,
} from "./local-dev-session";

describe("localDevSession", () => {
  it("produces the synthetic session ONLY when both guards are set", () => {
    const session = localDevSession({ dev: true, meshFlag: "1" });
    expect(session).not.toBeNull();
    expect(session?.sub).toBe(LOCAL_DEV_SUB);
    expect(session?.email).toBe(LOCAL_DEV_EMAIL);
    expect(session?.local).toBe(true);
    // Not-yet-expired so the auth gate treats it as live.
    expect(session!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns null when the env flag is absent (dev alone never bypasses)", () => {
    expect(localDevSession({ dev: true, meshFlag: undefined })).toBeNull();
  });

  it("returns null when the env flag is not exactly '1'", () => {
    expect(localDevSession({ dev: true, meshFlag: "0" })).toBeNull();
    expect(localDevSession({ dev: true, meshFlag: "true" })).toBeNull();
    expect(localDevSession({ dev: true, meshFlag: "" })).toBeNull();
  });

  it("returns null in a production build even with the env flag set", () => {
    // In prod `import.meta.env.DEV` is statically false; simulate that here.
    expect(localDevSession({ dev: false, meshFlag: "1" })).toBeNull();
  });

  it("returns null when neither guard is set", () => {
    expect(localDevSession({ dev: false, meshFlag: undefined })).toBeNull();
  });
});
