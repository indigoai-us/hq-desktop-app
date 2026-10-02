import { describe, expect, it } from "vitest";
import { createTelemetryCache } from "./telemetry-cache.js";
import {
  LIST_RATE_LABEL,
  LIST_RATES,
  formatUsd,
  listRateUsd,
  outcomesForFilter,
  sessionsForFilter,
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
