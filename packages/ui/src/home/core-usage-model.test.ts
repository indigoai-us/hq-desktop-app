import { afterEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@hq/platform";
import {
  OTHER_USAGE_LABEL,
  USAGE_GROUPS,
  __resetCoreUsageCacheForTests,
  barTone,
  billingIsSetUp,
  billingRole,
  cachedCoreUsage,
  usageNoticeFromSummary,
  canReadBilling,
  canSetUpBilling,
  readCoreUsageWithRetry,
  runningTrialFromSummary,
  trialDaysLeft,
  trialMeterView,
  trialPlanLabel,
  resolveUsageCompany,
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
  it("groups the seven meters into Agents and AI, Sync, Storage and vaults, in that order", () => {
    const rows = groupUsageLines(monthStatementFromBody(statementBody())!.lines);
    expect(rows.map((r) => [r.label, r.amount])).toEqual([
      ["Agents and AI", { kind: "amount", cents: 510, partial: false }],
      ["Sync", { kind: "amount", cents: 40, partial: false }],
      ["Storage and vaults", { kind: "amount", cents: 60, partial: false }],
    ]);
  });

  it("puts each rate-card meter in exactly one group", () => {
    const meters = ["agent-run", "hq-mcp-call", "integration-call", "member-sync", "storage", "secret", "vault"];
    for (const key of meters) {
      expect(USAGE_GROUPS.filter((g) => g.keys.includes(key))).toHaveLength(1);
    }
    expect(USAGE_GROUPS.flatMap((g) => g.keys).sort()).toEqual([...meters].sort());
  });

  it("the groups add up to the statement total", () => {
    const body = statementBody({ usageCents: 610 });
    const rows = groupUsageLines(monthStatementFromBody(body)!.lines);
    const sum = rows.reduce((acc, r) => acc + (r.amount.kind === "amount" ? r.amount.cents : 0), 0);
    expect(sum).toBe(body.usageCents);
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
    expect(view.rows).toEqual([{ id: "agents", label: "Agents and AI", amount: { kind: "not-reported" } }]);
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
    expect(view.mode).toBe("allowance");
    expect(view.tone).toBe("near");
  });

  it("tones the bar: neutral under 80%, amber from 80%, red at the limit", () => {
    expect(barTone(799, 1000)).toBe("ok");
    expect(barTone(800, 1000)).toBe("near");
    expect(barTone(999, 1000)).toBe("near");
    expect(barTone(1000, 1000)).toBe("at");
    expect(barTone(1500, 1000)).toBe("at");
    expect(barTone(0, 0)).toBe("ok");
  });

  it("caps the bar at full and says so once usage passes the allowance", () => {
    const view = meterView(monthStatementFromBody(statementBody({ usageCents: 1420 }))!);
    expect(view.fill).toBe(1);
    expect(view.over).toBe(true);
    expect(view.tone).toBe("at");
    expect(view.usedLine).toBe("$14.20 used · $10.00 free");
  });

  it("says the headline total is a floor while the statement is partial", () => {
    const view = meterView(monthStatementFromBody(statementBody({ complete: false }))!);
    expect(view.partial).toBe(true);
    expect(view.usedLine).toBe("At least $8.00 of $10.00 free");
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

describe("which company the panel shows", () => {
  const rows = [
    { slug: "acme", displayName: "Acme", kind: "company", cloudUid: "cmp_acme", role: "owner" },
    { slug: "garage", displayName: "Garage", kind: "company", cloudUid: null, role: null },
    { slug: "personal", displayName: "Personal", kind: "personal", cloudUid: "prs_me", role: null },
  ];

  it("a local company on screen gets no usage, never another company's spend", () => {
    expect(resolveUsageCompany(rows, "garage", "acme")).toEqual({ uid: null, name: "Garage", role: null });
  });

  it("a cloud company on screen is used with its role", () => {
    expect(resolveUsageCompany(rows, "acme", null)).toEqual({ uid: "cmp_acme", name: "Acme", role: "owner" });
  });

  it("falls back to the branded company, then the first cloud company", () => {
    expect(resolveUsageCompany(rows, "", "garage")?.uid).toBeNull();
    expect(resolveUsageCompany(rows, null, null)?.uid).toBe("cmp_acme");
    expect(resolveUsageCompany([], null, null)).toBeNull();
  });

  it("only owners (or an unknown role) read billing", () => {
    expect(canReadBilling("owner")).toBe(true);
    expect(canReadBilling(null)).toBe(true);
    expect(canReadBilling("member")).toBe(false);
    expect(canReadBilling("admin")).toBe(false);
  });

  it("owners and admins may set up billing; members may not", () => {
    expect(canSetUpBilling("Owner")).toBe(true);
    expect(canSetUpBilling("admin")).toBe(true);
    expect(canSetUpBilling("member")).toBe(false);
    expect(billingRole(" ADMIN ")).toBe("admin");
    expect(billingRole("")).toBe("unknown");
  });
});

describe("plan and billing state", () => {
  it("usage-priced companies read Usage plan, or Trial, N days left while the trial runs", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(planLabelFromSummary({ pricingPlan: "usage-only" }, now)).toBe("Usage plan");
    expect(planLabelFromSummary({ pricingPlan: "usage-only", usageTrial: { cardOnFile: true } }, now)).toBe("Usage plan");
    expect(
      planLabelFromSummary({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt: "2026-10-30T18:00:00Z" } }, now),
    ).toBe("Trial, 13 days left");
    expect(
      planLabelFromSummary({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt: "2026-10-19T00:00:00Z" } }, now),
    ).toBe("Trial, 1 day left");
    // An ended trial, or one past its end date, is the usage plan.
    expect(
      planLabelFromSummary({ pricingPlan: "usage-only", usageTrial: { status: "ended", endsAt: "2026-10-01T00:00:00Z" } }, now),
    ).toBe("Usage plan");
    expect(
      planLabelFromSummary({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt: "2026-10-17T00:00:00Z" } }, now),
    ).toBe("Usage plan");
    // No leftover plan-tier names: a company not on usage pricing gets no label.
    expect(planLabelFromSummary({ pricingPlan: "current", plan: "team" })).toBeNull();
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
    expect(view.planLabel).toBe("Usage plan");
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
    expect(view).toMatchObject({ kind: "ready", planLabel: null, paid: true, usage: null, usageUnavailable: false, notice: null });
    expect(statement).not.toHaveBeenCalled();
  });

  it("caches only ready views", () => {
    rememberCoreUsage("cmp_a", { kind: "unavailable", companyName: "A" });
    expect(cachedCoreUsage("cmp_a")).toBeNull();
    const ready = { kind: "ready" as const, companyName: "A", planLabel: null, paid: false, usage: null, usageUnavailable: false, notice: null };
    rememberCoreUsage("cmp_a", ready);
    expect(cachedCoreUsage("cmp_a")).toEqual(ready);
  });
});

describe("trial meter", () => {
  const now = new Date("2026-10-18T12:00:00Z");

  it("counts whole days left, rounded up, and 0 once ended", () => {
    expect(trialDaysLeft("2026-10-19T12:00:00Z", now)).toBe(1);
    expect(trialDaysLeft("2026-10-19T12:00:01Z", now)).toBe(2);
    expect(trialDaysLeft("2026-10-18T11:00:00Z", now)).toBe(0);
    expect(trialDaysLeft("not a date", now)).toBe(0);
    expect(trialPlanLabel(1)).toBe("Trial, 1 day left");
  });

  it("reads the running trial's cap and usage from the summary", () => {
    const trial = runningTrialFromSummary(
      { usageTrial: { status: "active", endsAt: "2026-11-03T00:00:00Z", capCents: 50000, usedCents: 1234 } },
      now,
    );
    expect(trial).toEqual({ endsAt: "2026-11-03T00:00:00Z", daysLeft: 16, capCents: 50000, usedCents: 1234 });
    expect(runningTrialFromSummary({ usageTrial: { status: "owner-trial-used" } }, now)).toBeNull();
  });

  it("shows trial usage against the cap, amber near it and red at it", () => {
    const base = { endsAt: "2026-11-03T00:00:00Z", daysLeft: 16, capCents: 50000 };
    const view = trialMeterView({ ...base, usedCents: 12000 });
    expect(view.mode).toBe("trial");
    expect(view.usedLine).toBe("$120.00 of $500.00 trial usage");
    expect(view.resetLine).toBe("Trial ends Nov 3");
    expect(view.tone).toBe("ok");
    expect(view.rows).toEqual([]);
    expect(view.rowsNote).not.toBeNull();
    expect(trialMeterView({ ...base, usedCents: 40000 }).tone).toBe("near");
    expect(trialMeterView({ ...base, usedCents: 50000 }).tone).toBe("at");
  });

  it("says trial usage is not measured yet rather than $0", () => {
    const view = trialMeterView({ endsAt: "2026-11-03T00:00:00Z", daysLeft: 16, capCents: 50000, usedCents: null });
    expect(view.usedLine).toBe("Trial usage isn't measured yet");
    expect(view.usedLine).not.toContain("$0");
  });

  it("readCoreUsage shows the trial meter and skips the statement while the trial runs", async () => {
    const source = {
      getBillingSummary: vi.fn(async () =>
        ok({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt: "2026-11-03T00:00:00Z", capCents: 50000, usedCents: 500 } }),
      ),
      getUsageStatement: vi.fn(async () => ok(statementBody())),
    };
    const view = await readCoreUsage(source, "cmp_northwind", "Northwind", () => now);
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.planLabel).toBe("Trial, 16 days left");
    expect(view.usage?.mode).toBe("trial");
    expect(source.getUsageStatement).not.toHaveBeenCalled();
  });
});

describe("quiet retries", () => {
  it("retries an unavailable read, then returns the good answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getBillingSummary = vi
      .fn()
      .mockResolvedValueOnce(fail("http-500"))
      .mockResolvedValueOnce(fail("network"))
      .mockResolvedValueOnce(ok({ pricingPlan: "current" }));
    const sleep = vi.fn(async () => {});
    const view = await readCoreUsageWithRetry({ getBillingSummary }, "cmp_n", "N", { delays: [1000, 3000], sleep });
    expect(view.kind).toBe("ready");
    expect(getBillingSummary).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1000, 3000]);
  });

  it("stops after the last retry and never retries an owner-only answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async () => fail("http-500"));
    const sleep = vi.fn(async () => {});
    expect((await readCoreUsageWithRetry({ getBillingSummary: failing }, "c", "C", { delays: [1, 1], sleep })).kind).toBe("unavailable");
    expect(failing).toHaveBeenCalledTimes(3);
    const forbidden = vi.fn(async () => fail("FORBIDDEN"));
    expect((await readCoreUsageWithRetry({ getBillingSummary: forbidden }, "c", "C", { delays: [1, 1], sleep })).kind).toBe("owner-only");
    expect(forbidden).toHaveBeenCalledTimes(1);
  });
});

describe("trial usage minimum", () => {
  const base = { endsAt: "2026-11-03T00:00:00Z", daysLeft: 16, capCents: 50000, usedCents: 12000 };

  it("reads unknownMeters from the summary and says the figure is a minimum", () => {
    const trial = runningTrialFromSummary(
      { usageTrial: { status: "active", endsAt: "2026-11-03T00:00:00Z", capCents: 50000, usedCents: 12000, unknownMeters: ["storage_bytes"] } },
      new Date("2026-10-18T12:00:00Z"),
    );
    expect(trial?.unknownMeters).toEqual(["storage_bytes"]);
    const view = trialMeterView(trial!);
    expect(view.usedLine).toBe("At least $120.00 of $500.00 trial usage");
    expect(view.partial).toBe(true);
  });

  it("an empty unknownMeters list is an exact figure", () => {
    const view = trialMeterView({ ...base, unknownMeters: [] });
    expect(view.usedLine).toBe("$120.00 of $500.00 trial usage");
    expect(view.partial).toBe(false);
  });
});

describe("pause and card notices", () => {
  const trial = (extra: Record<string, unknown>) => ({
    pricingPlan: "usage-only",
    usageTrial: { status: "active", endsAt: "2026-11-03T00:00:00Z", capCents: 50000, allowanceCents: 1000, ...extra },
  });

  it("no pause and no prompt is no notice", () => {
    expect(usageNoticeFromSummary(trial({}))).toBeNull();
    expect(usageNoticeFromSummary({ pricingPlan: "usage-only" })).toBeNull();
  });

  it("sync paused at the trial cap says why, when it resumes, and offers Add a card to resume", () => {
    const n = usageNoticeFromSummary(trial({ syncPaused: true, pauseReason: "usage_trial_cap", capReached: true }))!;
    expect(n.kind).toBe("paused-trial-cap");
    expect(n.text).toBe(
      "Cloud sync is paused: the trial's $500.00 of usage is used up. It resumes when the trial ends on Nov 3, or as soon as a card is added. Files on your computers are not affected.",
    );
    expect(n.actionLabel).toBe("Add a card to resume");
    expect(n.memberText).toContain("Ask an owner or admin to add a card.");
  });

  it("sync paused for a card after the included usage says so and offers Add a card to resume", () => {
    const n = usageNoticeFromSummary({
      pricingPlan: "usage-only",
      usageTrial: { status: "ended", allowanceCents: 1000, syncPaused: true, pauseReason: "usage_card_required", cardRequired: true },
    })!;
    expect(n.kind).toBe("paused-card-required");
    expect(n.text).toBe(
      "Cloud sync is paused: the $10.00 of usage included this month is used up. Add a card to resume. Files on your computers are not affected.",
    );
    expect(n.actionLabel).toBe("Add a card to resume");
  });

  it("cap reached without a pause (enforcement off) prompts for a card", () => {
    const n = usageNoticeFromSummary(trial({ capReached: true, pauseReason: "usage_trial_cap", syncPaused: false }))!;
    expect(n.kind).toBe("cap-reached");
    expect(n.text).toBe("The trial's $500.00 of usage is used up. Add a card to keep syncing.");
    expect(n.actionLabel).toBe("Add a card");
  });

  it("card required in the trial prompts for a card without saying sync is paused", () => {
    const n = usageNoticeFromSummary(trial({ cardRequired: true }))!;
    expect(n.kind).toBe("card-required");
    expect(n.text).toBe("Usage passed the $10.00 of usage included this month. Add a card to keep syncing.");
    expect(n.text).not.toContain("paused");
  });

  it("a missing amount is left out instead of guessed", () => {
    const n = usageNoticeFromSummary({ pricingPlan: "usage-only", usageTrial: { status: "active", syncPaused: true, pauseReason: "usage_trial_cap" } })!;
    expect(n.text).toContain("the trial's usage cap is used up");
    expect(n.text).not.toMatch(/\$/);
  });

  it("readCoreUsage carries the notice on the ready view", async () => {
    const view = await readCoreUsage(
      { getBillingSummary: async () => ok(trial({ syncPaused: true, pauseReason: "usage_trial_cap", usedCents: 50000 })) },
      "cmp_n",
      "N",
      () => new Date("2026-10-18T12:00:00Z"),
    );
    expect(view.kind === "ready" && view.notice?.kind).toBe("paused-trial-cap");
  });
});

describe("retry cancellation", () => {
  it("stops retrying once cancelled before the next try", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getBillingSummary = vi.fn(async () => fail("http-500"));
    let cancelled = false;
    const sleep = vi.fn(async () => {
      cancelled = true;
    });
    const view = await readCoreUsageWithRetry({ getBillingSummary }, "c", "C", { delays: [1000, 3000], sleep, cancelled: () => cancelled });
    expect(getBillingSummary).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(view.kind).toBe("unavailable");
  });

  it("does not even wait when already cancelled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getBillingSummary = vi.fn(async () => fail("http-500"));
    const sleep = vi.fn(async () => {});
    await readCoreUsageWithRetry({ getBillingSummary }, "c", "C", { delays: [1000], sleep, cancelled: () => true });
    expect(sleep).not.toHaveBeenCalled();
    expect(getBillingSummary).toHaveBeenCalledTimes(1);
  });
});
