import { describe, expect, it } from "vitest";
import { createTelemetryCache } from "./telemetry-cache.js";
import {
  LIST_RATE_LABEL,
  LIST_RATES,
  formatUsd,
  listRateUsd,
  outcomesForFilter,
  sessionsForFilter,
  snapshotForRange,
  type ModelUsage,
} from "./telemetry-model.js";
import { TELEMETRY_SMOKE } from "./telemetry-smoke.js";

describe("telemetry list rate (US-032)", () => {
  it("prices a known mix at the published list rate", () => {
    const usage: ModelUsage = {
      model: "opus",
      label: "Opus",
      hint: "",
      input: 1_000_000,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
    };
    expect(listRateUsd(usage)).toBe(LIST_RATES.opus.input);
    expect(LIST_RATE_LABEL).toBe("estimated at list price");
  });

  it("labels the smoke snapshot cost as a list-rate estimate", () => {
    expect(TELEMETRY_SMOKE.listCostUsd).toBeGreaterThan(0);
    expect(formatUsd(TELEMETRY_SMOKE.listCostUsd)).toMatch(/^\$\d+\.\d{2}$/);
  });

  it("filters sessions and outcomes without dropping the live row from all sessions", () => {
    expect(sessionsForFilter(TELEMETRY_SMOKE.sessionsRows, "failed")).toHaveLength(1);
    expect(sessionsForFilter(TELEMETRY_SMOKE.sessionsRows, "bots").every((r) => r.actor === "bot")).toBe(true);
    expect(outcomesForFilter(TELEMETRY_SMOKE.sessionsRows, "all").some((r) => r.outcomeBucket === "live")).toBe(false);
    expect(outcomesForFilter(TELEMETRY_SMOKE.sessionsRows, "shipped").every((r) => r.outcomeBucket === "shipped")).toBe(true);
  });
});

describe("telemetry cache (US-032)", () => {
  it("returns the stored snapshot before the refresh resolves", async () => {
    const storage = new Map<string, string>();
    storage.set("hq.telemetry.personal.v1", JSON.stringify(TELEMETRY_SMOKE));
    let release: (value: typeof TELEMETRY_SMOKE) => void = () => {};
    const cache = createTelemetryCache({
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      fetcher: () => new Promise((resolve) => { release = resolve; }),
    });
    expect(cache.cached()?.sessions).toBe(128);
    const pending = cache.refresh();
    expect(cache.cached()?.sessions).toBe(128);
    release({ ...TELEMETRY_SMOKE, sessions: 129 });
    await expect(pending).resolves.toMatchObject({ sessions: 129 });
  });
});

describe("telemetry range (QA-002)", () => {
  it("keeps the 30-day base for 30d and shows only its 30 days", () => {
    const view = snapshotForRange(TELEMETRY_SMOKE, "30d");
    expect(view.rangeLabel).toBe("Sep 2 – Oct 1");
    expect(view.sessions).toBe(128);
    expect(view.days).toHaveLength(30);
  });

  it("recomputes interval, totals, chart, sessions and skills for 7d", () => {
    const view = snapshotForRange(TELEMETRY_SMOKE, "7d");
    expect(view.rangeLabel).toBe("Sep 25 – Oct 1");
    expect(view.days).toHaveLength(7);
    expect(view.sessions).toBeLessThan(128);
    expect(view.sessions).toBeGreaterThan(0);
    expect(view.listCostUsd).toBeLessThan(TELEMETRY_SMOKE.listCostUsd);
    expect(view.sessionsRows.every((r) => (r.daysAgo ?? 0) < 7)).toBe(true);
    expect(view.sessionsRows.length).toBeLessThan(TELEMETRY_SMOKE.sessionsRows.length);
    expect(view.skills[0].count).toBeLessThan(TELEMETRY_SMOKE.skills[0].count);
    expect(view.dayLabels.at(-1)).toBe("today");
  });

  it("recomputes interval and totals for 90d", () => {
    const view = snapshotForRange(TELEMETRY_SMOKE, "90d");
    expect(view.rangeLabel).toBe("Jul 4 – Oct 1");
    expect(view.days).toHaveLength(90);
    expect(view.sessions).toBeGreaterThan(128);
    expect(view.sessionsRows).toHaveLength(TELEMETRY_SMOKE.sessionsRows.length);
  });

  it("leaves a snapshot without an end date unchanged", () => {
    const legacy = { ...TELEMETRY_SMOKE, endDate: undefined };
    expect(snapshotForRange(legacy, "7d")).toBe(legacy);
  });
});
