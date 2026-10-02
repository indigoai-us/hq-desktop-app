/**
 * Personal telemetry model (US-032).
 *
 * Token cost is the public list rate, labelled "estimated at list price".
 * Rates are Anthropic's published per-million-token prices with the cache
 * read and cache write discounts. No chart library lives in this module.
 */

export type TelemetryRange = "7d" | "30d" | "90d";
export type TelemetryPage = "overview" | "sessions" | "tokens" | "outcomes";
export type SessionFilter = "all" | "mine" | "bots" | "outpost" | "failed";
export type OutcomeFilter = "all" | "deployed" | "shipped" | "blocked" | "none";
export type TokenStack = "model" | "company" | "actor";
export type ModelId = "opus" | "sonnet" | "haiku";

/** USD per 1,000,000 tokens. */
export const LIST_RATES: Record<
  ModelId,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

export const LIST_RATE_LABEL = "estimated at list price";

export interface TokenClasses {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelUsage extends TokenClasses {
  model: ModelId;
  label: string;
  hint: string;
}

export interface ShareRow {
  id: string;
  label: string;
  mark: string;
  bot: boolean;
  meta: string;
  tokens: number;
  costUsd: number;
}

export interface DayStack {
  label: string;
  today?: boolean;
  opus: number;
  sonnet: number;
  haiku: number;
}

export interface TelemetrySession {
  id: string;
  when: string;
  day: string;
  company: string;
  mark: string;
  project: string;
  detail: string;
  host: string;
  length: string;
  tokensLabel: string;
  tokens: number;
  outcome: string;
  outcomeKind: "live" | "ok" | "error" | "dim";
  actor: "you" | "bot" | "outpost";
  failed: boolean;
  outcomeBucket: "deployed" | "shipped" | "blocked" | "none" | "other" | "live";
  openLabel: string;
  costLabel: string;
  tokensIn: string;
  tokensOut: string;
  branch: string;
  skills: string[];
  timeline: { at: string; text: string; live?: boolean }[];
  modelSplit: { opus: number; sonnet: number; haiku: number };
  /** Whole days before the snapshot end date; 0 is today. */
  daysAgo?: number;
}

export interface SkillUse {
  name: string;
  count: number;
}

export interface BotActor {
  name: string;
  meta: string;
  status: string;
  live: boolean;
}

export interface TelemetrySnapshot {
  range: TelemetryRange;
  rangeLabel: string;
  /** ISO date (YYYY-MM-DD) of the last day in `days`. */
  endDate?: string;
  subtitle: string;
  sessions: number;
  sessionsDelta: string;
  tokensLabel: string;
  tokensDelta: string;
  modelMix: string;
  storiesShipped: number;
  deploys: number;
  distinctSkills: number;
  medianGap: string;
  perDay: string;
  perSession: string;
  cacheReadShare: string;
  listCostUsd: number;
  peakLabel: string;
  days: DayStack[];
  dayLabels: string[];
  sessionsRows: TelemetrySession[];
  skills: SkillUse[];
  bots: BotActor[];
  models: ModelUsage[];
  byCompany: ShareRow[];
  byActor: ShareRow[];
  io: { input: string; cacheRead: string; cacheWrite: string; output: string };
  outcomeCounts: {
    all: number;
    live: number;
    deployed: number;
    deployedMeta: string;
    shipped: number;
    shippedMeta: string;
    blocked: number;
    blockedMeta: string;
    none: number;
    noneMeta: string;
  };
  mix: { deployed: number; shipped: number; blocked: number; none: number; other: number };
}

export function listRateUsd(usage: ModelUsage): number {
  const rate = LIST_RATES[usage.model];
  const million = 1_000_000;
  return (
    (usage.input * rate.input +
      usage.output * rate.output +
      usage.cacheWrite * rate.cacheWrite +
      usage.cacheRead * rate.cacheRead) /
    million
  );
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2).replace(/0$/, "")}M`.replace(".0M", "M");
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function sessionsForFilter(
  rows: readonly TelemetrySession[],
  filter: SessionFilter,
): TelemetrySession[] {
  if (filter === "all") return [...rows];
  if (filter === "mine") return rows.filter((r) => r.actor === "you");
  if (filter === "bots") return rows.filter((r) => r.actor === "bot");
  if (filter === "outpost") return rows.filter((r) => r.actor === "outpost");
  return rows.filter((r) => r.failed || r.outcomeKind === "error");
}

export function outcomesForFilter(
  rows: readonly TelemetrySession[],
  filter: OutcomeFilter,
): TelemetrySession[] {
  const produced = rows.filter((r) => r.outcomeBucket !== "live");
  if (filter === "all") return produced;
  const bucket = filter === "none" ? "none" : filter;
  return produced.filter((r) => r.outcomeBucket === bucket);
}

export function sharePercent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function barPercents(day: DayStack, max: number): { opus: number; sonnet: number; haiku: number } {
  const scale = max <= 0 ? 0 : 100 / max;
  return {
    opus: Math.round(day.opus * scale),
    sonnet: Math.round(day.sonnet * scale),
    haiku: Math.round(day.haiku * scale),
  };
}

export function stackMax(days: readonly DayStack[]): number {
  return days.reduce((m, d) => Math.max(m, d.opus + d.sonnet + d.haiku), 0);
}

export function toCsv(snapshot: TelemetrySnapshot): string {
  const header = ["when", "company", "project", "host", "length", "tokens", "outcome", "cost"];
  const lines = snapshot.sessionsRows.map((r) =>
    [r.when, r.company, r.project, r.host, r.length, r.tokensLabel, r.outcome, r.costLabel]
      .map((cell) => `"${cell.replaceAll('"', '""')}"`)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

export const RANGE_DAYS: Record<TelemetryRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shiftDate(iso: string, days: number): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days));
}

function shortDate(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function dayTotal(day: DayStack): number {
  return day.opus + day.sonnet + day.haiku;
}

function scale(n: number, f: number): number {
  return Math.round(n * f);
}

/**
 * Recompute a snapshot for another range. The base totals describe
 * `base.range`; the per-day stacks cover as many days as were captured, so
 * totals for another range scale by that window's share of daily tokens.
 * Session rows are filtered by age. Without `endDate` the base is returned unchanged.
 */
export function snapshotForRange(base: TelemetrySnapshot, range: TelemetryRange): TelemetrySnapshot {
  if (!base.endDate) return base;
  const span = RANGE_DAYS[range];
  if (range === base.range) {
    return base.days.length > span ? { ...base, days: base.days.slice(-span) } : base;
  }
  const baseSpan = RANGE_DAYS[base.range];
  const days = base.days.slice(-span);
  const baseTokens = base.days.slice(-baseSpan).reduce((sum, d) => sum + dayTotal(d), 0);
  const windowTokens = days.reduce((sum, d) => sum + dayTotal(d), 0);
  const f = baseTokens > 0 ? windowTokens / baseTokens : 0;
  const end = base.endDate;
  const start = shiftDate(end, days.length - 1);
  const models = base.models.map((m) => ({
    ...m,
    input: scale(m.input, f),
    output: scale(m.output, f),
    cacheWrite: scale(m.cacheWrite, f),
    cacheRead: scale(m.cacheRead, f),
  }));
  const tokens = models.reduce((sum, m) => sum + m.input + m.output + m.cacheWrite + m.cacheRead, 0);
  const sessions = scale(base.sessions, f);
  const sessionsRows = base.sessionsRows.filter((row) => (row.daysAgo ?? 0) < span);
  const peak = days.reduce((best, d, i) => (dayTotal(d) > dayTotal(days[best]) ? i : best), 0);
  const labelStep = Math.max(1, Math.floor((days.length - 1) / 4));
  const dayLabels: string[] = [];
  for (let i = 0; i < days.length - 1; i += labelStep) {
    if (days.length - 1 - i >= labelStep / 2) dayLabels.push(shortDate(shiftDate(end, days.length - 1 - i)));
  }
  dayLabels.push("today");
  const io = models.reduce(
    (acc, m) => ({
      input: acc.input + m.input,
      cacheRead: acc.cacheRead + m.cacheRead,
      cacheWrite: acc.cacheWrite + m.cacheWrite,
      output: acc.output + m.output,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );
  const mega = (n: number) => `${(n / 1_000_000).toFixed(2)}M`;
  return {
    ...base,
    range,
    rangeLabel: `${shortDate(start)} – ${shortDate(shiftDate(end, 0))}`,
    sessions,
    sessionsDelta: "",
    tokensLabel: formatTokens(tokens),
    tokensDelta: "",
    storiesShipped: scale(base.storiesShipped, f),
    deploys: scale(base.deploys, f),
    perDay: formatTokens(Math.round(tokens / Math.max(1, days.length))),
    listCostUsd: models.reduce((sum, m) => sum + listRateUsd(m), 0),
    peakLabel: `peak ${formatTokens(Math.round((dayTotal(days[peak] ?? { label: "", opus: 0, sonnet: 0, haiku: 0 }) / Math.max(1, windowTokens)) * tokens))} · ${shortDate(shiftDate(end, days.length - 1 - peak))}`,
    days,
    dayLabels,
    sessionsRows,
    skills: base.skills
      .map((s) => ({ ...s, count: scale(s.count, f) }))
      .filter((s) => s.count > 0),
    models,
    byCompany: base.byCompany.map((r) => ({ ...r, tokens: scale(r.tokens, f), costUsd: r.costUsd * f })),
    byActor: base.byActor.map((r) => ({ ...r, tokens: scale(r.tokens, f), costUsd: r.costUsd * f })),
    io: { input: mega(io.input), cacheRead: mega(io.cacheRead), cacheWrite: mega(io.cacheWrite), output: mega(io.output) },
    outcomeCounts: {
      ...base.outcomeCounts,
      all: sessions,
      deployed: scale(base.outcomeCounts.deployed, f),
      shipped: scale(base.outcomeCounts.shipped, f),
      blocked: scale(base.outcomeCounts.blocked, f),
      none: scale(base.outcomeCounts.none, f),
    },
  };
}
