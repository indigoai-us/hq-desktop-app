import { afterEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@hq/platform";
import {
  detailLines,
  formatUnits,
  lineCostText,
  periodLabel,
  readUsageDetails,
  spendLimitFromBody,
  spendLimitLine,
} from "./usage-settings-model";

const ok = (value: unknown) => ({ ok: true as const, value: value as Json });
const fail = (code: string, message = code) => ({ ok: false as const, reason: "error" as const, code, message });

afterEach(() => {
  vi.restoreAllMocks();
});

/** GET /v1/billing/usage body, shaped like hq-pro's buildUsageStatement output. */
function statementBody(overrides: Record<string, unknown> = {}) {
  return {
    scope: "company",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    asOf: "2026-10-17",
    complete: true,
    allowanceCents: 1000,
    usageCents: 1350,
    allowanceLeftCents: 0,
    billCents: 350,
    projectedUsageCents: 2600,
    projectedBillCents: 1600,
    lines: [
      { key: "member-sync", displayName: "Sync", unit: "sync", unitCents: 10, status: "measured", billed: true, units: 42, costCents: 420, projectedCostCents: 760 },
      { key: "integration-call", displayName: "Gateway call", unit: "call", unitCents: 5, status: "measured", billed: true, units: 10, costCents: 50, projectedCostCents: 90 },
      { key: "storage", displayName: "Storage", unit: "GB-month", unitCents: 200, status: "measured", billed: true, units: 0.4234, costCents: 85, projectedCostCents: 160 },
      { key: "vault", displayName: "Vault", unit: "vault-month", unitCents: 500, status: "measured", billed: true, waived: true, units: 0, costCents: 0, projectedCostCents: 0 },
      { key: "agent-run", displayName: "Agent run", unit: "run", unitCents: 5, status: "unavailable", billed: true, units: null, costCents: null, projectedCostCents: null },
    ],
    free: [{ key: "free", text: "Deploys, DMs and background AI are free." }],
    ...overrides,
  };
}

/** GET /v1/pricing `usage` block. Rates deliberately differ from the statement to prove which source wins. */
const PRICING = {
  usage: {
    version: "2026-10-16",
    includedUsd: 10,
    trial: { days: 30, capUsd: 500 },
    meters: [
      { id: "member-sync", label: "Sync (feed)", unit: "sync", unitUsd: 0.1 },
      { id: "integration-call", label: "Gateway call", unit: "call", unitUsd: 0.05 },
      { id: "storage", label: "Storage", unit: "GB-month", unitUsd: 2 },
      { id: "vault", label: "Vault", unit: "vault-month", unitUsd: 5, waivedInTrial: true },
      { id: "agent-run", label: "Agent run", unit: "run", unitUsd: 0.05 },
    ],
    boxes: [{ size: "small", instanceType: "t3.small", monthlyUsd: 100 }],
    free: ["deploys"],
  },
};

const SPEND = { limitCents: 10000, custom: false, paused: false, defaultLimitCents: 10000 };

function source(overrides: Record<string, unknown> = {}) {
  return {
    getBillingSummary: vi.fn(async () => ok({ pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: true } })),
    getUsageStatement: vi.fn(async () => ok(statementBody())),
    getPricing: vi.fn(async () => ok(PRICING)),
    getSpendLimit: vi.fn(async () => ok(SPEND)),
    ...overrides,
  };
}

describe("readUsageDetails", () => {
  it("shows cost per meter with labels and rates from GET /v1/pricing, the allowance left, projected bill and spend limit", async () => {
    const view = await readUsageDetails(source(), "cmp_northwind");
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.planLabel).toBe("Usage plan");
    expect(view.trial).toBeNull();
    expect(view.allowanceCents).toBe(1000);
    expect(view.allowanceLeftCents).toBe(0);
    expect(view.usageCents).toBe(1350);
    expect(view.projectedBillCents).toBe(1600);
    expect(view.spendLimit).toEqual({ limitCents: 10000, custom: false, paused: false });
    expect(view.freeText).toBe("Deploys, DMs and background AI are free.");
    const sync = view.lines.find((l) => l.key === "member-sync")!;
    expect(sync.label).toBe("Sync (feed)");
    expect(sync.rate).toBe("$0.10 per sync");
    expect(sync.usage).toBe("42 syncs");
    expect(sync.costCents).toBe(420);
  });

  it("reads the same statement endpoint the console usage view reads, for this company", async () => {
    const src = source();
    await readUsageDetails(src, "cmp_northwind");
    expect(src.getBillingSummary).toHaveBeenCalledWith("cmp_northwind");
    expect(src.getUsageStatement).toHaveBeenCalledWith("cmp_northwind");
    expect(src.getSpendLimit).toHaveBeenCalledWith("cmp_northwind");
    expect(src.getPricing).toHaveBeenCalledTimes(1);
  });

  it("uses the statement's own label and rate when the price feed can't be read, never a bundled price", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = await readUsageDetails(source({ getPricing: vi.fn(async () => fail("http-503")) }), "cmp_northwind");
    if (view.kind !== "ready") throw new Error("expected ready");
    const sync = view.lines.find((l) => l.key === "member-sync")!;
    expect(sync.label).toBe("Sync");
    expect(sync.rate).toBe("$0.10 per sync");
    // A statement with a different rate proves the rate is not a constant in the app.
    const custom = await readUsageDetails(
      source({
        getPricing: vi.fn(async () => fail("http-503")),
        getUsageStatement: vi.fn(async () =>
          ok(statementBody({ lines: [{ key: "member-sync", displayName: "Sync", unit: "sync", unitCents: 7, billed: true, units: 3, costCents: 21 }] })),
        ),
      }),
      "cmp_northwind",
    );
    if (custom.kind !== "ready") throw new Error("expected ready");
    expect(custom.lines[0]!.rate).toBe("$0.07 per sync");
  });

  it("shows trial days left and trial usage against the cap during the trial", async () => {
    const endsAt = new Date(Date.now() + 9.2 * 86_400_000).toISOString();
    const view = await readUsageDetails(
      source({
        getBillingSummary: vi.fn(async () =>
          ok({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt, capCents: 50000, usedCents: 12345 } }),
        ),
      }),
      "cmp_northwind",
    );
    if (view.kind !== "ready") throw new Error("expected ready");
    expect(view.planLabel).toBe("Trial, 10 days left");
    expect(view.trial).toEqual({ endsAt, daysLeft: 10, capCents: 50000, usedCents: 12345 });
  });

  it("a non-owner gets owner-only and no statement read", async () => {
    const src = source({ getBillingSummary: vi.fn(async () => fail("FORBIDDEN")) });
    expect((await readUsageDetails(src, "cmp_x")).kind).toBe("owner-only");
    expect(src.getUsageStatement).not.toHaveBeenCalled();
  });

  it("a company not on usage pricing has no usage bill", async () => {
    const src = source({ getBillingSummary: vi.fn(async () => ok({ pricingPlan: "current" })) });
    expect((await readUsageDetails(src, "cmp_x")).kind).toBe("not-usage");
    expect(src.getUsageStatement).not.toHaveBeenCalled();
  });

  it("a failed summary or statement is unavailable, never a $0 statement", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await readUsageDetails(source({ getBillingSummary: vi.fn(async () => fail("http-500")) }), "c")).kind).toBe("unavailable");
    expect((await readUsageDetails(source({ getBillingSummary: vi.fn(async () => { throw new Error("offline"); }) }), "c")).kind).toBe("unavailable");
    expect((await readUsageDetails(source({ getUsageStatement: vi.fn(async () => fail("http-502")) }), "c")).kind).toBe("unavailable");
    expect((await readUsageDetails(source({ getUsageStatement: vi.fn(async () => ok({ error: "x" })) }), "c")).kind).toBe("unavailable");
    expect((await readUsageDetails(null, "c")).kind).toBe("unavailable");
  });

  it("a failed spend limit read leaves only that row empty", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = await readUsageDetails(source({ getSpendLimit: vi.fn(async () => fail("http-500")) }), "c");
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") expect(view.spendLimit).toBeNull();
  });
});

describe("line text", () => {
  it("formats usage units and costs plainly", () => {
    expect(formatUnits(1, "sync")).toBe("1 sync");
    expect(formatUnits(1240, "sync")).toBe("1,240 syncs");
    expect(formatUnits(0.4234, "GB-month")).toBe("0.42 GB-months");
    const [vault, agent] = detailLines(
      [
        { key: "vault", displayName: "Vault", unit: "vault-month", unitCents: 500, billed: true, waived: true, units: 0, costCents: 0 },
        { key: "agent-run", displayName: "Agent run", unit: "run", unitCents: 5, billed: true, status: "unavailable", units: null, costCents: null },
        { key: "old", displayName: "Old", billed: false, costCents: 900 },
      ],
      null,
    );
    expect(lineCostText(vault!)).toBe("Waived during the trial");
    expect(lineCostText(agent!)).toBe("Not reported");
    expect(agent!.usage).toBeNull();
  });

  it("parses the spend limit and labels the default", () => {
    expect(spendLimitFromBody({ limitCents: 10000, custom: false })).toEqual({ limitCents: 10000, custom: false, paused: false });
    expect(spendLimitFromBody({ error: "nope" })).toBeNull();
    expect(spendLimitLine({ limitCents: 10000, custom: false, paused: false })).toBe("$100.00 a month (default)");
    expect(spendLimitLine({ limitCents: 25000, custom: true, paused: false })).toBe("$250.00 a month");
  });

  it("labels the period", () => {
    expect(periodLabel("2026-10-01", "2026-10-31")).toBe("Oct 1 to Oct 31");
  });
});
