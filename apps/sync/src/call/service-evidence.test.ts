/**
 * The bundled US-011 receipt is a build artifact with a shelf life.
 *
 * A receipt obtained by a running session can be refreshed by that session. A
 * BUNDLED one cannot: it ages with the shipped build, and every install of
 * this build shares its expiry. When it passes `BUNDLED_EVIDENCE_MAX_AGE_MS`
 * the calling gate closes — correctly, fail-closed — for everyone who has not
 * updated.
 *
 * So CI has to warn BEFORE that happens, not after. This test fails while the
 * bundled receipt is within `BUNDLED_EVIDENCE_REFRESH_WARNING_MS` of the
 * limit, which is the signal to run the refresh steps in `service-evidence.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateServiceEvidence } from "@hq/platform";

import {
  BUNDLED_EVIDENCE_MAX_AGE_MS,
  BUNDLED_EVIDENCE_REFRESH_WARNING_MS,
  SERVICE_EVIDENCE,
} from "./service-evidence";

const runAt = Date.parse((SERVICE_EVIDENCE as { runAt: string }).runAt);

function days(ms: number): string {
  return `${Math.round(ms / (24 * 60 * 60 * 1000))} days`;
}

describe("bundled service evidence lifetime", () => {
  it("is a well-formed, currently valid receipt under the bundled max age", () => {
    const result = validateServiceEvidence(SERVICE_EVIDENCE, {
      maxAgeMs: BUNDLED_EVIDENCE_MAX_AGE_MS,
    });
    expect(result.ok).toBe(true);
  });

  it("has not entered its refresh window — refresh it now if this fails", () => {
    const age = Date.now() - runAt;
    const remaining = BUNDLED_EVIDENCE_MAX_AGE_MS - age;
    expect(
      remaining,
      [
        `The bundled US-011 receipt expires in ${days(remaining)}.`,
        "When it does, desktop calling closes for every build that ships it.",
        "Re-run the US-011 staging proof and copy proof-receipt.json over",
        "apps/sync/src/call/service-evidence.json — see the file header.",
      ].join(" "),
    ).toBeGreaterThan(BUNDLED_EVIDENCE_REFRESH_WARNING_MS);
  });

  it("keeps the bundled window longer than the per-session default, and still closed", () => {
    // Longer, because a build cannot refresh itself...
    expect(BUNDLED_EVIDENCE_MAX_AGE_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(BUNDLED_EVIDENCE_MAX_AGE_MS).toBeGreaterThan(
      30 * 24 * 60 * 60 * 1000,
    );
    // ...but it is a lifetime, not a bypass: past the bound this still fails.
    const expired = validateServiceEvidence(SERVICE_EVIDENCE, {
      now: runAt + BUNDLED_EVIDENCE_MAX_AGE_MS + 1,
      maxAgeMs: BUNDLED_EVIDENCE_MAX_AGE_MS,
    });
    expect(expired.ok).toBe(false);
    expect(expired.ok === false && expired.code).toBe("EVIDENCE_STALE");
    // And it still refuses a receipt pinned to a different contract.
    const wrongContract = validateServiceEvidence(
      { ...(SERVICE_EVIDENCE as object), contractHash: "0".repeat(64) },
      { now: runAt + 1000, maxAgeMs: BUNDLED_EVIDENCE_MAX_AGE_MS },
    );
    expect(wrongContract.ok).toBe(false);
  });

  it("is passed at BOTH preflight call sites, so neither window drifts", () => {
    // The call window and the main window must agree on the lifetime; a bare
    // `preflight(SERVICE_EVIDENCE)` would silently inherit the 30-day default.
    const bootstrap = readFileSync(
      new URL("./bootstrap.ts", import.meta.url),
      "utf8",
    );
    expect(bootstrap).toContain("BUNDLED_EVIDENCE_MAX_AGE_MS");
    expect(bootstrap).toContain("maxAgeMs: BUNDLED_EVIDENCE_MAX_AGE_MS");

    const host = readFileSync(
      new URL("../desktop-alt/work-shell-capabilities.ts", import.meta.url),
      "utf8",
    );
    expect(host).toContain("evidenceMaxAgeMs: BUNDLED_EVIDENCE_MAX_AGE_MS");
  });
});
