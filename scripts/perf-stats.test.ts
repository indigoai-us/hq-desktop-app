// Unit tests for the perf harness's statistics + regression judgement.
//
// The harness is only useful if its verdicts are trustworthy, and "trustworthy"
// here means two things that pull against each other: it must notice a real
// slowdown, and it must NOT cry wolf when the laptop was just warm. Both
// directions are pinned below with hand-built samples, so the tolerance policy
// can be changed deliberately rather than discovered by a confusing run.
//
// Run with the rest of the fast local checks: `pnpm perf:lint`.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RELATIVE_TOLERANCE,
  compareMetric,
  mean,
  median,
  percentile,
  renderTable,
  stdev,
  summarise,
} from "./perf/stats.mjs";

describe("descriptive statistics", () => {
  it("median handles odd and even sample counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it("percentile uses nearest rank (no interpolation on tiny N)", () => {
    // With 5 samples, interpolating a p95 invents a number that was never
    // measured. Nearest rank returns the worst observed sample instead.
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
    expect(percentile([1, 2, 3, 4, 100], 0.5)).toBe(3);
  });

  it("mean and sample stdev", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdev([2, 4, 6])).toBeCloseTo(2, 6);
    expect(stdev([5])).toBe(0);
  });

  it("summarise discards the warm-up run from the front", () => {
    // The first repetition pays cold module compilation, an empty HTTP cache
    // and an unwarmed JIT — costs a user of a running app never pays.
    const s = summarise([500, 100, 102, 98], 1);
    expect(s.discarded).toBe(1);
    expect(s.n).toBe(3);
    expect(s.median).toBe(100);
    expect(s.max).toBe(102);
  });

  it("summarise keeps everything when there is nothing to spare", () => {
    expect(summarise([42], 1).n).toBe(1);
  });
});

describe("regression judgement", () => {
  const baseline = { median: 100, stdev: 5, p95: 110 };

  it("calls a large, clean slowdown a regression", () => {
    const result = compareMetric({ median: 150 }, baseline);
    expect(result.verdict).toBe("regressed");
    expect(result.deltaPct).toBeCloseTo(0.5, 6);
  });

  it("does not fire inside the relative tolerance", () => {
    // 20% worse, well outside the noise band — but under the 25% tolerance.
    expect(compareMetric({ median: 120 }, baseline).verdict).toBe("ok");
    expect(DEFAULT_RELATIVE_TOLERANCE).toBe(0.25);
  });

  it("does not fire when the baseline itself is noisy", () => {
    // Same +50% move, but the baseline wobbles by ±40: 50 is inside 2 sigma,
    // so this is not news. This is the rule that stops a flaky metric from
    // failing every single run.
    const noisy = { median: 100, stdev: 40 };
    expect(compareMetric({ median: 150 }, noisy).verdict).toBe("ok");
  });

  it("does not fire on a tiny absolute move", () => {
    // 0.4ms -> 0.9ms is +125%, and outside a 0-sigma band, but nobody can feel
    // half a millisecond.
    const tiny = { median: 0.4, stdev: 0 };
    expect(
      compareMetric({ median: 0.9 }, tiny, { absoluteFloor: 1 }).verdict,
    ).toBe("ok");
  });

  it("reports improvements without failing", () => {
    expect(compareMetric({ median: 50 }, baseline).verdict).toBe("improved");
    expect(compareMetric({ median: 95 }, baseline).verdict).toBe("ok");
  });

  it("marks an unseen metric as new rather than regressed", () => {
    expect(compareMetric({ median: 100 }, undefined).verdict).toBe("new");
    expect(compareMetric({ median: NaN }, baseline).verdict).toBe("missing");
  });

  it("honours higherIsWorse: false", () => {
    const result = compareMetric({ median: 40 }, baseline, {
      higherIsWorse: false,
    });
    expect(result.verdict).toBe("regressed");
  });
});

describe("table rendering", () => {
  it("prints the numbers and flags the regression", () => {
    const table = renderTable([
      {
        label: "scroll · messages · avg frame",
        unit: "ms",
        summary: { median: 21.4, p95: 33.1, stdev: 1.2 },
        baseline: { median: 8.4, stdev: 0.3 },
        comparison: { verdict: "regressed", delta: 13, deltaPct: 1.55 },
      },
      {
        label: "idle · main-thread busy",
        unit: "ms",
        summary: { median: 0, p95: 0, stdev: 0 },
        baseline: undefined,
        comparison: { verdict: "new", delta: NaN, deltaPct: NaN },
      },
    ]);

    expect(table).toContain("scroll · messages · avg frame (ms)");
    expect(table).toContain("21.4");
    expect(table).toContain("REGRESSED");
    expect(table).toContain("new");
    // A metric with no baseline must still show its measured value.
    expect(table).toMatch(/idle · main-thread busy \(ms\)\s+0\.0/);
  });
});
