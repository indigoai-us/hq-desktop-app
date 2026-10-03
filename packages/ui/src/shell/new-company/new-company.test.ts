import { describe, expect, it } from "vitest";
import {
  companySlugFromName,
  parseInviteEmails,
  pinnedIdsAfterFinish,
  railPreview,
  stepOneEffects,
} from "./new-company.js";

describe("new company flow (US-037)", () => {
  it("slugs the name and parses invite addresses", () => {
    expect(companySlugFromName("Holler Management")).toBe("holler-management");
    expect(parseInviteEmails("Chris@Holler.co, dana@holler.co dana@holler.co")).toEqual([
      "chris@holler.co",
      "dana@holler.co",
    ]);
  });

  it("hands a paid plan to Stripe checkout and does not create on that click", () => {
    const paid = stepOneEffects("workforce");
    expect(new URL(paid.checkoutUrl ?? "").hostname).toBe("checkout.stripe.com");
    expect(paid.createNow).toBe(false);
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
