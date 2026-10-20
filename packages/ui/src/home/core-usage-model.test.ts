import { afterEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@hq/platform";
import { clearAccountCaches } from "../common/account-caches";
import {
  OTHER_USAGE_LABEL,
  USAGE_GROUPS,
  __resetCoreUsageCacheForTests,
  barTone,
  billingIsSetUp,
  billingRole,
  cachedCoreUsage,
  personalUsageAccount,
  usageAccounts,
  usageAccountKey,
  readPersonalUsage,
  readAccountUsage,
  accountTotalText,
  personalNoticeFromSummary,
  cachedCoreUsageAt,
  staleUsageLine,
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
    expect(resolveUsageCompany(rows, "garage", "acme")).toEqual({ kind: "company", uid: null, name: "Garage", role: null });
  });

  it("a cloud company on screen is used with its role", () => {
    expect(resolveUsageCompany(rows, "acme", null)).toEqual({ kind: "company", uid: "cmp_acme", name: "Acme", role: "owner" });
  });

  it("with no company on screen uses the active company, else the personal account, never the first company", () => {
    expect(resolveUsageCompany(rows, "", "garage")).toMatchObject({ kind: "company", uid: null, name: "Garage" });
    expect(resolveUsageCompany(rows, null, "acme")).toMatchObject({ kind: "company", uid: "cmp_acme" });
    // Nothing on screen and no active company: personal, not Acme (the first company).
    expect(resolveUsageCompany(rows, null, null)).toEqual(personalUsageAccount());
    expect(resolveUsageCompany(rows, "", "")).toEqual(personalUsageAccount());
    expect(resolveUsageCompany([], null, null)).toEqual(personalUsageAccount());
  });

  it("an on-screen slug that names no company (the personal space) falls to the active company, then personal", () => {
    expect(resolveUsageCompany(rows, "personal", "acme")).toMatchObject({ kind: "company", uid: "cmp_acme" });
    expect(resolveUsageCompany(rows, "personal", null)).toEqual(personalUsageAccount());
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

describe("stale numbers", () => {
  it("remembers when each company's view was read", () => {
    rememberCoreUsage("cmp_a", { kind: "owner-only", companyName: "A" }, 1_700_000_000_000);
    expect(cachedCoreUsageAt("cmp_a")).toBe(1_700_000_000_000);
    expect(cachedCoreUsageAt("cmp_b")).toBeNull();
  });

  it("says when kept numbers were read, or that they may be out of date", () => {
    expect(staleUsageLine(null)).toBe("Couldn't refresh. These numbers may be out of date.");
    expect(staleUsageLine(Date.UTC(2026, 9, 18, 15, 12))).toMatch(/^Couldn't refresh\. Showing usage from \d{1,2}:\d{2} [AP]M\.$/);
  });
});


describe("accounts for multi-company owners", () => {
  const rows = [
    { slug: "zeta", displayName: "Zeta", kind: "company", cloudUid: "cmp_zeta", role: "owner" },
    { slug: "amass", displayName: "Amass", kind: "company", cloudUid: "cmp_amass", role: "admin" },
    { slug: "liverecover", displayName: "Liverecover", kind: "company", cloudUid: "cmp_lr", role: "member" },
    { slug: "garage", displayName: "Garage", kind: "company", cloudUid: null, role: "owner" },
    { slug: "personal", displayName: "Corey", kind: "personal", cloudUid: "cmp_personal", role: null },
  ];

  it("lists every cloud company where the person is owner or admin, by name, then the personal account", () => {
    const list = usageAccounts(rows, personalUsageAccount());
    expect(list.map((a) => [a.kind, a.name, a.role])).toEqual([
      ["company", "Amass", "admin"],
      ["company", "Zeta", "owner"],
      ["personal", "Personal", null],
    ]);
  });

  it("keeps a member's on-screen company at the top so the switcher shows what the panel shows", () => {
    const current = resolveUsageCompany(rows, "liverecover", null);
    const list = usageAccounts(rows, current);
    expect(list.map((a) => a.name)).toEqual(["Liverecover", "Amass", "Zeta", "Personal"]);
  });

  it("keys accounts by company uid, and the personal account as personal", () => {
    expect(usageAccountKey(personalUsageAccount())).toBe("personal");
    expect(usageAccountKey(resolveUsageCompany(rows, "zeta", null))).toBe("cmp_zeta");
  });

  it("summarizes each account's total for the switcher row", () => {
    expect(accountTotalText(undefined)).toBe("…");
    expect(accountTotalText({ kind: "owner-only", companyName: "A" })).toBe("Owner only");
    expect(accountTotalText({ kind: "unavailable", companyName: "A" })).toBe("Unavailable");
    const ready = meterView(monthStatementFromBody(statementBody())!);
    expect(accountTotalText({ kind: "ready", companyName: "A", planLabel: null, paid: false, usage: ready, usageUnavailable: false, notice: null })).toBe("$8.00");
    const partial = meterView(monthStatementFromBody(statementBody({ complete: false }))!);
    expect(accountTotalText({ kind: "ready", companyName: "A", planLabel: null, paid: false, usage: partial, usageUnavailable: false, notice: null })).toBe("At least $8.00");
  });
});

describe("personal account usage", () => {
  const personSummary = (extra: Record<string, unknown> = {}) => ({
    cardOnFile: false,
    personalUsage: { allowanceCents: 1000, usedCents: 340, cardRequired: false, cardOnFile: false, syncPaused: false, ...extra },
  });

  it("reads the person summary and the person month statement", async () => {
    const source = {
      getPersonalBillingSummary: vi.fn(async () => ok(personSummary())),
      getPersonalUsageStatement: vi.fn(async () => ok(statementBody({ scope: "person", usageCents: 340, lines: [{ key: "member-sync", status: "measured", billed: true, costCents: 340 }] }))),
    };
    const view = await readPersonalUsage(source);
    expect(view).toMatchObject({ kind: "ready", companyName: "Personal", planLabel: "Usage plan", paid: false, notice: null });
    if (view.kind !== "ready") return;
    expect(view.usage?.usedLine).toBe("$3.40 of $10.00 free");
    expect(view.usage?.rows).toEqual([{ id: "sync", label: "Sync", amount: { kind: "amount", cents: 340, partial: false } }]);
    expect(source.getPersonalUsageStatement).toHaveBeenCalledTimes(1);
  });

  it("a person not on usage-only personal pricing gets no meter", async () => {
    const view = await readPersonalUsage({ getPersonalBillingSummary: async () => ok({ cardOnFile: true }), getPersonalUsageStatement: vi.fn() });
    expect(view).toMatchObject({ kind: "ready", planLabel: null, paid: true, usage: null, usageUnavailable: false });
  });

  it("a failed personal read is unavailable, never $0", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await readPersonalUsage({ getPersonalBillingSummary: async () => fail("http-500") })).kind).toBe("unavailable");
    expect((await readPersonalUsage({})).kind).toBe("unavailable");
    const noStatement = await readPersonalUsage({
      getPersonalBillingSummary: async () => ok(personSummary()),
      getPersonalUsageStatement: async () => fail("http-502"),
    });
    expect(noStatement).toMatchObject({ kind: "ready", usage: null, usageUnavailable: true });
  });

  it("says why personal vault sync is paused, or that a card is needed", () => {
    expect(personalNoticeFromSummary(personSummary({ syncPaused: true, cardRequired: true }))).toMatchObject({
      kind: "paused-card-required",
      text: "Personal vault sync is paused: the $10.00 of usage included this month is used up. Add a card to resume. Files on your computers are not affected.",
      actionLabel: "Add a card to resume",
    });
    expect(personalNoticeFromSummary(personSummary({ cardRequired: true }))).toMatchObject({ kind: "card-required", actionLabel: "Add a card" });
    expect(personalNoticeFromSummary(personSummary())).toBeNull();
  });

  it("readAccountUsage dispatches by account and retries the personal read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getPersonalBillingSummary = vi.fn().mockResolvedValueOnce(fail("network")).mockResolvedValueOnce(ok({ cardOnFile: false }));
    const view = await readAccountUsage({ getPersonalBillingSummary }, personalUsageAccount(), { delays: [1], sleep: async () => {} });
    expect(getPersonalBillingSummary).toHaveBeenCalledTimes(2);
    expect(view.kind).toBe("ready");
    expect((await readAccountUsage({}, { kind: "company", uid: null, name: "Garage", role: null })).kind).toBe("no-usage");
  });
});

describe("sign-out clears the usage cache (review critical, 2026-10-19)", () => {
  it("clearAccountCaches() forgets the personal entry, company entries and the remembered account", async () => {
    const { cachedCoreUsage, rememberCoreUsage, setPreferredUsageAccount, preferredUsageAccount } = await import("./core-usage-model");
    const view = { kind: "ready" as const, companyName: "Personal", planLabel: "Usage plan", paid: false, usage: null, usageUnavailable: false, notice: null };
    rememberCoreUsage("personal", view);
    rememberCoreUsage("cmp_northwind", { ...view, companyName: "Northwind" });
    rememberCoreUsage("cmp_widgets", { kind: "owner-only", companyName: "Widgets" });
    setPreferredUsageAccount("cmp_northwind");
    clearAccountCaches();
    expect(cachedCoreUsage("personal")).toBeNull();
    expect(cachedCoreUsage("cmp_northwind")).toBeNull();
    expect(cachedCoreUsage("cmp_widgets")).toBeNull();
    expect(preferredUsageAccount()).toBeNull();
  });
});

describe("a read in flight across sign-out is not cached (review, 2026-10-19)", () => {
  it("rememberCoreUsage drops a view from an older cache generation", async () => {
    const { cachedCoreUsage, rememberCoreUsage, coreUsageGeneration } = await import("./core-usage-model");
    const view = { kind: "owner-only" as const, companyName: "Northwind" };
    const startedIn = coreUsageGeneration();
    clearAccountCaches();
    rememberCoreUsage("cmp_northwind", view, Date.now(), startedIn);
    expect(cachedCoreUsage("cmp_northwind")).toBeNull();
    rememberCoreUsage("cmp_northwind", view, Date.now(), coreUsageGeneration());
    expect(cachedCoreUsage("cmp_northwind")).not.toBeNull();
  });
});
