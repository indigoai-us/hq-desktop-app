import { describe, expect, it } from "vitest";
import { periodLabel, spendLimitFromBody, spendLimitLine, trialEndLabel } from "./usage-settings-model";

describe("usage settings text", () => {
  it("parses the spend limit and labels the default", () => {
    expect(spendLimitFromBody({ limitCents: 10000, custom: false })).toEqual({ noLimit: false, limitCents: 10000, custom: false, paused: false });
    expect(spendLimitFromBody({ error: "nope" })).toBeNull();
    expect(spendLimitFromBody({ limitCents: "100" })).toBeNull();
    expect(spendLimitLine({ noLimit: false, limitCents: 10000, custom: false, paused: false })).toBe("$100.00 a month (default)");
    expect(spendLimitLine({ noLimit: false, limitCents: 25000, custom: true, paused: false })).toBe("$250.00 a month");
  });

  it("a removed or never-set limit (hq-pro #5069 noLimit body) is No limit, not a failed read", () => {
    // Body shape from hq-pro #5069 buildSpendLimitView: limitCents null, noLimit true.
    const removed = spendLimitFromBody({ limitCents: null, noLimit: true, custom: true, paused: false, defaultLimitCents: 10000 });
    expect(removed).toEqual({ noLimit: true, limitCents: null, custom: true, paused: false });
    expect(spendLimitLine(removed!)).toBe("No limit");
    // A switched paying account that never set one.
    expect(spendLimitFromBody({ limitCents: null, noLimit: true, custom: false })?.noLimit).toBe(true);
    // limitCents null alone (older field order) also means no limit.
    expect(spendLimitFromBody({ limitCents: null })?.noLimit).toBe(true);
  });

  it("labels the period and the trial end", () => {
    expect(periodLabel("2026-10-01", "2026-10-31")).toBe("Oct 1 to Oct 31");
    expect(periodLabel("2026-10-01", null)).toBe("Since Oct 1");
    expect(trialEndLabel("2026-11-03T12:00:00Z")).toBe("Ends Nov 3");
    expect(trialEndLabel("not a date")).toBe("");
  });
});
