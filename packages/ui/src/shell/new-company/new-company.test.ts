import { describe, expect, it } from "vitest";
import {
  NEW_COMPANY_PLANS,
  companySlugFromName,
  parseInviteEmails,
  pinnedIdsAfterFinish,
  projectSlugFromName,
  railPreview,
  stepOneEffects,
} from "./new-company.js";

describe("new company flow (US-037)", () => {
  it("slugs the name and parses invite addresses", () => {
    expect(companySlugFromName("Holler Management")).toBe("holler-management");
    // The slug is sent on create, so it follows the server's rule
    // (hq-pro COMPANY_SLUG_RE): a letter first, at most 30 long.
    const serverRule = /^[a-z][a-z0-9-]{0,29}$/;
    for (const name of ["42 Labs", "StefanTest123", "The Very Long Company Name of Many Words Incorporated", "Café Olé"]) {
      const slug = companySlugFromName(name);
      expect(serverRule.test(slug), `${name} -> ${slug}`).toBe(true);
    }
    expect(companySlugFromName("42 Labs")).toBe("labs");
    expect(companySlugFromName("x".repeat(80))).toHaveLength(30);
    expect(companySlugFromName("123")).toBe("");
    // Project folders keep their own rule: a leading number stays.
    expect(projectSlugFromName("2024 Launch")).toBe("2024-launch");
    expect(projectSlugFromName("!!!")).toBeNull();
    expect(parseInviteEmails("Chris@Holler.co, dana@holler.co dana@holler.co")).toEqual([
      "chris@holler.co",
      "dana@holler.co",
    ]);
  });

  it("offers only usage pricing and always creates in-app, never checkout", () => {
    expect(NEW_COMPANY_PLANS.map((plan) => plan.id)).toEqual(["free"]);
    expect(NEW_COMPANY_PLANS[0]!.detail).toBe("$10 of usage included every month. 30-day trial, usage capped at $500.");
    expect(JSON.stringify(NEW_COMPANY_PLANS)).not.toMatch(/Workforce/);
    expect(stepOneEffects("free")).toEqual({ checkoutUrl: null, createNow: true });
  });

  it("pins the new company when the rail has room", () => {
    expect(pinnedIdsAfterFinish(["a", "b"], "c", true)).toEqual(["a", "b", "c"]);
    expect(pinnedIdsAfterFinish(["a", "b", "c", "d", "e", "f"], "g", true)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(pinnedIdsAfterFinish(["a"], "c", false)).toEqual(["a"]);
  });

  it("previews the new tile in the next open slot", () => {
    const slots = railPreview(["IN", "LR"], "HM", true);
    expect(slots.map((slot) => slot.kind)).toEqual([
      "existing",
      "existing",
      "new",
      "empty",
      "empty",
      "empty",
    ]);
    expect(slots[2]?.initials).toBe("HM");
  });
});
