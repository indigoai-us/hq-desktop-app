/**
 * My Telemetry from the real source: hq-pro `GET /v1/telemetry/me`.
 *
 * The endpoint returns the caller's cross-company rollups for a date range:
 * a daily series and totals (sessions, events, skills, tokens by model,
 * delivery outcomes). It has no per-session rows, no per-company split and no
 * bot breakdown, so those parts of the snapshot stay empty and `notice` says
 * what is missing. Nothing here is invented.
 */
import type { AdapterPromise, Json } from "@hq/platform";
import {
  formatTokens,
  listRateUsd,
  type DayStack,
  type ModelId,
  type ModelUsage,
  type TelemetryRange,
  type TelemetrySnapshot,
} from "./telemetry-model.js";

export interface MyTelemetryApi {
  getMyTelemetry?(from: string, to: string): AdapterPromise<Json>;
}

/** Per-session rows, the company split and bots need endpoints that do not exist yet. */
export const MISSING_SESSION_ROWS =
  "Per-session rows, the company split, and bots acting as you need a per-session telemetry endpoint. Totals below are real.";

export class TelemetryLoadError extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(reason);
    this.name = "TelemetryLoadError";
  }
}

const RANGE_DAYS: Record<TelemetryRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().split("T")[0]!;
}

/** Inclusive UTC window ending today. */
export function rangeWindow(range: TelemetryRange, now: number = Date.now()): { from: string; to: string } {
  const days = RANGE_DAYS[range] ?? 30;
  return { from: isoDay(now - (days - 1) * DAY_MS), to: isoDay(now) };
}

function dayLabel(iso: string): string {
  const at = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(at)) return iso;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

interface Buckets {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buckets(value: unknown): Buckets {
  const r = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheCreationTokens: num(r.cacheCreationTokens),
    cacheReadTokens: num(r.cacheReadTokens),
  };
}

function bucketTotal(b: Buckets): number {
  return b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens;
}

/** Claude family for list-rate pricing; other vendors return null. */
export function modelFamily(model: string): ModelId | null {
  const id = model.toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

const FAMILY_LABEL: Record<ModelId, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

function unattributedNote(otherModels: string[], noModelTokens: number): string {
  const parts: string[] = [];
  if (otherModels.length > 0) {
    const shown = otherModels.slice(0, 3).join(", ");
    const more = otherModels.length > 3 ? ` and ${otherModels.length - 3} more` : "";
    parts.push(`Other covers non-Claude models (${shown}${more}), which have no list price here.`);
  }
  if (noModelTokens > 0) parts.push(`${formatTokens(noModelTokens)} tokens were recorded without a model.`);
  return parts.join(" ");
}

/** Build the view snapshot from a `/v1/telemetry/me` body. */
export function snapshotFromMe(body: unknown, range: TelemetryRange): TelemetrySnapshot {
  const root = record(body);
  const totals = record(root.totals);
  const daily = Array.isArray(root.daily) ? root.daily : [];
  const from = typeof root.from === "string" ? root.from : "";
  const to = typeof root.to === "string" ? root.to : "";

  const familyTotals = new Map<ModelId, Buckets & { models: Set<string> }>();
  let allTokens = 0;
  let otherTokens = 0;
  for (const [model, value] of Object.entries(record(totals.tokensByModel))) {
    const b = buckets(value);
    const total = bucketTotal(b);
    allTokens += total;
    const family = modelFamily(model);
    if (!family) {
      otherTokens += total;
      continue;
    }
    const acc = familyTotals.get(family) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      models: new Set<string>(),
    };
    acc.inputTokens += b.inputTokens;
    acc.outputTokens += b.outputTokens;
    acc.cacheCreationTokens += b.cacheCreationTokens;
    acc.cacheReadTokens += b.cacheReadTokens;
    acc.models.add(model);
    familyTotals.set(family, acc);
  }

  const models: ModelUsage[] = (["opus", "sonnet", "haiku"] as const)
    .filter((family) => familyTotals.has(family))
    .map((family) => {
      const acc = familyTotals.get(family)!;
      return {
        model: family,
        label: FAMILY_LABEL[family],
        hint: `${acc.models.size} model${acc.models.size === 1 ? "" : "s"}`,
        input: acc.inputTokens,
        output: acc.outputTokens,
        cacheWrite: acc.cacheCreationTokens,
        cacheRead: acc.cacheReadTokens,
      };
    });

  const sum = buckets(totals.tokens);
  const tokenSum = bucketTotal(sum) || allTokens;
  // The headline counts every token; the family rows only Claude models. Usage
  // from other vendors, or recorded with no model, goes in one remainder row.
  const familyTokens = allTokens - otherTokens;
  const unattributedTokens = Math.max(0, tokenSum - familyTokens);
  const otherModels = Object.keys(record(totals.tokensByModel)).filter((m) => !modelFamily(m));
  const unattributed =
    unattributedTokens > 0
      ? {
          tokens: unattributedTokens,
          note: unattributedNote(otherModels, tokenSum - allTokens),
        }
      : undefined;

  const days: DayStack[] = daily.map((point, i) => {
    const p = record(point);
    const stack: DayStack = { label: dayLabel(String(p.date ?? "")), opus: 0, sonnet: 0, haiku: 0 };
    for (const [model, value] of Object.entries(record(p.tokensByModel))) {
      const family = modelFamily(model);
      if (family) stack[family] += bucketTotal(buckets(value));
    }
    if (i === daily.length - 1) stack.today = true;
    return stack;
  });
  const peak = days.reduce((m, d) => Math.max(m, d.opus + d.sonnet + d.haiku), 0);
  const dayLabels =
    days.length === 0
      ? []
      : [...new Set([days[0]!.label, days[Math.floor(days.length / 2)]!.label, days[days.length - 1]!.label])];

  const skillEntries = Object.entries(record(totals.skills))
    .map(([name, count]) => ({ name, count: num(count) }))
    .filter((row) => row.name.trim() && row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const outcomes = record(totals.outcomes);
  const deploys = num(outcomes["deploy-succeeded"]);
  const shipped = num(outcomes["story-completed"]) + num(outcomes["project-shipped"]);
  const sessions = num(totals.distinctSessions);

  const mixParts = models.map((m) => ({
    label: m.label,
    share: pct(m.input + m.output + m.cacheWrite + m.cacheRead, tokenSum),
  }));
  if (unattributedTokens > 0) mixParts.push({ label: "other", share: pct(unattributedTokens, tokenSum) });
  const modelMix = mixParts
    .filter((part) => part.share > 0)
    .sort((a, b) => b.share - a.share)
    .map((part) => `${part.label} ${part.share}%`)
    .join(" · ");

  const dayCount = days.length || RANGE_DAYS[range];
  const listCostUsd = models.reduce((total, row) => total + listRateUsd(row), 0);
  const deployedShare = pct(deploys, sessions);
  const shippedShare = pct(shipped, sessions);

  return {
    range,
    rangeLabel: from && to ? `${dayLabel(from)} – ${dayLabel(to)}` : "",
    subtitle: "you, across every company",
    sessions,
    sessionsDelta: "",
    tokensLabel: formatTokens(tokenSum),
    tokensDelta: "",
    modelMix,
    storiesShipped: shipped,
    deploys,
    distinctSkills: skillEntries.length,
    medianGap: "—",
    perDay: formatTokens(Math.round(tokenSum / Math.max(1, dayCount))),
    perSession: "—",
    cacheReadShare: `${pct(sum.cacheReadTokens, tokenSum)}%`,
    listCostUsd,
    peakLabel: peak > 0 ? `peak ${formatTokens(peak)}` : "",
    days,
    dayLabels,
    sessionsRows: [],
    skills: skillEntries,
    bots: [],
    models,
    byCompany: [],
    byActor: [],
    unattributed,
    io: {
      input: formatTokens(sum.inputTokens),
      cacheRead: formatTokens(sum.cacheReadTokens),
      cacheWrite: formatTokens(sum.cacheCreationTokens),
      output: formatTokens(sum.outputTokens),
    },
    outcomeCounts: {
      all: sessions,
      live: 0,
      deployed: deploys,
      deployedMeta: "",
      shipped,
      shippedMeta: "",
      blocked: 0,
      blockedMeta: "",
      none: 0,
      noneMeta: "",
    },
    mix: {
      deployed: deployedShare,
      shipped: shippedShare,
      blocked: 0,
      none: 0,
      other: Math.max(0, 100 - deployedShare - shippedShare),
    },
    notice: MISSING_SESSION_ROWS,
    optedOut: root.optedOut === true,
  };
}

/** Plain reason for a failed load. Raw transport text stays in `detail`. */
export function telemetryErrorReason(code: string | undefined, message: string | undefined): string {
  const text = `${code ?? ""} ${message ?? ""}`;
  if (/402|plan|payment/i.test(text)) return "My Telemetry needs the Individual plan on your personal account.";
  if (/401|403|auth|sign/i.test(text)) return "Your sign-in expired. Sign in again to see your telemetry.";
  if (/no-person-entity|404/i.test(text)) return "Your HQ account has no personal profile yet, so there is no telemetry to show.";
  if (/unavailable|not-yet-implemented|desktop-only/i.test(text)) return "Telemetry is not available in this window.";
  return "Could not reach HQ. Check your connection and retry.";
}

/** Fetcher for the telemetry cache, bound to the platform agents API. */
export function createMyTelemetryFetcher(api: MyTelemetryApi | null | undefined, now: () => number = Date.now) {
  return async (range: TelemetryRange = "30d"): Promise<TelemetrySnapshot> => {
    if (!api?.getMyTelemetry) {
      throw new TelemetryLoadError(telemetryErrorReason("unavailable", ""), "getMyTelemetry missing");
    }
    const window = rangeWindow(range, now());
    const res = await api.getMyTelemetry(window.from, window.to);
    if (!res.ok) {
      throw new TelemetryLoadError(
        telemetryErrorReason(res.code, res.message),
        [res.code, res.message].filter(Boolean).join(": "),
      );
    }
    return snapshotFromMe(res.value, range);
  };
}
