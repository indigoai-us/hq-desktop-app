/**
 * The usage pricing switch for an account on an older paid plan
 * (usage-only-pricing US-026, US-012 criterion 5). Read from
 * `GET /v1/billing/usage-switch` (hq-pro US-014): the switch date, today's
 * flat price and the trailing-30 usage estimate before the switch, and the
 * 30-day preview window after it. Shared by Settings > Usage and the Core
 * menu so both say the same thing. Every number is hq-pro's.
 */

import type { AdapterResult, Json } from "@hq/platform";
import { formatUsd } from "./core-usage-model.js";

export type UsageSwitchPhase = "scheduled" | "preview";

export interface UsageSwitchInfo {
  phase: UsageSwitchPhase;
  /** ISO switch date. */
  switchDate: string;
  /** ISO end of the 30-day preview; null when hq-pro didn't say. */
  previewEndsAt: string | null;
  previewDays: number;
  /** Today's flat plan a month; null when hq-pro couldn't read it. */
  todayMonthlyCents: number | null;
  /** Trailing-30 usage bill; null when hq-pro didn't compute one. */
  estimateCents: number | null;
  /** False when some days or meters aren't measured, so the estimate is a floor. */
  estimateComplete: boolean;
}

export interface UsageSwitchSource {
  getUsageSwitch?(companyUid: string): Promise<AdapterResult<Json>>;
  getPersonalUsageSwitch?(): Promise<AdapterResult<Json>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoDate(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * The switch an account should be told about, or null: no switch date, kill
 * switch off, already billed on usage, or a body that can't be read.
 */
export function usageSwitchFromBody(body: unknown): UsageSwitchInfo | null {
  if (!isRecord(body) || body.enabled === false) return null;
  const phase = body.phase;
  if (phase !== "scheduled" && phase !== "preview") return null;
  const switchDate = isoDate(body.switchDate);
  if (!switchDate) return null;
  return {
    phase,
    switchDate,
    previewEndsAt: isoDate(body.previewEndsAt),
    previewDays: finite(body.previewDays) ?? 30,
    todayMonthlyCents: finite(body.todayMonthlyCents),
    estimateCents: finite(body.estimateCents),
    estimateComplete: body.estimateComplete === true,
  };
}

/** Read the switch for a company (by uid) or the personal account (null). Never throws. */
export async function readUsageSwitch(
  source: UsageSwitchSource | null | undefined,
  companyUid: string | null,
): Promise<UsageSwitchInfo | null> {
  const work =
    companyUid === null
      ? source?.getPersonalUsageSwitch
        ? () => source.getPersonalUsageSwitch!()
        : null
      : source?.getUsageSwitch
        ? () => source.getUsageSwitch!(companyUid)
        : null;
  if (!work) return null;
  try {
    const res = await work();
    return res.ok ? usageSwitchFromBody(res.value) : null;
  } catch (err) {
    console.warn("[usage-switch] read threw", err instanceof Error ? err.name : "unknown");
    return null;
  }
}

/** "19 December 2026". */
export function switchDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export interface UsageSwitchLines {
  /** "Moves to usage pricing on 19 December 2026" / "Usage pricing preview until 18 January 2027". */
  headline: string;
  /** "Today $50.00 a month · On usage about $12.40 a month"; "" when neither number is known. */
  compare: string;
  /** One plain sentence on what happens. */
  note: string;
}

/**
 * The switch copy. Before the switch: the date, today's price and the
 * would-be usage bill. During the preview: what this month's usage would be
 * billed so far (`previewBillCents`, from {@link previewBillCents}) and that
 * nothing is charged until the preview ends. `previewPartial` is true when
 * some days or meters aren't measured yet: the bill so far is then a floor and
 * says "at least", never an exact amount.
 */
export function usageSwitchLines(
  info: UsageSwitchInfo,
  previewBillCents: number | null = null,
  previewPartial = false,
): UsageSwitchLines {
  if (info.phase === "scheduled") {
    const parts: string[] = [];
    if (info.todayMonthlyCents !== null) parts.push(`Today ${formatUsd(info.todayMonthlyCents)} a month`);
    if (info.estimateCents !== null) {
      parts.push(`On usage ${info.estimateComplete ? "about" : "at least"} ${formatUsd(info.estimateCents)} a month`);
    }
    return {
      headline: `Moves to usage pricing on ${switchDateLabel(info.switchDate)}`,
      compare: parts.join(" · "),
      note:
        info.estimateCents === null
          ? "The usage estimate isn't available yet."
          : "The estimate is your last 30 days of usage at usage prices.",
    };
  }
  const ends = info.previewEndsAt ? switchDateLabel(info.previewEndsAt) : null;
  return {
    headline: ends ? `Usage pricing preview until ${ends}` : `Usage pricing preview (${info.previewDays} days)`,
    compare: previewBillCents === null ? "" : `Your bill so far would be ${previewPartial ? "at least " : ""}${formatUsd(previewBillCents)}`,
    note: `Nothing is charged for usage during the ${info.previewDays}-day preview.${ends ? ` Billing on usage starts ${ends}.` : ""}`,
  };
}

/** The month's usage past the included amount: what the preview would bill so far. */
export function previewBillCents(usageCents: number | null, allowanceCents: number | null): number | null {
  if (usageCents === null) return null;
  return Math.max(0, usageCents - (allowanceCents ?? 0));
}
