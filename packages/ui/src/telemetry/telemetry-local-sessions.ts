/**
 * OWNER-R27: My Telemetry session history from the HQ workspace folder on
 * this Mac, through the native `list_local_sessions` command (it reads
 * workspace/sessions and workspace/threads, never transcript text).
 *
 * These records carry no per-session token count, so the Tokens cell is
 * empty. Outcome comes only from a thread record (handed off, checkpointed);
 * a session with none has no outcome.
 */
import type { AdapterPromise, Json } from "@hq/platform";
import type { TelemetryRange } from "./telemetry-model.js";

export interface LocalSessionsApi {
  listLocalSessions?(
    range: { from: string; to: string },
    page?: { offset?: number; limit?: number },
  ): AdapterPromise<Json>;
}

export interface LocalSessionRow {
  id: string;
  startedAt: string;
  /** "Oct 3, 10:42" in local time. */
  when: string;
  company: string;
  project: string;
  title: string;
  /** "1h 20m" from start to the last thread record; "" when unknown. */
  length: string;
  outcome: string;
  /** HQ-relative path of the handoff or checkpoint record, or "". */
  threadPath: string;
}

export interface LocalSessionsPage {
  total: number;
  rows: LocalSessionRow[];
  /** Median minutes between session starts on this Mac, or null. */
  medianGapMinutes: number | null;
}

export const LOCAL_SESSIONS_NOTE =
  "Sessions recorded on this Mac. Totals above include your other machines and bots.";
export const LOCAL_SESSIONS_PRIVACY = "Only you can see this. Nothing here is sent anywhere.";

const RANGE_DAYS: Record<TelemetryRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

function isoDay(ms: number): string {
  return new Date(ms).toISOString().split("T")[0]!;
}

export function localSessionsWindow(range: TelemetryRange, nowMs: number): { from: string; to: string } {
  return { from: isoDay(nowMs - (RANGE_DAYS[range] - 1) * 86_400_000), to: isoDay(nowMs) };
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function formatLength(startIso: string, endIso: string): string {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";
  if (end - start < 60_000) return "<1m";
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Parse the native page. Throws on a foreign shape. */
export function localSessionsFromNative(body: unknown): LocalSessionsPage {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!Array.isArray(root.rows) || typeof root.total !== "number") throw new Error("local sessions: unexpected shape");
  const rows: LocalSessionRow[] = root.rows.map((raw) => {
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const startedAt = str(r.startedAt);
    const company = str(r.company);
    const project = str(r.project);
    return {
      id: str(r.sessionId),
      startedAt,
      when: formatWhen(startedAt),
      company,
      project,
      title: str(r.title) || project || "",
      length: r.lastAt ? formatLength(startedAt, str(r.lastAt)) : "",
      outcome: str(r.outcome),
      threadPath: str(r.threadPath),
    };
  });
  const gap = root.medianGapMinutes;
  return { total: root.total, rows, medianGapMinutes: typeof gap === "number" && Number.isFinite(gap) ? gap : null };
}

/** "3m" / "1h 5m" for the median gap between session starts. */
export function formatGap(minutes: number | null): string {
  if (minutes == null) return "";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Reader bound to the platform; null when this host has no local sessions. */
export function createLocalSessionsReader(api: LocalSessionsApi | null | undefined, now: () => number = Date.now) {
  if (!api?.listLocalSessions) return null;
  const list = api.listLocalSessions.bind(api);
  return async (range: TelemetryRange, page: { offset: number; limit: number }): Promise<LocalSessionsPage> => {
    const res = await list(localSessionsWindow(range, now()), page);
    if (!res.ok) throw new Error(res.message ?? res.reason);
    return localSessionsFromNative(res.value);
  };
}

export type LocalSessionsReader = NonNullable<ReturnType<typeof createLocalSessionsReader>>;
