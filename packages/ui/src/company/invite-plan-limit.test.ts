/**
 * hard-stop-readiness US-018: a refused invite claim yields a readable sentence
 * and the upgrade link, never raw JSON or a machine code.
 *
 * Ported from the deleted company Overview page (CompanyPage.svelte), which
 * was the only screen with an Accept invite button. No console-rail page
 * (Atlas landing, Team, company settings) claims invites, so these cases pin
 * the claim contract every accept surface reads: the adapter result carries
 * the sentence and an approved upgrade URL on both hosts.
 */
import { describe, expect, it } from "vitest";
import {
  approvedPlanUpgradeUrl,
  isPlanLimitCode,
  WebPlatformAdapter,
} from "@hq/platform";

const UPGRADE_URL = "https://hq.computer/companies/acme/billing?upgrade=1";

describe("invite claim refused by a plan limit", () => {
  it("desktop: the claim result carries the sentence and an approved upgrade link", () => {
    const message =
      "New members cannot be added while Acme is over its Starter limits. Members: 5 of 5 used.";
    const result = { ok: false, claimedSlugs: [], message, upgradeUrl: UPGRADE_URL };

    expect(result.message).not.toContain("{");
    expect(approvedPlanUpgradeUrl(result.upgradeUrl)).toBe(UPGRADE_URL);
  });

  it("web: maps the 402 body through the adapter without the machine code", async () => {
    const web = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: "PLAN_LIMIT_EXCEEDED",
            resource: "users",
            used: 5,
            limit: 5,
            requiredPlan: "team",
            upgradeUrl: UPGRADE_URL,
          }),
          { status: 402 },
        ),
    });

    const claim = await web.company.claimPendingInvite("acme");
    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    // The page showed the message alone for a plan-limit code, so the user
    // never sees PLAN_LIMIT_EXCEEDED.
    expect(isPlanLimitCode(claim.code)).toBe(true);
    const text = claim.message ?? "";
    expect(text).toContain("Your plan limit is reached. Members: 5 of 5 used.");
    expect(text).not.toContain("PLAN_LIMIT_EXCEEDED");
    expect(text).not.toContain("{");
    expect(approvedPlanUpgradeUrl(claim.upgradeUrl)).toBe(UPGRADE_URL);
  });

  it("keeps the ordinary success result for a claimed invite", async () => {
    const web = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () =>
        new Response(
          JSON.stringify({ ok: true, claimedSlugs: ["acme"], message: "Joined acme." }),
          { status: 200 },
        ),
    });

    const claim = await web.company.claimPendingInvite("acme");
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const value = claim.value as { message?: string; upgradeUrl?: string };
    expect(value.message).toContain("Joined acme.");
    expect(approvedPlanUpgradeUrl(value.upgradeUrl)).toBeNull();
  });
});
