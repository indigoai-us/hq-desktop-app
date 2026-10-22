import { describe, expect, it } from "vitest";
import {
  askOwnerHint,
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

  it("review #1773: a member refused by a trial cap is not asked to add a card unless the state offers one", () => {
    const cap = { reason: "usage_trial_cap" as const, actionUrl: ACTION_URL };
    expect(usagePauseAction(cap, "member")).toEqual({ kind: "ask-owner", hint: "Ask a company owner or admin about billing." });
    expect(usagePauseAction(cap, "member", { cardOnFile: true, addCard: false })).toEqual({
      kind: "ask-owner",
      hint: "Ask a company owner or admin about billing.",
    });
    expect(usagePauseAction(cap, "member", { cardOnFile: false, addCard: true })).toEqual({
      kind: "ask-owner",
      hint: "Ask a company owner or admin to add a card on the Billing page.",
    });
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
  it("review #1773: a carded trial cap with resumesOn null says it resumes at the first paid invoice, with no date", () => {
    const context = { company: "Unicom", cardOnFile: true, addCard: false, resumesOn: null };
    const text = billingPauseMessage("usage_trial_cap", context);
    expect(text).toBe(
      "Cloud sync is paused. Unicom used the usage included in its trial. Usage resumes when the first invoice is paid. Files on this computer are not affected.",
    );
    expect(text).not.toMatch(/trial ends|add a card/i);
    // An owner or admin gets the Billing pointer; a member does not.
    expect(billingPauseMessage("usage_trial_cap", { ...context, canManageBilling: true })).toBe(
      "Cloud sync is paused. Unicom used the usage included in its trial. Usage resumes when the first invoice is paid. Open Billing for Unicom for details. Files on this computer are not affected.",
    );
    expect(billingPauseMessage("usage_trial_cap", { ...context, canManageBilling: false })).not.toContain("Open Billing");
    // The server message still wins.
    expect(billingPauseMessage("usage_trial_cap", { ...context, canManageBilling: true, message: "Server says." })).toBe("Server says.");
  });

  it("control: a pause that offers Add a card gets no extra Billing pointer", () => {
    const text = billingPauseMessage("usage_trial_cap", { company: "Unicom", cardOnFile: false, addCard: true, canManageBilling: true });
    expect(text).toContain("Add a card on the Billing page to resume.");
    expect(text).not.toContain("Open Billing for");
    expect(text).not.toContain("first invoice");
  });

  const trialEnd = "2026-11-15T13:00:00Z";
  const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  it("regression #1773: a capped trial with a card on file and no Add a card action says when it resumes, not to add a card", () => {
    const text = billingPauseMessage("usage_trial_cap", { company: "Unicom", cardOnFile: true, addCard: false, resumesOn: trialEnd });
    expect(text).not.toMatch(/add a card/i);
    expect(text).toContain(`Usage is paused until ${shortDate(trialEnd)}, when the trial ends.`);
    expect(text).toContain("Files on this computer are not affected.");
  });

  it("never asks for a card when actions.addCard is false or a card is on file", () => {
    for (const reason of ["usage_trial_cap", "usage_card_required"] as const) {
      expect(billingPauseMessage(reason, { addCard: false })).not.toMatch(/add a card/i);
      expect(billingPauseMessage(reason, { cardOnFile: true, addCard: true })).not.toMatch(/add a card/i);
    }
  });

  it("control: Add a card offered and no card on file keeps the add-card copy", () => {
    const text = billingPauseMessage("usage_trial_cap", { company: "Unicom", cardOnFile: false, addCard: true, resumesOn: null });
    expect(text).toBe(
      "Cloud sync is paused. Unicom used the usage included in its trial. Add a card on the Billing page to resume. Files on this computer are not affected.",
    );
  });

  it("control: the server usagePause.message wins over built copy", () => {
    const message = "Cloud sync is paused until Nov 15, when your trial ends.";
    expect(billingPauseMessage("usage_trial_cap", { company: "Unicom", cardOnFile: false, addCard: true, message })).toBe(message);
    expect(billingPauseMessage("usage_trial_cap", { company: "Unicom", message: "   " })).toContain("Unicom");
  });

  it("a spend-limit pause with a resume date says when it resumes and still offers the limit", () => {
    const text = billingPauseMessage("usage_spend_limit", { company: "Acme", resumesOn: "2026-11-01" });
    expect(text).toContain("Usage is paused until Nov 1.");
    expect(text).toContain("Raise the limit on the Billing page to resume sooner.");
  });

  it("never names a plan or an upgrade", () => {
    for (const reason of ["usage_trial_cap", "usage_card_required", "usage_spend_limit"] as const) {
      const text = billingPauseMessage(reason, { company: "Acme" });
      expect(text).toContain("Acme");
      expect(text).not.toMatch(/plan|upgrade|starter|workforce|individual/i);
    }
  });
});

describe("askOwnerHint with pause state", () => {
  it("control: a member is still asked to contact an owner or admin", () => {
    expect(askOwnerHint("usage_card_required")).toBe("Ask a company owner or admin to add a card on the Billing page.");
    expect(askOwnerHint("usage_trial_cap", { cardOnFile: false, addCard: true })).toBe("Ask a company owner or admin to add a card on the Billing page.");
    expect(askOwnerHint("usage_spend_limit")).toBe("Ask a company owner or admin to raise the spend limit.");
  });

  it("review #1773: with no pause state a trial cap hint is neutral, since a card may already be on file", () => {
    expect(askOwnerHint("usage_trial_cap")).toBe("Ask a company owner or admin about billing.");
    expect(askOwnerHint(null)).toBe("Ask a company owner or admin about billing.");
    expect(askOwnerHint("usage_card_required", { addCard: false })).toBe("Ask a company owner or admin about billing.");
  });

  it("does not ask an owner to add a card when one is on file or the pause has an end date", () => {
    expect(askOwnerHint("usage_trial_cap", { cardOnFile: true })).toBe("Ask a company owner or admin about billing.");
    expect(askOwnerHint("usage_trial_cap", { resumesOn: "2026-11-15T13:00:00Z" })).toBe("Ask a company owner or admin about billing.");
  });
});
