import { describe, expect, it, vi } from "vitest";
import type { Json } from "@hq/platform";
import {
  accountGroups,
  accountTrial,
  cardOnFileFromSummary,
  oldPlanFromSummary,
  orderedAccounts,
  readAccountRow,
  readSpendLimit,
  readSwitchState,
  rowTotalText,
  switchAccountToUsage,
  switchOutcomeText,
  switchStateFromBody,
} from "./usage-accounts-model";

const ok = (value: unknown) => ({ ok: true as const, value: value as Json });
const fail = (code: string) => ({ ok: false as const, reason: "error" as const, code, message: code });

describe("plan and card from a summary", () => {
  it("tells an older paid plan from the older free plan", () => {
    expect(oldPlanFromSummary({ plan: "team" })).toBe("legacy");
    expect(oldPlanFromSummary({ subscriptionStatus: "active" })).toBe("legacy");
    expect(oldPlanFromSummary({ subscriptionStatus: "canceled" })).toBe("starter");
    expect(oldPlanFromSummary({})).toBe("starter");
  });

  it("reads the card from the trial, the person summary or the payment method", () => {
    expect(cardOnFileFromSummary({ usageTrial: { cardOnFile: true } })).toBe(true);
    expect(cardOnFileFromSummary({ personalUsage: { cardOnFile: false } })).toBe(false);
    expect(cardOnFileFromSummary({ defaultPaymentMethod: { present: true } })).toBe(true);
    expect(cardOnFileFromSummary({})).toBeNull();
  });
});

describe("account lines", () => {
  it("orders Personal first, then companies by name", () => {
    const out = orderedAccounts([
      { kind: "company", uid: "b", name: "Beta", role: "owner" },
      { kind: "personal", uid: null, name: "Personal", role: null },
      { kind: "company", uid: "a", name: "Alpha", role: "admin" },
    ]);
    expect(out.map((a) => a.name)).toEqual(["Personal", "Alpha", "Beta"]);
  });

  it("groups meters into the three groups and keeps unknown meters under Other usage", () => {
    const groups = accountGroups(
      [
        { key: "agent-run", displayName: "Agent run", unit: "run", unitCents: 5, costCents: 300, billed: true },
        { key: "hq-mcp-call", displayName: "HQ MCP call", unit: "call", unitCents: 5, costCents: null, billed: true },
        { key: "member-sync", displayName: "Sync", unit: "sync", unitCents: 10, costCents: 120, billed: true },
        { key: "new-meter", displayName: "New", costCents: 50, billed: true },
        { key: "old", costCents: 900, billed: false },
      ],
      null,
    );
    expect(groups.map((g) => [g.id, g.cents, g.partial])).toEqual([
      ["agents", 300, true],
      ["sync", 120, false],
      ["other", 50, false],
    ]);
    expect(groups[0]!.meters[0]!.rate).toBe("$0.05 per run");
  });

  it("a non-owner company is owner-only with no request; a 403 is too", async () => {
    const getBillingSummary = vi.fn(async () => fail("FORBIDDEN"));
    expect(await readAccountRow({ getBillingSummary }, { kind: "company", uid: "c", name: "C", role: "admin" })).toEqual({ kind: "owner-only" });
    expect(getBillingSummary).not.toHaveBeenCalled();
    expect(await readAccountRow({ getBillingSummary }, { kind: "company", uid: "c", name: "C", role: "owner" })).toEqual({ kind: "owner-only" });
  });

  it("totals: usage, partial, trial, old plans and failures", () => {
    const base = { kind: "ready" as const, cardOnFile: null, notice: null, usageUnavailable: false };
    const usage = { periodStart: "2026-10-01", periodEnd: null, usageCents: 800, allowanceCents: 1000, allowanceLeftCents: 200, projectedBillCents: null, groups: [], lines: [] };
    expect(rowTotalText({ ...base, plan: "usage", planLabel: "Usage plan", trial: null, usage: { ...usage, complete: true } })).toBe("$8.00");
    expect(rowTotalText({ ...base, plan: "usage", planLabel: "Usage plan", trial: null, usage: { ...usage, complete: false } })).toBe("At least $8.00");
    expect(
      rowTotalText({ ...base, plan: "trial", planLabel: "Trial", trial: { endsAt: "x", daysLeft: 3, capCents: 50000, usedCents: 12000, unknownMeters: ["vault"] }, usage: null }),
    ).toBe("At least $120.00");
    expect(rowTotalText({ ...base, plan: "starter", planLabel: "Free plan", trial: null, usage: null })).toBe("No usage bill");
    expect(rowTotalText({ kind: "owner-only" })).toBe("Owner only");
    expect(rowTotalText({ kind: "unavailable" })).toBe("Unavailable");
    expect(rowTotalText(undefined)).toBe("…");
    // An unreported group makes the total a floor, the same rule as the Core menu.
    const partialGroup = [{ id: "agents", label: "Agents and AI", cents: null, partial: true, meters: [] }];
    expect(rowTotalText({ ...base, plan: "usage", planLabel: "Usage plan", trial: null, usage: { ...usage, complete: true, groups: partialGroup } })).toBe("At least $8.00");
    // A trial whose usage isn't measured never falls back to the month's $0.
    expect(
      rowTotalText({ ...base, plan: "trial", planLabel: "Trial", trial: { endsAt: "x", daysLeft: 3, capCents: 50000, usedCents: null }, usage: { ...usage, usageCents: 0, complete: true } }),
    ).toBe("Not measured");
  });
});

describe("switch to usage pricing", () => {
  it("maps the GET body to what the line offers", () => {
    expect(switchStateFromBody({ enabled: true, cardOnFile: true, offer: { eligible: true, freeOptIn: true } })).toEqual({ kind: "offered" });
    expect(switchStateFromBody({ enabled: true, cardOnFile: false, offer: { eligible: true } })).toEqual({ kind: "card-required" });
    expect(switchStateFromBody({ enabled: true, offer: { eligible: false, reason: "card-required" } })).toEqual({ kind: "card-required" });
    expect(switchStateFromBody({ enabled: true, offer: { eligible: false, reason: "already-on-usage" } })).toEqual({ kind: "switched" });
    expect(switchStateFromBody({ enabled: false, offer: { eligible: false, reason: "flag-off" } })).toEqual({ kind: "not-available" });
    expect(switchStateFromBody({ enabled: true, offer: { eligible: false, reason: "not-paying" } })).toEqual({ kind: "not-available" });
    expect(switchStateFromBody({ enabled: true, offer: { eligible: false, reason: "sponsored" } })).toMatchObject({ kind: "refused", reason: "sponsored" });
    expect(switchStateFromBody(null)).toEqual({ kind: "not-available" });
  });

  it("POST outcomes: switched, refused (with the reason re-read), conflict, missing route, failure", async () => {
    const company = { kind: "company" as const, uid: "cmp_a", name: "A", role: "owner" };
    expect(await switchAccountToUsage({ switchToUsagePricing: vi.fn(async () => ok({ outcome: "switched" })) }, company)).toEqual({ kind: "switched" });
    const refused = await switchAccountToUsage(
      {
        switchToUsagePricing: vi.fn(async () => fail("USAGE_SWITCH_NOT_OFFERED")),
        getUsageSwitch: vi.fn(async () => ok({ enabled: true, offer: { eligible: false, reason: "card-required" } })),
      },
      company,
    );
    expect(refused).toEqual({ kind: "refused", state: { kind: "card-required" } });
    expect(switchOutcomeText(refused)).toBe("Add a card first, then switch.");
    expect(await switchAccountToUsage({ switchToUsagePricing: vi.fn(async () => fail("USAGE_SWITCH_CONFLICT")) }, company)).toEqual({ kind: "conflict" });
    expect(await switchAccountToUsage({ switchToUsagePricing: vi.fn(async () => fail("http-404")) }, company)).toEqual({ kind: "not-available" });
    expect(await switchAccountToUsage({}, company)).toEqual({ kind: "not-available" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await switchAccountToUsage({ switchToUsagePricing: vi.fn(async () => fail("http-500")) }, company)).toEqual({ kind: "failed" });
    const person = { kind: "personal" as const, uid: null, name: "Personal", role: null };
    const switchPersonalToUsagePricing = vi.fn(async () => ok({ outcome: "switched" }));
    expect(await switchAccountToUsage({ switchPersonalToUsagePricing }, person)).toEqual({ kind: "switched" });
    expect(switchPersonalToUsagePricing).toHaveBeenCalledTimes(1);
  });
});

describe("quiet retries on the Settings > Usage reads (review, 2026-10-20)", () => {
  const owner = { kind: "company" as const, uid: "cmp_a", name: "A", role: "owner" };
  const noWait = async () => {};

  it("a line read tries again after each delay and settles on the recovered body", async () => {
    const getBillingSummary = vi
      .fn()
      .mockResolvedValueOnce(fail("http-500"))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(ok({ pricingPlan: "current", plan: "team", subscriptionStatus: "active" }));
    const view = await readAccountRow({ getBillingSummary }, owner, null, () => new Date(), { delays: [1, 1], sleep: noWait });
    expect(getBillingSummary).toHaveBeenCalledTimes(3);
    expect(view).toMatchObject({ kind: "ready", plan: "legacy" });
  });

  it("a line read gives up after the last delay", async () => {
    const getBillingSummary = vi.fn(async () => fail("http-500"));
    const view = await readAccountRow({ getBillingSummary }, owner, null, () => new Date(), { delays: [1, 1], sleep: noWait });
    expect(getBillingSummary).toHaveBeenCalledTimes(3);
    expect(view).toEqual({ kind: "unavailable" });
  });

  it("a 403 is an answer, not a failure: no retry", async () => {
    const getBillingSummary = vi.fn(async () => ({ ok: false as const, reason: "error" as const, code: "FORBIDDEN", status: 403, message: "forbidden" }));
    const view = await readAccountRow({ getBillingSummary }, owner, null, () => new Date(), { delays: [1, 1], sleep: noWait });
    expect(getBillingSummary).toHaveBeenCalledTimes(1);
    expect(view).toEqual({ kind: "owner-only" });
  });

  it("the spend limit and the switch offer retry the same way", async () => {
    const getSpendLimit = vi.fn().mockResolvedValueOnce(fail("http-500")).mockResolvedValueOnce(ok({ limitCents: 2500, custom: true, paused: false }));
    const limit = await readSpendLimit({ getSpendLimit }, owner, { delays: [1], sleep: noWait });
    expect(getSpendLimit).toHaveBeenCalledTimes(2);
    expect(limit).toMatchObject({ limitCents: 2500 });

    const getUsageSwitch = vi
      .fn()
      .mockResolvedValueOnce(fail("http-500"))
      .mockResolvedValueOnce(ok({ enabled: true, phase: "none", cardOnFile: true, offer: { eligible: true, freeOptIn: true } }));
    const state = await readSwitchState({ getUsageSwitch }, owner, { delays: [1], sleep: noWait });
    expect(getUsageSwitch).toHaveBeenCalledTimes(2);
    expect(state.kind).not.toBe("not-available");
  });

  it("with no delays a failure is reported after one try", async () => {
    const getSpendLimit = vi.fn(async () => fail("http-500"));
    expect(await readSpendLimit({ getSpendLimit }, owner, { delays: [] })).toBeNull();
    expect(getSpendLimit).toHaveBeenCalledTimes(1);
  });
});

describe("billingState wins on account lines (US-024)", () => {
  const NOW = new Date("2026-10-22T12:00:00.000Z");
  const owner = { kind: "company" as const, uid: "cmp_a", name: "Acme", role: "owner" };
  const state = (kind: string, extra: Record<string, unknown> = {}) => ({ version: 1, scope: "company", view: "full", kind, ...extra });

  it("a usage-trial billingState shows the trial even when pricingPlan says current", async () => {
    const getBillingSummary = vi.fn(async () =>
      ok({ pricingPlan: "current", billingState: state("usage-trial", { trial: { daysLeft: 5, endsAt: "2026-10-27T00:00:00.000Z", capCents: 2500, usedCents: 100 } }) }),
    );
    const view = await readAccountRow({ getBillingSummary }, owner, null, () => NOW);
    expect(view).toMatchObject({ kind: "ready", plan: "trial" });
    expect(view.kind === "ready" && view.planLabel).not.toMatch(/Starter|Workforce|Individual/);
  });

  it("a legacy billingState keeps the older plan line even when pricingPlan says usage-only", async () => {
    const getBillingSummary = vi.fn(async () => ok({ pricingPlan: "usage-only", billingState: state("legacy-free") }));
    expect(await readAccountRow({ getBillingSummary }, owner, null, () => NOW)).toMatchObject({ kind: "ready", plan: "starter", planLabel: "Free plan" });
    expect(oldPlanFromSummary({ billingState: state("legacy-payer") })).toBe("legacy");
    expect(oldPlanFromSummary({ plan: "team", billingState: state("legacy-free") })).toBe("starter");
  });

  it("a usage kind without a trial ignores an older active usageTrial", () => {
    expect(accountTrial({ billingState: state("usage"), usageTrial: { status: "active", endsAt: "2026-10-30T00:00:00.000Z" } }, NOW)).toBeNull();
    expect(accountTrial({ usageTrial: { status: "active", endsAt: "2026-10-30T00:00:00.000Z" } }, NOW)?.daysLeft).toBe(8);
  });

  it("a person summary with a usage billingState reads as usage without a personalUsage record", async () => {
    const getPersonalBillingSummary = vi.fn(async () => ok({ billingState: { ...state("usage"), scope: "person" } }));
    const view = await readAccountRow({ getPersonalBillingSummary }, { kind: "personal", uid: null, name: "Personal", role: null } as never, null, () => NOW);
    expect(view).toMatchObject({ kind: "ready", plan: "usage" });
  });
});
