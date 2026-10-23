import { describe, expect, it, vi } from "vitest";
import {
  isUsageOnlySummary,
  readUsageBilling,
  statementFromBody,
  trialFromSummary,
  vaultCostCents,
} from "./usage-billing.js";
import {
  PRICING_FALLBACK,
  USAGE_PRICING_FALLBACK,
  boxLadder,
  boxRange,
  formatCardCents,
  formatCardUsd,
  freeList,
  pricingFromFeed,
} from "./usage-pricing.js";

const STATEMENT = {
  periodStart: "2026-10-01",
  asOf: "2026-10-14",
  complete: false,
  allowanceCents: 1000,
  usageCents: 1240,
  allowanceLeftCents: 0,
  billCents: 240,
  lines: [
    { key: "member-sync", displayName: "Sync", costCents: 900 },
    { key: "vault", displayName: "Vault", costCents: 500 },
    { key: "external-mcp-call", displayName: "External MCP call", costCents: null },
  ],
};

describe("usage pricing formatting", () => {
  it("prints amounts the way the card does", () => {
    expect([0.1, 0.05, 2, 0.5, 5, 10, 100, 800].map(formatCardUsd)).toEqual([
      "$0.10",
      "$0.05",
      "$2.00",
      "$0.50",
      "$5",
      "$10",
      "$100",
      "$800",
    ]);
    expect(formatCardCents(340)).toBe("$3.40");
    expect(formatCardCents(0)).toBe("$0.00");
    expect(boxRange(USAGE_PRICING_FALLBACK.boxes)).toBe("$100 to $800 a month");
    expect(boxLadder(USAGE_PRICING_FALLBACK.boxes)).toBe("small $100 · medium $200 · large $400 · xlarge $800");
    expect(freeList(USAGE_PRICING_FALLBACK.free)).toBe("Deploys, DMs and background AI");
  });

  it("keeps the bundled fallback equal to the locked card", () => {
    expect(USAGE_PRICING_FALLBACK.includedUsd).toBe(10);
    expect(USAGE_PRICING_FALLBACK.trial).toEqual({ days: 30, capUsd: 500 });
    expect(USAGE_PRICING_FALLBACK.meters.map((m) => [m.id, m.unitUsd])).toEqual([
      ["member-sync", 0.1],
      ["integration-call", 0.05],
      ["hq-mcp-call", 0.05],
      ["agent-run", 0.05],
      ["storage", 2],
      ["secret", 0.5],
      ["vault", 5],
    ]);
    expect(USAGE_PRICING_FALLBACK.boxes.map((b) => [b.size, b.instanceType, b.monthlyUsd])).toEqual([
      ["small", "t3.small", 100],
      ["medium", "t3.medium", 200],
      ["large", "t3.large", 400],
      ["xlarge", "t3.xlarge", 800],
    ]);
    expect(pricingFromFeed({ usage: USAGE_PRICING_FALLBACK, signup: PRICING_FALLBACK.signup })).toEqual({
      ...PRICING_FALLBACK,
      live: true,
    });
  });
});

describe("usage billing reads", () => {
  it("falls back to pricingPlan usage-only when the server sends no billingState", () => {
    expect(isUsageOnlySummary({ pricingPlan: "usage-only" })).toBe(true);
    expect(isUsageOnlySummary({ pricingPlan: "current" })).toBe(false);
    expect(isUsageOnlySummary({ plan: "usage" })).toBe(false);
    expect(isUsageOnlySummary(null)).toBe(false);
  });

  it("reads the trial standing and the month statement", () => {
    expect(trialFromSummary({ usageTrial: { status: "active", endsAt: "2026-11-15T13:00:00Z", capCents: 50000 } })).toEqual({
      status: "active",
      endsAt: "2026-11-15T13:00:00Z",
      capCents: 50000,
    });
    expect(trialFromSummary({ usageTrial: { status: "weird" } })).toBeNull();
    const statement = statementFromBody(STATEMENT)!;
    expect(statement).toMatchObject({ usageCents: 1240, allowanceLeftCents: 0, billCents: 240, complete: false });
    expect(vaultCostCents(statement)).toBe(500);
    expect(vaultCostCents({ ...statement, lines: [] })).toBeNull();
    expect(statementFromBody({ ...STATEMENT, usageCents: "12" })).toBeNull();
  });

  it("returns null without asking for the statement when the company is not usage-only", async () => {
    const source = {
      getBillingSummary: vi.fn(async () => ({ ok: true as const, value: { pricingPlan: "current" } })),
      getUsageStatement: vi.fn(),
    };
    expect(await readUsageBilling(source, "cmp_a")).toBeNull();
    expect(source.getUsageStatement).not.toHaveBeenCalled();
    expect(await readUsageBilling(source, null)).toBeNull();
    expect(await readUsageBilling({}, "cmp_a")).toBeNull();
  });

  it("reads statement and live pricing for a usage-only company, and keeps going when either fails", async () => {
    const live = { usage: { ...USAGE_PRICING_FALLBACK, includedUsd: 12 }, signup: PRICING_FALLBACK.signup };
    const view = await readUsageBilling(
      {
        getBillingSummary: async () => ({ ok: true as const, value: { pricingPlan: "usage-only" } }),
        getUsageStatement: async () => ({ ok: true as const, value: STATEMENT }),
        getPricing: async () => ({ ok: true as const, value: live }),
      },
      "cmp_a",
    );
    expect(view?.pricing.includedUsd).toBe(12);
    expect(view?.statement?.usageCents).toBe(1240);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const degraded = await readUsageBilling(
      {
        getBillingSummary: async () => ({ ok: true as const, value: { pricingPlan: "usage-only" } }),
        getUsageStatement: async () => {
          throw new Error("offline");
        },
        getPricing: async () => {
          throw new Error("offline");
        },
      },
      "cmp_a",
    );
    expect(degraded?.statement).toBeNull();
    expect(degraded?.pricing).toBe(USAGE_PRICING_FALLBACK);
    warn.mockRestore();
  });
});

describe("billingState (US-024)", () => {
  const usageTrialState = {
    version: 1,
    scope: "company",
    kind: "usage-trial",
    view: "full",
    trial: { daysLeft: 12, endsAt: "2026-11-03T00:00:00.000Z", capCents: 2500, usedCents: 120 },
    paused: null,
  };

  it("Desktop uses shared status when legacy pricingPlan conflicts (acceptance RED)", () => {
    expect(
      isUsageOnlySummary({ pricingPlan: "current", billingState: { version: 1, kind: "usage-trial", scope: "company", view: "full" } }),
    ).toBe(true);
    expect(isUsageOnlySummary({ pricingPlan: "usage-only", billingState: { version: 1, kind: "legacy-free", scope: "company", view: "full" } })).toBe(false);
  });

  it("ignores a billingState it cannot read and keeps the pricingPlan fallback", () => {
    expect(isUsageOnlySummary({ pricingPlan: "usage-only", billingState: { version: 2, kind: "usage" } })).toBe(true);
    expect(isUsageOnlySummary({ pricingPlan: "current", billingState: { version: 1, kind: "starter" } })).toBe(false);
  });

  it("reads the trial from billingState over a conflicting legacy record", () => {
    expect(trialFromSummary({ billingState: usageTrialState, usageTrial: { status: "ended", endsAt: null, capCents: null } })).toEqual({
      status: "active",
      endsAt: "2026-11-03T00:00:00.000Z",
      capCents: 2500,
    });
    expect(
      trialFromSummary({ billingState: { ...usageTrialState, kind: "usage", trial: null }, usageTrial: { status: "active", endsAt: "x", capCents: 1 } }),
    ).toBeNull();
  });

  it("carries the plan status and its pause into the view", async () => {
    const paused = { ...usageTrialState, kind: "usage", trial: null, paused: { reason: "usage_card_required", resumesOn: null } };
    const view = await readUsageBilling(
      {
        getBillingSummary: async () => ({ ok: true as const, value: { pricingPlan: "current", billingState: paused } }),
        getUsageStatement: async () => ({ ok: true as const, value: STATEMENT }),
      },
      "cmp_a",
    );
    expect(view?.billingState?.kind).toBe("usage");
    expect(view?.paused).toEqual({ reason: "usage_card_required", resumesOn: null });
  });
});
