/**
 * Activity page model (console-rail US-026).
 *
 * Pure data: ranges, the token day strip, and CSV. The day strip is the
 * only chart and lives in a lazy chunk. Nothing here runs at boot.
 */

export type ActivityTab = "team" | "tokens" | "live";
export type ActivityRange = "7d" | "30d" | "90d";

export const ACTIVITY_RANGES: readonly ActivityRange[] = ["7d", "30d", "90d"];

export interface DayBar {
  iso: string;
  label: string;
  heightPct: number;
  weekend: boolean;
  today: boolean;
}

export interface ActivityMember {
  id: string;
  name: string;
  mark: string;
  bot: boolean;
  live: boolean;
  tokens: number;
  sessions: number;
  stories: number;
  deploys: number;
  topSkill: string;
  outcomesPerMillion: number | null;
  spendUsd: number | null;
}

export interface LiveSession {
  id: string;
  name: string;
  mark: string;
  bot: boolean;
  live: boolean;
  what: string;
  project: string;
  elapsed: string;
  signal: string;
}

export interface ActivitySnapshot {
  members: ActivityMember[];
  live: LiveSession[];
  pulse: { at: string; name: string; text: string; project: string }[];
  /** Optional per-day token weights, oldest first, any length. */
  dayWeights: number[];
  attributedPct: number | null;
  updatedLabel: string;
}

export const EMPTY_ACTIVITY: ActivitySnapshot = {
  members: [],
  live: [],
  pulse: [],
  dayWeights: [],
  attributedPct: null,
  updatedLabel: "",
};

/** Scroll budget for the team table, token lists, and live table. */
export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export function rangeDays(range: ActivityRange): number {
  if (range === "7d") return 7;
  if (range === "90d") return 90;
  return 30;
}

function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * One bar per day in the range, ending today. Weekends are flagged so the
 * strip can dim them. Heights come from `weights` when present (oldest
 * first, aligned to the window) and otherwise stay a flat placeholder.
 */
export function dayBars(
  range: ActivityRange,
  weights: readonly number[] = [],
  now: Date = new Date(),
): DayBar[] {
  const count = rangeDays(range);
  const slice = weights.slice(-count);
  const peak = slice.reduce((max, n) => Math.max(max, n), 0);
  const bars: DayBar[] = [];
  for (let ago = count - 1; ago >= 0; ago -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    date.setDate(date.getDate() - ago);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const weightIndex = slice.length - (ago + 1);
    const weight = weightIndex >= 0 ? slice[weightIndex] : 0;
    const heightPct =
      peak > 0 ? Math.max(4, Math.round((weight / peak) * 100)) : weekend ? 8 : 18;
    bars.push({
      iso: isoDay(date),
      label: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      heightPct,
      weekend,
      today: ago === 0,
    });
  }
  return bars;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function csvCell(value: string | number | null): string {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function activityToCsv(snapshot: ActivitySnapshot, range: ActivityRange): string {
  const header = [
    "member",
    "kind",
    "tokens",
    "sessions",
    "stories",
    "deploys",
    "top_skill",
    "outcomes_per_1m",
    "spend_usd",
    "range",
  ];
  const rows = snapshot.members.map((member) =>
    [
      member.name,
      member.bot ? "bot" : "human",
      member.tokens,
      member.sessions,
      member.stories,
      member.deploys,
      member.topSkill,
      member.outcomesPerMillion ?? "",
      member.spendUsd ?? "",
      range,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export interface FileWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface SavePickerHandle {
  createWritable(): Promise<FileWritable>;
}

/**
 * Save CSV through the OS save dialog (`showSaveFilePicker`).
 * Cancel returns "cancelled". When the dialog API is missing, falls back
 * to a named download so the file still leaves the app.
 */
export async function saveCsvViaDialog(
  filename: string,
  csv: string,
  picker: typeof globalThis & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<SavePickerHandle>;
  } = globalThis,
): Promise<"saved" | "cancelled"> {
  if (typeof picker.showSaveFilePicker === "function") {
    try {
      const handle = await picker.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(csv);
      await writable.close();
      return "saved";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
      throw err;
    }
  }
  if (typeof document === "undefined") return "cancelled";
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return "saved";
}

const CACHE_PREFIX = "hq-activity-cache:";

export function readActivityCache(storage: Storage | null, slug: string): ActivitySnapshot | null {
  if (!storage || !slug) return null;
  try {
    const raw = storage.getItem(CACHE_PREFIX + slug);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActivitySnapshot;
    if (!parsed || !Array.isArray(parsed.members)) return null;
    return {
      members: parsed.members,
      live: Array.isArray(parsed.live) ? parsed.live : [],
      pulse: Array.isArray(parsed.pulse) ? parsed.pulse : [],
      dayWeights: Array.isArray(parsed.dayWeights) ? parsed.dayWeights : [],
      attributedPct: typeof parsed.attributedPct === "number" ? parsed.attributedPct : null,
      updatedLabel: typeof parsed.updatedLabel === "string" ? parsed.updatedLabel : "",
    };
  } catch {
    return null;
  }
}

export function writeActivityCache(
  storage: Storage | null,
  slug: string,
  snapshot: ActivitySnapshot,
): void {
  if (!storage || !slug) return;
  try {
    storage.setItem(CACHE_PREFIX + slug, JSON.stringify(snapshot));
  } catch {
    /* cache is best-effort */
  }
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function tokenTotal(tokensByModel: unknown): number {
  if (!Array.isArray(tokensByModel)) return 0;
  return tokensByModel.reduce((sum: number, m) => {
    const r = rec(m);
    return sum + num(r.input) + num(r.output) + num(r.cacheCreation) + num(r.cacheRead);
  }, 0);
}

function initials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/**
 * BLANK-1-31: company Activity from hq-pro `GET /v1/telemetry/company`, the
 * read the web console's Activity and Team activity pages use
 * (`{ range, daily: [{ date, tokensByModel }], perMember: [{ personUid, label,
 * email, totals: { tokensByModel, skills: { bySkill }, distinctSessions,
 * events }, outcomes?: { byType: { storyCompleted, deploySucceeded } } }],
 * coverage: { attributed, unattributed } }`). Tokens add input, output and
 * cache reads and writes, as the web does. Members with no activity in the
 * range are left out. The response has no live-session or pulse feed, so
 * those stay empty. A body without a `perMember` list is a failed read.
 */
export function activityFromCompanyTelemetry(body: unknown): ActivitySnapshot {
  const root = rec(body);
  if (!Array.isArray(root.perMember)) throw new Error("company telemetry has no perMember list");
  const members: ActivityMember[] = [];
  for (const item of root.perMember) {
    const m = rec(item);
    const id = typeof m.personUid === "string" ? m.personUid : "";
    if (!id) continue;
    const totals = rec(m.totals);
    const tokens = tokenTotal(totals.tokensByModel);
    const sessions = num(totals.distinctSessions);
    if (tokens === 0 && sessions === 0 && num(totals.events) === 0) continue;
    const label = [m.label, m.displayName].find((v): v is string => typeof v === "string" && !!v.trim())?.trim() ?? "";
    const email = typeof m.email === "string" ? m.email.trim() : "";
    const name = label || email || "Unnamed member";
    const byType = rec(rec(m.outcomes).byType);
    const bySkill = Array.isArray(rec(totals.skills).bySkill) ? (rec(totals.skills).bySkill as unknown[]) : [];
    const top = rec(bySkill[0]).skill;
    members.push({
      id,
      name,
      mark: initials(name),
      bot: id.startsWith("agt_"),
      live: false,
      tokens,
      sessions,
      stories: num(byType.storyCompleted),
      deploys: num(byType.deploySucceeded),
      topSkill: typeof top === "string" ? top : "",
      outcomesPerMillion: null,
      spendUsd: null,
    });
  }
  members.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  const daily = Array.isArray(root.daily) ? root.daily.map(rec) : [];
  const dayWeights = daily
    .filter((d) => typeof d.date === "string")
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((d) => tokenTotal(d.tokensByModel));
  const coverage = rec(root.coverage);
  const covered = num(coverage.attributed) + num(coverage.unattributed);
  return {
    members,
    live: [],
    pulse: [],
    dayWeights: dayWeights.some((w) => w > 0) ? dayWeights : [],
    attributedPct: covered > 0 ? Math.round((num(coverage.attributed) / covered) * 100) : null,
    updatedLabel: "Company telemetry",
  };
}
