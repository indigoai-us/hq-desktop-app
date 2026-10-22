import { describe, expect, it } from "vitest";
import {
  billingPauseMessage,
  isUsagePricedRecord,
  parseBillingState,
  parseUsagePause,
  roleCanManageBilling,
  usagePauseAction,
} from "./billing-state.js";
import { hqProFailure, parseHqProErrorBody } from "./plan-limit.js";

const ACTION_URL = "https://hq.computer/companies/acme/billing";
const USAGE_MESSAGE =
  "Cloud sync is paused. Acme used its $10.00 monthly allowance. Add a card on the Billing page to resume. Files on this computer are not affected.";

/** The hq-pro 402 for a usage pause: legacy plan-limit fields plus `usagePause`. */
function usagePauseBody(reason = "usage_card_required"): Record<string, unknown> {
  return {
    error: "plan_limit_reached",
    code: "PLAN_LIMIT_EXCEEDED",
    status: 402,
    blocked: "files.create",
    reason,
    resources: [],
    message: "New files are paused by your plan limit.",
    upgradeUrl: ACTION_URL,
    usagePause: { code: "usage_paused", reason, message: USAGE_MESSAGE, actionUrl: ACTION_URL },
  };
}

describe("parseBillingState", () => {
  it("reads a full v1 block", () => {
    const state = parseBillingState({
      version: 1,
      scope: "company",
      kind: "usage-trial",
      view: "full",
      trial: { daysLeft: 9, endsAt: "2026-11-01T00:00:00.000Z", capCents: 2500, usedCents: 300 },
      spendLimit: { cents: null },
      cardOnFile: false,
      cardPrompt: true,
      paused: { reason: "usage_card_required", resumesOn: null },
      actions: { addCard: true, raiseLimit: false, switchToUsage: false, manageBilling: false },
    });
    expect(state).toMatchObject({
      kind: "usage-trial",
      view: "full",
      trial: { daysLeft: 9, capCents: 2500, usedCents: 300 },
      paused: { reason: "usage_card_required", resumesOn: null },
      actions: { addCard: true },
      cardPrompt: true,
    });
  });

  it("fills safe defaults for a sparse block", () => {
    expect(parseBillingState({ version: 1, kind: "usage", scope: "company", view: "member" })).toEqual({
      version: 1,
      scope: "company",
      kind: "usage",
      view: "member",
      trial: null,
      spendLimit: null,
      cardOnFile: null,
      cardPrompt: false,
      paused: null,
      actions: { addCard: false, raiseLimit: false, switchToUsage: false, manageBilling: false },
    });
  });

  it("rejects other versions, unknown kinds and non-objects", () => {
    expect(parseBillingState({ version: 2, kind: "usage" })).toBeNull();
    expect(parseBillingState({ version: 1, kind: "workforce" })).toBeNull();
    expect(parseBillingState("usage")).toBeNull();
    expect(parseBillingState(null)).toBeNull();
  });

  it("drops an unknown pause reason instead of guessing", () => {
    expect(parseBillingState({ version: 1, kind: "usage", paused: { reason: "later_reason" } })?.paused).toBeNull();
  });
});

describe("isUsagePricedRecord", () => {
  it("billingState wins over a conflicting pricingPlan (US-024 acceptance)", () => {
    expect(
      isUsagePricedRecord({
        pricingPlan: "current",
        billingState: { version: 1, kind: "usage-trial", scope: "company", view: "full" },
      }),
    ).toBe(true);
    expect(
      isUsagePricedRecord({
        pricingPlan: "usage-only",
        billingState: { version: 1, kind: "legacy-payer", scope: "company", view: "full" },
      }),
    ).toBe(false);
  });

  it("falls back to pricingPlan on a server without billingState", () => {
    expect(isUsagePricedRecord({ pricingPlan: "usage-only" })).toBe(true);
    expect(isUsagePricedRecord({ pricingPlan: "current" })).toBe(false);
    expect(isUsagePricedRecord({ pricingPlan: "usage-only", billingState: { version: 9 } })).toBe(true);
    expect(isUsagePricedRecord(null)).toBe(false);
  });
});

describe("parseUsagePause", () => {
  it("accepts the hq-pro block", () => {
    expect(parseUsagePause(usagePauseBody().usagePause)).toEqual({
      code: "usage_paused",
      reason: "usage_card_required",
      message: USAGE_MESSAGE,
      actionUrl: ACTION_URL,
    });
  });

  it("rejects an unknown code, reason, empty message or unapproved link", () => {
    const base = { code: "usage_paused", reason: "usage_spend_limit", message: "m", actionUrl: ACTION_URL };
    expect(parseUsagePause({ ...base, code: "PLAN_LIMIT_EXCEEDED" })).toBeNull();
    expect(parseUsagePause({ ...base, reason: "later" })).toBeNull();
    expect(parseUsagePause({ ...base, message: " " })).toBeNull();
    expect(parseUsagePause({ ...base, actionUrl: "https://evil.example/billing" })).toBeNull();
    expect(parseUsagePause({ ...base, actionUrl: "https://user:pw@hq.computer/billing" })).toBeNull();
    expect(parseUsagePause({ ...base, actionUrl: "http://hq.computer/billing" })).toBeNull();
  });
});

describe("usagePauseAction", () => {
  const pause = { reason: "usage_card_required" as const, actionUrl: ACTION_URL };

  it("gives owners, admins and unknown roles the Billing link", () => {
    for (const role of ["Owner", "admin", null, undefined, ""]) {
      expect(usagePauseAction(pause, role)).toEqual({ kind: "billing", label: "Open Billing", url: ACTION_URL });
    }
  });

  it("asks a member to contact an owner", () => {
    expect(usagePauseAction(pause, "Member")).toEqual({
      kind: "ask-owner",
      hint: "Ask a company owner or admin to add a card on the Billing page.",
    });
    expect(usagePauseAction({ ...pause, reason: "usage_spend_limit" }, "member")).toEqual({
      kind: "ask-owner",
      hint: "Ask a company owner or admin to raise the spend limit.",
    });
    expect(roleCanManageBilling("guest")).toBe(false);
  });
});

describe("usage pause on an hq-pro refusal", () => {
  it("shows the usage message and Billing link, not the plan-limit sentence", () => {
    const details = parseHqProErrorBody(402, JSON.stringify(usagePauseBody()), "fallback");
    expect(details.message).toBe(USAGE_MESSAGE);
    expect(details.upgradeUrl).toBe(ACTION_URL);
    expect(details.planLimit).toBe(true);
    expect(details.usagePause?.reason).toBe("usage_card_required");
    const failure = hqProFailure(details);
    expect(failure.usagePause?.actionUrl).toBe(ACTION_URL);
    expect(failure.message).not.toMatch(/plan limit|Upgrade|Starter|Workforce|Individual/i);
  });

  it("keeps the legacy plan-limit reading when the block is invalid", () => {
    const body = { ...usagePauseBody(), usagePause: { code: "usage_paused", reason: "later" } };
    const details = parseHqProErrorBody(402, JSON.stringify(body), "fallback");
    expect(details.usagePause).toBeUndefined();
    expect(details.message).toBe("New files are paused by your plan limit.");
  });
});

describe("billingPauseMessage", () => {
  it("never names a plan or an upgrade", () => {
    for (const reason of ["usage_trial_cap", "usage_card_required", "usage_spend_limit"] as const) {
      const text = billingPauseMessage(reason, "Acme");
      expect(text).toContain("Acme");
      expect(text).not.toMatch(/plan|upgrade|starter|workforce|individual/i);
    }
  });
});
