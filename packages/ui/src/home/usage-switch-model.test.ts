import { describe, expect, it, vi } from "vitest";
import { previewBillCents, readUsageSwitch, usageSwitchFromBody, usageSwitchLines } from "./usage-switch-model.js";

const scheduled = {
  enabled: true,
  phase: "scheduled",
  switchDate: "2026-12-19T00:00:00.000Z",
  previewDays: 30,
  previewEndsAt: "2027-01-18T00:00:00.000Z",
  todayMonthlyCents: 5000,
  estimateCents: 1240,
  estimateComplete: true,
};

describe("usage switch", () => {
  it("a legacy payer sees the switch date, today's price and the estimate", () => {
    const info = usageSwitchFromBody(scheduled)!;
    expect(usageSwitchLines(info)).toEqual({
      headline: "Moves to usage pricing on 19 December 2026",
      compare: "Today $50.00 a month · On usage about $12.40 a month",
      note: "The estimate is your last 30 days of usage at usage prices.",
    });
    expect(usageSwitchLines({ ...info, estimateComplete: false }).compare).toContain("at least $12.40");
    expect(usageSwitchLines({ ...info, estimateCents: null }).note).toBe("The usage estimate isn't available yet.");
  });

  it("a switched account sees the 30-day preview and its would-be bill", () => {
    const info = usageSwitchFromBody({ ...scheduled, phase: "preview", estimateCents: null })!;
    const lines = usageSwitchLines(info, previewBillCents(1800, 1000));
    expect(lines.headline).toBe("Usage pricing preview until 18 January 2027");
    expect(lines.compare).toBe("Your bill so far would be $8.00");
    expect(lines.note).toBe("Nothing is charged for usage during the 30-day preview. Billing on usage starts 18 January 2027.");
    expect(previewBillCents(500, 1000)).toBe(0);
  });

  it("a preview bill read from an incomplete statement is a floor, never an exact amount", () => {
    const info = usageSwitchFromBody({ ...scheduled, phase: "preview", estimateCents: null })!;
    expect(usageSwitchLines(info, previewBillCents(1800, 1000), true).compare).toBe("Your bill so far would be at least $8.00");
    expect(usageSwitchLines(info, previewBillCents(400, 1000), true).compare).toBe("Your bill so far would be at least $0.00");
    expect(usageSwitchLines(info, previewBillCents(1800, 1000), false).compare).toBe("Your bill so far would be $8.00");
  });

  it("no switch, kill switch, usage phase or bad body is null", async () => {
    expect(usageSwitchFromBody({ ...scheduled, enabled: false })).toBeNull();
    expect(usageSwitchFromBody({ ...scheduled, phase: "usage" })).toBeNull();
    expect(usageSwitchFromBody({ ...scheduled, phase: "none" })).toBeNull();
    expect(usageSwitchFromBody({ ...scheduled, switchDate: "nope" })).toBeNull();
    expect(usageSwitchFromBody(null)).toBeNull();
    expect(await readUsageSwitch({ getUsageSwitch: vi.fn(async () => { throw new Error("x"); }) }, "c")).toBeNull();
    expect(await readUsageSwitch({}, "c")).toBeNull();
  });

  it("reads the company or the personal switch", async () => {
    const getUsageSwitch = vi.fn(async () => ({ ok: true as const, value: scheduled }));
    const getPersonalUsageSwitch = vi.fn(async () => ({ ok: true as const, value: { ...scheduled, phase: "preview" } }));
    expect((await readUsageSwitch({ getUsageSwitch, getPersonalUsageSwitch }, "c"))?.phase).toBe("scheduled");
    expect(getUsageSwitch).toHaveBeenCalledWith("c");
    expect((await readUsageSwitch({ getUsageSwitch, getPersonalUsageSwitch }, null))?.phase).toBe("preview");
  });
});
