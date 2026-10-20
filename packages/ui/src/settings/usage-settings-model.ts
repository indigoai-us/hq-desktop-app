/**
 * Settings > Usage text helpers (usage-only-pricing US-018). The reads live in
 * usage-accounts-model.ts; this file keeps the spend limit parser and the
 * period, trial and limit labels.
 */

import { formatUsd } from "../home/core-usage-model.js";

export type SpendLimitDetail =
  | {
      noLimit: false;
      limitCents: number;
      /** False when the default limit applies. */
      custom: boolean;
      paused: boolean;
    }
  | {
      /**
       * No monthly limit: an owner or admin removed it, or an existing paying
       * account switched to usage pricing without one (hq-pro #5069:
       * `limitCents: null`, `noLimit: true`). Nothing pauses for spend.
       */
      noLimit: true;
      limitCents: null;
      custom: boolean;
      paused: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The spend limit from `GET /v1/billing/spend-limit`. A body that says there
 * is no limit (`noLimit: true`, or `limitCents: null`) is a real state, not a
 * failed read. Null only for a body that is neither.
 */
export function spendLimitFromBody(body: unknown): SpendLimitDetail | null {
  if (!isRecord(body)) return null;
  const custom = body.custom === true;
  const paused = body.paused === true;
  if (body.noLimit === true || body.limitCents === null) {
    return { noLimit: true, limitCents: null, custom, paused };
  }
  const limitCents = finite(body.limitCents);
  if (limitCents === null) return null;
  return { noLimit: false, limitCents, custom, paused };
}

/** "Oct 1 to Oct 31" for the statement period. */
export function periodLabel(periodStart: string, periodEnd: string | null): string {
  const fmt = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return periodEnd ? `${fmt(periodStart)} to ${fmt(periodEnd)}` : `Since ${fmt(periodStart)}`;
}

/** "Ends Nov 3": the trial end date; "" when the date can't be read. */
export function trialEndLabel(endsAt: string): string {
  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) return "";
  return `Ends ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/** "$100.00 a month (default)", or "No limit". */
export function spendLimitLine(limit: SpendLimitDetail): string {
  if (limit.noLimit) return "No limit";
  return `${formatUsd(limit.limitCents)} a month${limit.custom ? "" : " (default)"}`;
}
