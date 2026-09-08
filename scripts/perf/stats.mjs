/**
 * Statistics + regression judgement for the local perf harness.
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * A perf number taken once on a laptop is noise. Thermal state, other apps,
 * battery vs. mains and the JIT's warm-up all move a frame-time mean by tens of
 * percent between back-to-back runs. So every scenario is measured N times, the
 * FIRST run is discarded as warm-up, and we report the MEDIAN (robust to a
 * single hitchy run) alongside p95 (which is what actually feels bad) and the
 * standard deviation (which tells you whether to believe any of it).
 *
 * Regression judgement is deliberately reluctant: a run must be BOTH
 * meaningfully worse in relative terms AND outside the noise band recorded in
 * the baseline before it is called a regression. A harness that cries wolf gets
 * ignored, and an ignored harness is worse than none.
 */

/** Ascending copy. */
function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

export function median(values) {
  if (values.length === 0) return NaN;
  const s = sorted(values);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile (p in 0..1). Small N makes interpolation a lie. */
export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const s = sorted(values);
  const rank = Math.ceil(p * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

export function mean(values) {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation (N-1). Returns 0 for a single sample. */
export function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Summarise a set of repetitions of one metric.
 *
 * `warmup` samples are dropped from the FRONT: the first navigation of a fresh
 * browser pays for cold module compilation, an empty HTTP cache and an unwarmed
 * JIT, none of which a user pays on a running app.
 */
export function summarise(samples, warmup = 1) {
  const kept = samples.length > warmup ? samples.slice(warmup) : samples;
  return {
    n: kept.length,
    discarded: samples.length - kept.length,
    median: median(kept),
    p95: percentile(kept, 0.95),
    min: kept.length ? Math.min(...kept) : NaN,
    max: kept.length ? Math.max(...kept) : NaN,
    stdev: stdev(kept),
    samples: kept,
  };
}

/** Default: 25% worse before we will even consider calling it a regression. */
export const DEFAULT_RELATIVE_TOLERANCE = 0.25;
/** ...and it must also sit outside 2 standard deviations of the baseline. */
export const DEFAULT_SIGMA = 2;

/**
 * Compare one metric against its baseline.
 *
 * `higherIsWorse` is true for latencies and frame times, false for things like
 * "frames per second" (none today, but the field keeps the semantics explicit
 * rather than implied by the metric's name).
 *
 * A verdict of "regressed" requires BOTH:
 *   - the median moved more than `relativeTolerance` in the bad direction, AND
 *   - the new median is outside baselineMedian ± sigma * baselineStdev.
 *
 * The second condition is what stops a noisy metric (high stdev) from firing
 * every run: if the baseline itself wobbles by 30%, a 26% move is not news.
 */
export function compareMetric(
  current,
  baseline,
  {
    relativeTolerance = DEFAULT_RELATIVE_TOLERANCE,
    sigma = DEFAULT_SIGMA,
    higherIsWorse = true,
    /** Ignore moves smaller than this many absolute units (ms). */
    absoluteFloor = 1,
  } = {},
) {
  if (!baseline || !Number.isFinite(baseline.median)) {
    return { verdict: "new", delta: NaN, deltaPct: NaN };
  }
  if (!Number.isFinite(current.median)) {
    return { verdict: "missing", delta: NaN, deltaPct: NaN };
  }

  const delta = current.median - baseline.median;
  const deltaPct = baseline.median === 0 ? 0 : delta / baseline.median;
  const worse = higherIsWorse ? delta > 0 : delta < 0;

  if (!worse) {
    return {
      verdict: Math.abs(deltaPct) > relativeTolerance ? "improved" : "ok",
      delta,
      deltaPct,
    };
  }

  const band = sigma * (baseline.stdev ?? 0);
  const outsideNoise = Math.abs(delta) > band;
  const beyondTolerance = Math.abs(deltaPct) > relativeTolerance;
  const beyondFloor = Math.abs(delta) > absoluteFloor;

  return {
    verdict:
      beyondTolerance && outsideNoise && beyondFloor ? "regressed" : "ok",
    delta,
    deltaPct,
    noiseBand: band,
  };
}

/** Right-pad/truncate for the fixed-width console table. */
function cell(text, width, align = "left") {
  const s = String(text);
  const clipped = s.length > width ? `${s.slice(0, width - 1)}…` : s;
  return align === "right"
    ? clipped.padStart(width)
    : clipped.padEnd(width);
}

const NUMBER = (v, digits = 1) =>
  Number.isFinite(v) ? v.toFixed(digits) : "—";

/**
 * Render the before/after table. Printed on every run — pass or fail — because
 * the point of the harness is to SEE the numbers, not just to be told nothing
 * broke.
 */
export function renderTable(rows) {
  const widths = [38, 10, 10, 10, 10, 12];
  const header =
    cell("metric", widths[0]) +
    cell("median", widths[1], "right") +
    cell("p95", widths[2], "right") +
    cell("stdev", widths[3], "right") +
    cell("baseline", widths[4], "right") +
    cell("change", widths[5], "right");

  const lines = [header, "-".repeat(header.length)];

  for (const row of rows) {
    const change =
      row.comparison.verdict === "new"
        ? "new"
        : Number.isFinite(row.comparison.deltaPct)
          ? `${row.comparison.deltaPct >= 0 ? "+" : ""}${(row.comparison.deltaPct * 100).toFixed(1)}%`
          : "—";

    const mark =
      row.comparison.verdict === "regressed"
        ? " REGRESSED"
        : row.comparison.verdict === "improved"
          ? " better"
          : "";

    lines.push(
      cell(`${row.label}${row.unit ? ` (${row.unit})` : ""}`, widths[0]) +
        cell(NUMBER(row.summary.median), widths[1], "right") +
        cell(NUMBER(row.summary.p95), widths[2], "right") +
        cell(NUMBER(row.summary.stdev), widths[3], "right") +
        cell(NUMBER(row.baseline?.median), widths[4], "right") +
        cell(change + mark, widths[5] + 10, "right"),
    );
  }

  return lines.join("\n");
}
