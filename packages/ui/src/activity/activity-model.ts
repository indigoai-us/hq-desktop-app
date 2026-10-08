/**
 * Activity page model (console-rail US-026).
 *
 * Pure data: ranges, the team list order, per-day activity bars, and CSV.
 * Nothing here runs at boot.
 */

export type ActivityRange = "7d" | "30d" | "90d";

export const ACTIVITY_RANGES: readonly ActivityRange[] = ["7d", "30d", "90d"];

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
  /** OWNER-R7: web parity fields; absent on snapshots cached before R7. */
  email?: string;
  prs?: number;
  outcomes?: number;
  /** Role or team label from the read, when it sends one ("Owner", "Fleet agent"). */
  role?: string;
  /** Per-day tokens, oldest first (hq-pro perMember.trend). */
  trend?: number[];
  tokensByModel?: { model: string; total: number }[];
  skills?: { skill: string; count: number }[];
  services?: { service: string; count: number }[];
}

export interface ActivitySnapshot {
  members: ActivityMember[];
  updatedLabel: string;
}

export const EMPTY_ACTIVITY: ActivitySnapshot = {
  members: [],
  updatedLabel: "",
};

/** Scroll budget for the team list. */
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

/** How the team list is ordered: most recently active first, or by name. */
export type ActivitySort = "recent" | "name";

/**
 * Days since the member's last active day in the range, from the per-day
 * trend (oldest first, the last entry is today). Null when the trend has no
 * active day, e.g. a snapshot cached before trends were read.
 */
export function lastActiveDaysAgo(trend: readonly number[] | undefined): number | null {
  if (!trend || trend.length === 0) return null;
  for (let i = trend.length - 1; i >= 0; i -= 1) {
    if (trend[i] > 0) return trend.length - 1 - i;
  }
  return null;
}

/** "Live now", "Today", "Yesterday", "3d ago"; null when unknown. */
export function lastActiveLabel(daysAgo: number | null, live = false): string | null {
  if (live) return "Live now";
  if (daysAgo === null) return null;
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  return `${daysAgo}d ago`;
}

/**
 * Team rows in display order. Recent: live people first, then the most
 * recently active day, then more sessions, then name. Name: A to Z.
 */
export function sortMembers(
  members: readonly ActivityMember[],
  sort: ActivitySort,
  liveIds: ReadonlySet<string> = new Set(),
): ActivityMember[] {
  const byName = (a: ActivityMember, b: ActivityMember) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (sort === "name") return [...members].sort(byName);
  const rank = (m: ActivityMember) => lastActiveDaysAgo(m.trend) ?? Number.POSITIVE_INFINITY;
  return [...members].sort((a, b) => {
    const live = Number(liveIds.has(b.id)) - Number(liveIds.has(a.id));
    if (live !== 0) return live;
    const recent = rank(a) - rank(b);
    if (recent !== 0 && Number.isFinite(recent)) return recent;
    if (rank(a) !== rank(b)) return Number.isFinite(rank(a)) ? -1 : 1;
    return b.sessions - a.sessions || byName(a, b);
  });
}

/**
 * Bar heights (0–100) for the member's activity over the range, one per day,
 * oldest first. An idle day is 0; any active day is at least 12 so a light
 * day still shows.
 */
export function activityBars(trend: readonly number[] | undefined, days: number): number[] {
  const slice = (trend ?? []).slice(-days);
  const padded = [...Array(Math.max(0, days - slice.length)).fill(0), ...slice];
  const peak = padded.reduce((max, v) => Math.max(max, v), 0);
  return padded.map((v) => (v > 0 && peak > 0 ? Math.max(12, Math.round((v / peak) * 100)) : 0));
}

/** Outcomes per 1M tokens, as the web formats it; a dash when unranked. */
export function formatEfficiency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2).replace(/0$/, "");
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
    "prs",
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
      member.prs ?? "",
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

/** One model's token count; reads `input` and `inputTokens` style keys. */
function modelTokens(m: unknown): number {
  const r = rec(m);
  return (
    num(r.input ?? r.inputTokens) +
    num(r.output ?? r.outputTokens) +
    num(r.cacheCreation ?? r.cacheCreationTokens) +
    num(r.cacheRead ?? r.cacheReadTokens)
  );
}

/**
 * Per-model token rows. Production sends a `{ [model]: counts }` map; the
 * legacy shape was `[{ model, ...counts }]`.
 */
function modelRows(tokensByModel: unknown): { model: string; total: number }[] {
  if (Array.isArray(tokensByModel)) {
    return tokensByModel.map((t) => ({ model: String(rec(t).model ?? ""), total: modelTokens(t) }));
  }
  return Object.entries(rec(tokensByModel)).map(([model, t]) => ({ model, total: modelTokens(t) }));
}

function tokenTotal(tokensByModel: unknown): number {
  return modelRows(tokensByModel).reduce((sum, row) => sum + row.total, 0);
}

/** Skill or service counts: `[{ skill, count }]` lists or a `{ [name]: count }` map. */
function countRows(value: unknown, key: "skill" | "service"): { name: string; count: number }[] {
  const list = Array.isArray(value)
    ? value.map((k) => ({ name: String(rec(k)[key] ?? ""), count: num(rec(k).count) }))
    : Object.entries(rec(value)).map(([name, count]) => ({ name, count: num(count) }));
  return list.filter((k) => k.name).sort((a, b) => b.count - a.count);
}

function identityLabel(identities: unknown, id: string): { name: string; email: string } {
  for (const group of ["persons", "agents"]) {
    const row = rec(rec(rec(identities)[group])[id]);
    const name = [row.displayName, row.name].find((v): v is string => typeof v === "string" && !!v.trim())?.trim() ?? "";
    const email = typeof row.email === "string" ? row.email.trim() : "";
    if (name || email) return { name, email };
  }
  return { name: "", email: "" };
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
 * range are left out. Production sends the flat shape instead: `members` with
 * top-level `tokensByModel` / `skills` / `services` maps, `events`, and
 * `distinctSessions`, and names in `identities`. Both shapes are read. A body
 * with neither list is a failed read.
 */
export function activityFromCompanyTelemetry(body: unknown): ActivitySnapshot {
  const root = rec(body);
  const rows = Array.isArray(root.perMember) ? root.perMember : root.members;
  if (!Array.isArray(rows)) throw new Error("company telemetry has no members list");
  const members: ActivityMember[] = [];
  for (const item of rows) {
    const m = rec(item);
    const id = typeof m.personUid === "string" ? m.personUid : "";
    if (!id) continue;
    // Legacy rows nest counts under `totals`; production rows carry them flat.
    const totals = m.totals && typeof m.totals === "object" ? rec(m.totals) : m;
    const tokens = tokenTotal(totals.tokensByModel);
    const sessions = num(totals.distinctSessions);
    if (tokens === 0 && sessions === 0 && num(totals.events) === 0) continue;
    const known = identityLabel(root.identities, id);
    const label = [m.label, m.displayName].find((v): v is string => typeof v === "string" && !!v.trim())?.trim() || known.name;
    const email = (typeof m.email === "string" ? m.email.trim() : "") || known.email;
    const bot = id.startsWith("agt_") || m.kind === "agent";
    // Never an id: a label, else the email, else a plain stand-in.
    const name = label && !/^(prs|agt)_/.test(label) ? label : email || (bot ? "Unknown bot" : "Unnamed member");
    const byType = rec(rec(m.outcomes).byType);
    const skillsRaw = rec(totals.skills);
    const skills = countRows(Array.isArray(skillsRaw.bySkill) ? skillsRaw.bySkill : skillsRaw, "skill");
    const servicesRaw = rec(totals.services);
    const services = countRows(Array.isArray(servicesRaw.byService) ? servicesRaw.byService : servicesRaw, "service");
    const efficiency = typeof m.efficiency === "number" && Number.isFinite(m.efficiency) ? m.efficiency : null;
    members.push({
      id,
      name,
      mark: initials(name),
      bot,
      live: false,
      tokens,
      sessions,
      stories: num(byType.storyCompleted),
      deploys: num(byType.deploySucceeded),
      topSkill: skills[0]?.name ?? "",
      outcomesPerMillion: efficiency,
      spendUsd: null,
      email: email && email !== name ? email : "",
      role: typeof m.role === "string" && m.role.trim() ? m.role.trim() : "",
      prs: num(byType.prMerged),
      outcomes: num(rec(m.outcomes).total),
      trend: Array.isArray(m.trend) ? m.trend.map(num) : [],
      tokensByModel: modelRows(totals.tokensByModel)
        .filter((t) => t.model && t.total > 0)
        .sort((a, b) => b.total - a.total),
      skills: skills.map((k) => ({ skill: k.name, count: k.count })),
      services: services.map((k) => ({ service: k.name, count: k.count })),
    });
  }
  // Web order: Outcomes/1M descending, unranked members after every ranked one.
  members.sort((a, b) => {
    const ar = a.outcomesPerMillion != null;
    const br = b.outcomesPerMillion != null;
    if (ar !== br) return ar ? -1 : 1;
    if (ar && br && a.outcomesPerMillion !== b.outcomesPerMillion) return (b.outcomesPerMillion as number) - (a.outcomesPerMillion as number);
    return b.tokens - a.tokens || a.name.localeCompare(b.name);
  });
  return {
    members,
    updatedLabel: "Company telemetry",
  };
}

export type ActivityFailureKind = "offline" | "signed-out" | "server";

export interface ActivityFailure {
  kind: ActivityFailureKind;
  /** Plain reason and next step. Never the server's own text. */
  message: string;
}

const FAILURE_COPY: Record<ActivityFailureKind, string> = {
  offline: "You're offline, so activity can't load. Check your connection, then try again.",
  "signed-out": "Your sign-in has expired. Sign in again to load activity.",
  server: "HQ couldn't load activity right now. Try again in a moment.",
};

/**
 * Sort a failed Activity read into a reason the page can explain. The raw
 * error goes to the log only; this picks the copy and the next step.
 */
export function activityReadFailure(err: unknown, online = true): ActivityFailure {
  const e = err as { code?: unknown; message?: unknown } | null;
  const text = `${typeof e?.code === "string" ? e.code : ""} ${typeof e?.message === "string" ? e.message : String(err)}`;
  let kind: ActivityFailureKind = "server";
  if (!online || /offline|network|fetch failed|failed to fetch|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|\bdns\b/i.test(text)) kind = "offline";
  else if (/\b401\b|unauthori[sz]ed|unauthenticated|not signed in|signed out|sign in|expired|invalid.?token|not.?authori[sz]ed/i.test(text)) kind = "signed-out";
  return { kind, message: FAILURE_COPY[kind] };
}
