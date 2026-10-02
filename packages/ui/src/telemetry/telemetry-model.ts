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
