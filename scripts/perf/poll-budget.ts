/**
 * Pure polling-budget detectors used by scripts/perf-budget-contract.test.ts.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app felt permanently "busy" because it never idled. The Rust session
 * scanner walked every Claude/Codex session directory every 5 seconds forever,
 * and several frontend stores ran their own `setInterval` refreshes that kept
 * rewriting reactive state whether or not the window was visible. Each tick
 * woke the main thread, re-ran Svelte effects, and (on a transparent window
 * with a live glass layer) forced the compositor to re-blur. The fix was a
 * two-part rule that this module keeps enforced:
 *
 *   1. Long-lived pollers run at a HUMAN cadence, not an animation cadence.
 *      Nothing that fetches state should fire more than once every 10 seconds.
 *   2. Long-lived pollers PAUSE when the window is hidden. A menubar app spends
 *      most of its life behind other windows; polling then is pure waste.
 *
 * Exceptions are real (a countdown ticker genuinely needs 1s; a connect wizard
 * genuinely needs 3s while it is on screen), so both rules are allowlisted
 * rather than absolute -- see the allowlist in the contract test, where every
 * entry carries the reason it is exempt.
 */

/** Anything slower than this is fine; anything faster needs a justification. */
export const POLL_FLOOR_MS = 10_000;

export interface IntervalCallSite {
  file: string;
  /** 1-based line of the `setInterval(` call. */
  line: number;
  /** The resolved period in ms, or null when it could not be resolved. */
  periodMs: number | null;
  /** The raw period expression as written (literal or identifier). */
  periodExpression: string;
}

/** `15_000` / `15000` / `1e4` -> number. Returns null for anything else. */
function parseNumericLiteral(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9][0-9_]*(\.[0-9_]+)?(e[0-9]+)?$/i.test(trimmed)) return null;
  const value = Number(trimmed.replace(/_/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * Collect `const NAME = <number>;` declarations from a source string. Used to
 * build a repo-wide map so a `setInterval(fn, POLL_INTERVAL_MS)` written in one
 * file still resolves when the constant is exported from another.
 */
export function collectNumericConstants(
  source: string,
): Map<string, number> {
  const constants = new Map<string, number>();
  const pattern =
    /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*number\s*)?=\s*([0-9][0-9_.e]*)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const value = parseNumericLiteral(match[2]);
    if (value != null) constants.set(match[1], value);
  }
  return constants;
}

/**
 * Find every `setInterval(...)` call site and resolve its period.
 *
 * The period is the argument after the LAST top-level comma of the call, which
 * is found by scanning forward from `setInterval(` with a depth counter so
 * arrow-function bodies, object literals and nested calls in the first
 * argument do not confuse it.
 */
export function findIntervalCallSites(
  file: string,
  source: string,
  constants: Map<string, number> = new Map(),
): IntervalCallSite[] {
  const localConstants = collectNumericConstants(source);
  const resolve = (name: string): number | null =>
    localConstants.get(name) ?? constants.get(name) ?? null;

  const sites: IntervalCallSite[] = [];
  const opener = /\bsetInterval\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    let lastComma = -1;

    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      } else if (ch === "," && depth === 1) {
        lastComma = i;
      }
    }

    if (close === -1) continue;

    const periodExpression =
      lastComma === -1 ? "" : source.slice(lastComma + 1, close).trim();

    // `setInterval(fn)` with no period, or a type-only declaration such as
    // `setInterval(fn: () => void, ms: number): unknown;` in an interface --
    // neither is a real poller.
    if (!periodExpression || /[:;]/.test(periodExpression)) continue;

    const periodMs =
      parseNumericLiteral(periodExpression) ??
      (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(periodExpression)
        ? resolve(periodExpression)
        : null);

    sites.push({
      file,
      line: source.slice(0, match.index).split("\n").length,
      periodMs,
      periodExpression,
    });
  }

  return sites;
}

/** Call sites that tick faster than the floor (unresolved periods are ignored). */
export function findFastPollers(
  sites: IntervalCallSite[],
  floorMs = POLL_FLOOR_MS,
): IntervalCallSite[] {
  return sites.filter((s) => s.periodMs != null && s.periodMs < floorMs);
}

/** A module that owns a long-lived poller must observe page visibility. */
export function pausesOnVisibility(source: string): boolean {
  return (
    source.includes("visibilitychange") || source.includes("visibilityState")
  );
}

export function formatIntervalSites(sites: IntervalCallSite[]): string {
  return sites
    .map(
      (s) =>
        `  ${s.file}:${s.line}  setInterval(..., ${s.periodExpression}) = ${s.periodMs}ms`,
    )
    .join("\n");
}
