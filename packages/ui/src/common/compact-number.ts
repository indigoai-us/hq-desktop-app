/**
 * OWNER-R28: the one compact-number formatter. Every abbreviated number in the
 * app (tokens, runs, counts, chart axes and tooltips) goes through here.
 *
 * Under 1,000 the number is plain. From there K, M, B and T, with at most three
 * significant digits and trailing zeros dropped: 1.5K, 239M, 3.97B, 96.6B. A
 * value never shows 1,000 or more in front of a unit; rounding that reaches
 * 1,000 rolls over to the next unit (999,950,000 is 1B, 999,999 is 1M).
 */

const UNITS = [
  { unit: "K", base: 1e3 },
  { unit: "M", base: 1e6 },
  { unit: "B", base: 1e9 },
  { unit: "T", base: 1e12 },
] as const;

export interface CompactOptions {
  /** Significant digits once a unit applies (default 3). */
  significant?: number;
}

function round(value: number, significant: number): number {
  return Number(value.toPrecision(significant));
}

export function compactNumber(value: number, options: CompactOptions = {}): string {
  if (!Number.isFinite(value)) return "";
  const significant = Math.max(1, options.significant ?? 3);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (Math.round(abs) < 1000) return `${sign}${Math.round(abs)}`;
  let i = UNITS.length - 1;
  while (i > 0 && abs < UNITS[i]!.base) i -= 1;
  let shown = round(abs / UNITS[i]!.base, significant);
  // Rounding can reach 1000 (999.95K): move up a unit instead of printing 1000K.
  while (shown >= 1000 && i < UNITS.length - 1) {
    i += 1;
    shown = round(abs / UNITS[i]!.base, significant);
  }
  return `${sign}${shown}${UNITS[i]!.unit}`;
}

/** The exact value with thousands separators, for hover text. */
export function exactNumber(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "";
}
