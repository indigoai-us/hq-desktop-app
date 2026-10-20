import { describe, expect, it, vi } from "vitest";
import type { Json } from "@hq/platform";
import {
  accountGroups,
  cardOnFileFromSummary,
  oldPlanFromSummary,
  orderedAccounts,
  readAccountRow,
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
    expect(rowTotalText({ ...base, plan: "starter", planLabel: "Starter (free)", trial: null, usage: null })).toBe("No usage bill");
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
