import { afterEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@hq/platform";
import {
  OTHER_USAGE_LABEL,
  __resetCoreUsageCacheForTests,
  billingIsSetUp,
  cachedCoreUsage,
  groupAmount,
  groupUsageLines,
  meterView,
  monthStatementFromBody,
  planLabelFromSummary,
  readCoreUsage,
  rememberCoreUsage,
  resetLine,
  type UsageLine,
} from "./core-usage-model";

const ok = (value: unknown) => ({ ok: true as const, value: value as Json });
const fail = (code: string) => ({ ok: false as const, reason: "error" as const, code, message: code });

/** A month statement shaped like hq-pro's GET /v1/billing/usage body. */
function statementBody(overrides: Record<string, unknown> = {}) {
  return {
    scope: "company",
    ownerUid: "cmp_northwind",
    window: "month",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    daysInPeriod: 31,
    daysElapsed: 16,
    complete: true,
    allowanceCents: 1000,
    usageCents: 800,
    allowanceLeftCents: 200,
    billCents: 0,
    lines: [
      { key: "member-sync", status: "measured", billed: true, costCents: 40 },
      { key: "integration-call", status: "measured", billed: true, costCents: 200 },
      { key: "hq-mcp-call", status: "measured", billed: true, costCents: 0 },
      { key: "agent-run", status: "measured", billed: true, costCents: 310 },
      { key: "storage", status: "measured", billed: true, costCents: 50 },
      { key: "secret", status: "measured", billed: true, costCents: 10 },
      { key: "vault", status: "measured", billed: true, costCents: 0, waived: true },
    ],
    ...overrides,
  };
}

const line = (key: string, costCents: number | null, extra: Partial<UsageLine> = {}): UsageLine => ({
  key,
  status: costCents === null ? "unavailable" : "measured",
  billed: true,
  costCents,
  ...extra,
});

afterEach(() => {
  __resetCoreUsageCacheForTests();
  vi.restoreAllMocks();
});

describe("meter mapping", () => {
  it("groups the rate card's meters under the plain labels, in display order", () => {
    const rows = groupUsageLines(monthStatementFromBody(statementBody())!.lines);
    expect(rows.map((r) => [r.label, r.amount])).toEqual([
      ["Assistant and bots", { kind: "amount", cents: 510, partial: false }],
      ["Storage and sync", { kind: "amount", cents: 100, partial: false }],
    ]);
  });

  it("shows Meeting notes only when hq-pro reports a meeting meter", () => {
    expect(groupUsageLines([line("agent-run", 5)]).some((r) => r.id === "meetings")).toBe(false);
    const rows = groupUsageLines([line("agent-run", 5), line("meeting-note", 190)]);
    expect(rows.map((r) => r.label)).toEqual(["Assistant and bots", "Meeting notes"]);
  });

  it("keeps an unknown meter under Other usage instead of dropping it", () => {
    const rows = groupUsageLines([line("agent-run", 5), line("box-hour", 700)]);
    expect(rows.at(-1)).toEqual({ id: "other", label: OTHER_USAGE_LABEL, amount: { kind: "amount", cents: 700, partial: false } });
  });

  it("leaves unbilled meters out of every row", () => {
    expect(groupUsageLines([line("ext-mcp-call", 900, { billed: false })])).toEqual([]);
  });
});

describe("not reported is not $0", () => {
  it("a group with no measured meter is not reported", () => {
    expect(groupAmount([line("agent-run", null), line("hq-mcp-call", null)])).toEqual({ kind: "not-reported" });
  });

  it("a measured $0 is an amount of 0", () => {
    expect(groupAmount([line("agent-run", 0)])).toEqual({ kind: "amount", cents: 0, partial: false });
  });

  it("a group with some meters missing sums the measured ones and flags partial", () => {
    expect(groupAmount([line("agent-run", 120), line("hq-mcp-call", null)])).toEqual({ kind: "amount", cents: 120, partial: true });
    expect(groupAmount([line("agent-run", 120, { status: "partial" })])).toEqual({ kind: "amount", cents: 120, partial: true });
  });

  it("marks the whole view partial when a row is not reported", () => {
    const view = meterView(monthStatementFromBody(statementBody({
      lines: [{ key: "agent-run", status: "unavailable", billed: true, costCents: null }],
    }))!);
    expect(view.rows).toEqual([{ id: "assistant", label: "Assistant and bots", amount: { kind: "not-reported" } }]);
    expect(view.partial).toBe(true);
  });
});

describe("meter view", () => {
  it("renders the mockup line, fill and reset date", () => {
    const view = meterView(monthStatementFromBody(statementBody())!);
    expect(view.usedLine).toBe("$8.00 of $10.00 free");
    expect(view.fill).toBeCloseTo(0.8);
    expect(view.over).toBe(false);
    expect(view.resetLine).toBe("Resets Nov 1");
  });

  it("caps the bar at full and says so once usage passes the allowance", () => {
    const view = meterView(monthStatementFromBody(statementBody({ usageCents: 1420 }))!);
    expect(view.fill).toBe(1);
    expect(view.over).toBe(true);
    expect(view.usedLine).toBe("$14.20 used · $10.00 free");
  });

  it("groups thousands in large amounts", () => {
    const view = meterView(monthStatementFromBody(statementBody({ usageCents: 270122 }))!);
    expect(view.usedLine).toBe("$2,701.22 used · $10.00 free");
  });

  it("rolls the reset date over the year end and falls back to periodStart", () => {
    expect(resetLine({ periodStart: "2026-12-01", periodEnd: "2026-12-31" })).toBe("Resets Jan 1");
    expect(resetLine({ periodStart: "2026-02-01", periodEnd: null })).toBe("Resets Mar 1");
  });

  it("rejects a body that is not a statement", () => {
    expect(monthStatementFromBody({ error: "nope" })).toBeNull();
    expect(monthStatementFromBody(statementBody({ usageCents: "8" }))).toBeNull();
  });
});

describe("plan and billing state", () => {
  it("usage-priced companies are on the Free plan", () => {
    expect(planLabelFromSummary({ pricingPlan: "usage-only" })).toBe("Free plan");
    expect(planLabelFromSummary({ pricingPlan: "current", plan: "team" })).toBe("Workforce plan");
    expect(planLabelFromSummary({ pricingPlan: "current" })).toBeNull();
  });

  it("a card on file or a paid plan means billing is set up", () => {
    expect(billingIsSetUp({ pricingPlan: "usage-only", usageTrial: { status: "active", cardOnFile: false } })).toBe(false);
    expect(billingIsSetUp({ pricingPlan: "usage-only", usageTrial: { status: "active", cardOnFile: true } })).toBe(true);
    expect(billingIsSetUp({ defaultPaymentMethod: { present: true } })).toBe(true);
    expect(billingIsSetUp({ plan: "team" })).toBe(true);
  });
});

describe("readCoreUsage states", () => {
  const usageOnly = { pricingPlan: "usage-only", usageTrial: { status: "active", cardOnFile: false } };

  it("reads the statement for a usage-priced company", async () => {
    const view = await readCoreUsage({
      getBillingSummary: async () => ok(usageOnly),
      getUsageStatement: async () => ok(statementBody()),
    }, "cmp_northwind", "Northwind");
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.planLabel).toBe("Free plan");
    expect(view.paid).toBe(false);
    expect(view.usage?.usedLine).toBe("$8.00 of $10.00 free");
  });

  it("a non-owner gets owner-only, never zero usage", async () => {
    const statement = vi.fn();
    const view = await readCoreUsage({ getBillingSummary: async () => fail("http-403"), getUsageStatement: statement }, "cmp_x", "Acme");
    expect(view).toEqual({ kind: "owner-only", companyName: "Acme" });
    expect(statement).not.toHaveBeenCalled();
  });

  it("a failed or throwing summary is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await readCoreUsage({ getBillingSummary: async () => fail("http-500") }, "cmp_x", "Acme")).kind).toBe("unavailable");
    expect((await readCoreUsage({ getBillingSummary: async () => { throw new Error("offline"); } }, "cmp_x", "Acme")).kind).toBe("unavailable");
    expect((await readCoreUsage({}, "cmp_x", "Acme")).kind).toBe("unavailable");
  });

  it("a failed statement read says unavailable instead of showing $0", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = await readCoreUsage({
      getBillingSummary: async () => ok(usageOnly),
      getUsageStatement: async () => fail("http-500"),
    }, "cmp_x", "Acme");
    expect(view).toMatchObject({ kind: "ready", usage: null, usageUnavailable: true });
  });

  it("a company not on usage pricing shows no meter and reads no statement", async () => {
    const statement = vi.fn();
    const view = await readCoreUsage({
      getBillingSummary: async () => ok({ pricingPlan: "current", plan: "team" }),
      getUsageStatement: statement,
    }, "cmp_x", "Acme");
    expect(view).toMatchObject({ kind: "ready", planLabel: "Workforce plan", paid: true, usage: null, usageUnavailable: false });
    expect(statement).not.toHaveBeenCalled();
  });

  it("caches only ready views", () => {
    rememberCoreUsage("cmp_a", { kind: "unavailable", companyName: "A" });
    expect(cachedCoreUsage("cmp_a")).toBeNull();
    const ready = { kind: "ready" as const, companyName: "A", planLabel: null, paid: false, usage: null, usageUnavailable: false };
    rememberCoreUsage("cmp_a", ready);
    expect(cachedCoreUsage("cmp_a")).toEqual(ready);
  });
});
