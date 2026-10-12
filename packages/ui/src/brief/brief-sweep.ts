/**
 * The morning sweep's output (`workspace/brief/<run_id>/brief-data.json`,
 * written by scripts/brief-sweep.py) mapped into brief input. Pure.
 *
 * What the sweep carries, and where it lands:
 * - prs ............................... merged and opened totals for the PR
 *                                       window (the one source for those
 *                                       counts), shipped rollups per repo for
 *                                       the day (with the product and median
 *                                       merge hours when the sweep has them),
 *                                       window totals by repo
 * - meeting_signals ................... yesterday's meetings with real counts
 * - main_health ....................... every repo's workflows and red rows
 *                                       (`mainHealth`); a red main also becomes
 *                                       a live incident risk with since, age
 *                                       and merges on top when the sweep
 *                                       writes them
 * - fleet ............................. the stuck list, the delta against the
 *                                       previous run and the per-run series
 *                                       become `fleetIncident` while an
 *                                       incident is open or ended within a day.
 *                                       A fleet count is never a card.
 * - releases .......................... the last release per product and what
 *                                       waits behind it
 * - window.today ...................... the brief's local date (weekday source)
 * - dms ............................... who you talked with (agents labeled)
 * - sessions .......................... your sessions with project, product,
 *                                       end and handoff; other companies
 *                                       counted only
 * It has no calendar, no decision text and no waits; those stay with the
 * adapter or come from brief.json.
 */

import { productName, repoShort } from "./brief-origin.js";
import type {
  BriefFleetIncident,
  BriefInput,
  BriefMainHealth,
  BriefMeeting,
  BriefOrigin,
  BriefRelease,
  BriefRisk,
  BriefSession,
  BriefShipped,
  BriefTeammate,
} from "./brief-types.js";

/** One fleet agent row, in `fleet.stuck` (newer sweeps) or `fleet.agents`. */
export interface SweepFleetAgent {
  name: string;
  status?: string | null;
  phase?: string | null;
  /** ISO time it got stuck, when the sweep knows. */
  since?: string | null;
  reason?: string | null;
}

/** A red workflow row: newer sweeps write objects, older ones the workflow name. */
export type SweepRed = string | { workflow: string; since?: string | null; merges_on_top?: number | null };

export interface BriefSweep {
  generated_at?: string;
  company?: string;
  window?: { from: string; to: string; today?: string; sessions_from?: string; sessions_to?: string };
  days?: Record<string, { merged?: number; opened?: number; sessions?: number; other_sessions?: number; meetings?: number }>;
  sessions?: {
    id?: string;
    date: string;
    time: string;
    company: string | null;
    title: string | null;
    /** ISO start, written by newer sweeps; older ones only have date + UTC time. */
    started_at?: string;
    /** you | agent | lane; absent in older sweeps (all treated as yours). */
    kind?: string;
    /** The HQ project (repo from cwd) and its product, newer sweeps. */
    project?: string | null;
    product?: string | null;
    /** ISO end, under one of these names depending on the sweep version. */
    end?: string | null;
    ended_at?: string | null;
    last_activity?: string | null;
    has_handoff?: boolean;
  }[];
  meeting_signals?: { meeting: string; start: string; counts: Record<string, number> }[];
  dms?: { from: string; from_uid?: string; is_agent?: boolean; at: string }[];
  fleet?: {
    total?: number;
    by_status?: Record<string, number>;
    agents?: SweepFleetAgent[];
    stuck?: SweepFleetAgent[];
    delta?: { newly_stuck?: string[]; still_stuck?: string[]; recovered?: string[] };
    /** One bucket per prior run. */
    series?: { generated_at: string; stuck: number }[];
  } | null;
  prs?: {
    repo: string;
    number: number;
    title: string;
    state: string;
    created: string;
    /** ISO close, null (newer) or 0001-01-01 (older) on open rows. */
    closed: string | null;
    product?: string | null;
    merge_hours?: number | null;
    is_release?: boolean;
    url?: string;
  }[];
  main_health?: Record<string, { workflows: number; red: SweepRed[]; delta?: { newly_red?: string[]; still_red?: string[]; recovered?: string[] } }>;
  releases?: {
    product?: string | null;
    repo?: string | null;
    version?: string | null;
    merged_at?: string | null;
    url?: string;
    pending_count?: number;
    pending_by_day?: { day: string; count: number; theme?: string }[];
  }[];
}

export interface SweepOptions {
  /** The day the brief looks back on, YYYY-MM-DD. */
  day: string;
  /** Company uid the sweep's work belongs to (for logos). */
  companyUid: string | null;
  /** GitHub org for repo chips. */
  org?: string;
  /** The brief owner's display name; their own DMs are not teammates. */
  selfName?: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const isDay = (iso: string | null | undefined, day: string) => (iso ?? "").slice(0, 10) === day;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Local calendar day of an ISO time, YYYY-MM-DD. */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** An ISO close time, or null for an open row (newer sweeps write null, older 0001-01-01). */
const closedAt = (iso: string | null | undefined): string | null => (iso && !iso.startsWith("0001") ? iso : null);

export function parseSweep(text: string): BriefSweep | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as BriefSweep) : null;
  } catch {
    return null;
  }
}

/** Red rows in one shape, whichever the sweep wrote. */
export function redRows(red: readonly SweepRed[] | null | undefined): BriefMainHealth["red"] {
  return (Array.isArray(red) ? red : [])
    .map((r) =>
      typeof r === "string"
        ? { workflow: r.trim(), since: null, mergesOnTop: null }
        : { workflow: (r?.workflow ?? "").trim(), since: r?.since || null, mergesOnTop: finite(r?.merges_on_top) },
    )
    .filter((r) => r.workflow);
}

/** The product a repo's rows name, when the sweep or the product table knows it; null otherwise. */
function productOf(repo: string, byRepo: ReadonlyMap<string, string>): string | null {
  const known = byRepo.get(repo);
  if (known) return known;
  const name = productName(repo);
  return name && name.toLowerCase() !== repoShort(repo).toLowerCase() ? name : null;
}

/** "waiting in setup", "setup failed", or the sweep's own reason. */
function stuckReason(a: SweepFleetAgent): string {
  if (a.reason?.trim()) return a.reason.trim();
  const phase = (a.phase ?? "").trim();
  if (phase === "failed") return "setup failed";
  if (phase === "waiting") return "waiting in setup";
  if (phase) return `in ${phase}`;
  return (a.status ?? "").trim() || "stuck";
}

/**
 * The fleet incident the sweep describes, or null when no agent is stuck now,
 * none recovered since the previous run, and the series shows nothing stuck
 * in the last day. Verdict: healed under 2% stuck (or none); relapsing when
 * agents got stuck again after the count had fallen; healing when the count
 * fell (or agents recovered and none got newly stuck); else plateaued. The
 * id is replaced by brief.json's fleet incident when it names one.
 */
export function fleetIncidentOf(fleet: BriefSweep["fleet"], nowIso: string | undefined, origin: BriefOrigin): BriefFleetIncident | null {
  if (!fleet) return null;
  const nowMs = Date.parse(nowIso ?? "");
  const rows = Array.isArray(fleet.stuck) ? fleet.stuck : (fleet.agents ?? []).filter((a) => a && (a.phase ?? "ready") !== "ready");
  const stillStuck = rows
    .filter((a) => a && typeof a.name === "string" && a.name.trim())
    .map((a) => ({ name: a.name.trim(), reason: stuckReason(a), since: a.since || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const recovered = strs(fleet.delta?.recovered);
  const newlyStuck = strs(fleet.delta?.newly_stuck);
  const series = (fleet.series ?? [])
    .filter((s) => s && Number.isFinite(Date.parse(s.generated_at)))
    .map((s) => ({ at: s.generated_at, stuck: Math.max(0, Math.round(finite(s.stuck) ?? 0)) }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const recent = Number.isFinite(nowMs) && series.some((s) => s.stuck > 0 && nowMs - Date.parse(s.at) <= DAY_MS);
  if (!stillStuck.length && !recovered.length && !recent) return null;

  const total = finite(fleet.total) ?? fleet.agents?.length ?? 0;
  const stuck = stillStuck.length;
  const ratio = total > 0 ? stuck / total : stuck ? 1 : 0;
  const prev = series.length ? series[series.length - 1]! : null;
  const peakBefore = series.slice(0, -1).reduce((m, s) => Math.max(m, s.stuck), 0);
  let verdict: BriefFleetIncident["verdict"];
  if (!stuck || ratio < 0.02) verdict = "healed";
  else if (prev && newlyStuck.length && prev.stuck < peakBefore) verdict = "relapsing";
  else if ((prev && stuck < prev.stuck) || (recovered.length && !newlyStuck.length)) verdict = "healing";
  else verdict = "plateaued";

  const sinces = stillStuck.map((a) => (a.since ? Date.parse(a.since) : NaN)).filter(Number.isFinite);
  const firstRed = series.find((s) => s.stuck > 0);
  const incidentStart = sinces.length ? new Date(Math.min(...sinces)).toISOString() : firstRed?.at ?? null;
  const now = Number.isFinite(nowMs) ? nowIso! : null;
  const points = now ? [...series, { at: now, stuck }] : series;
  return {
    id: `fleet:${origin.companyUid ?? "fleet"}`,
    series: points,
    incidentStart,
    incidentEnd: stuck ? null : now,
    verdict,
    stillStuck,
    fixes: [],
  };
}

/** The fields of BriefInput the sweep can fill. */
export type SweepInput = Pick<
  BriefInput,
  | "meetingsYesterday"
  | "risks"
  | "shipped"
  | "team"
  | "sessions"
  | "merged"
  | "opened"
  | "prWindow"
  | "dmCount"
  | "today"
  | "mainHealth"
  | "fleetIncident"
  | "releases"
>;

export function sweepToInput(sweep: BriefSweep, opts: SweepOptions): SweepInput {
  const org = opts.org ?? "indigoai-us";
  const prs = sweep.prs ?? [];
  const nowMs = Date.parse(sweep.generated_at ?? "");
  // The product each repo's rows name, from the sweep's PR rows (newer sweeps).
  const products = new Map<string, string>();
  for (const p of prs) if (p.product?.trim()) products.set(p.repo, p.product.trim());
  const origin = (repo: string): BriefOrigin => {
    const product = products.get(repo);
    return { companyUid: opts.companyUid, repo: `${org}/${repo}`, ...(product ? { product } : {}) };
  };
  // One source for merged and opened everywhere: the sweep's PR window
  // (window.from onward). The per-day rollup is not used for these counts.
  const from = sweep.window?.from ?? null;
  const inWindow = (iso: string | null | undefined) => !!iso && !iso.startsWith("0001") && (!from || iso.slice(0, 10) >= from);
  const windowMerged = prs.filter((p) => p.state === "merged" && inWindow(p.closed)).length;
  const windowOpened = prs.filter((p) => (p.state === "open" || p.state === "merged") && inWindow(p.created)).length;

  // Shipped: the day's merged PRs grouped by repo, biggest first.
  const mergedToday = prs.filter((p) => p.state === "merged" && isDay(closedAt(p.closed), opts.day));
  const byRepoToday = new Map<string, typeof prs>();
  for (const p of mergedToday) byRepoToday.set(p.repo, [...(byRepoToday.get(p.repo) ?? []), p]);
  const shipped: BriefShipped[] = [...byRepoToday.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([repo, rows]) => {
      const open = prs.filter((p) => p.repo === repo && p.state === "open").length;
      const hours = rows.map((p) => finite(p.merge_hours)).filter((h): h is number => h != null).sort((a, b) => a - b);
      const median = hours.length ? (hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2) : null;
      return {
        id: `ship:${repo}`,
        title: repo,
        status: `${rows.length} merged`,
        note: open ? `${open} open` : "nothing open",
        origin: origin(repo),
        lines: rows.map((p) => ({ label: `${p.number} ${p.title}`, state: "MERGED", tone: "ok" as const })),
        ...(median != null ? { mergeHoursMedian: median } : {}),
      };
    });

  const repoTotals = new Map<string, { repo: string; total: number; merged: number }>();
  for (const p of prs) {
    const row = repoTotals.get(p.repo) ?? { repo: p.repo, total: 0, merged: 0 };
    row.total += 1;
    if (p.state === "merged") row.merged += 1;
    repoTotals.set(p.repo, row);
  }
  const prWindow = sweep.window
    ? {
        from: sweep.window.from,
        to: sweep.window.to,
        total: prs.length,
        merged: prs.filter((p) => p.state === "merged").length,
        byRepo: [...repoTotals.values()].sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo)),
      }
    : null;

  const meetingsYesterday: BriefMeeting[] = (sweep.meeting_signals ?? [])
    .filter((m) => localDay(m.start) === opts.day || isDay(m.start, opts.day))
    .map((m, i) => ({
      id: `sweep-meeting-${i}`,
      title: m.meeting,
      startTime: m.start,
      companyUid: opts.companyUid,
      decisions: m.counts.decision ?? 0,
      actions: m.counts.action_item ?? 0,
      risks: m.counts.risk ?? 0,
      questions: m.counts.question ?? 0,
    }))
    .sort((a, b) => b.decisions + b.actions - (a.decisions + a.actions));

  // Main health: every repo for the release train; the red ones are incidents.
  const mainHealth: BriefMainHealth[] = Object.entries(sweep.main_health ?? {}).map(([repo, h]) => {
    const delta = h.delta;
    return {
      repo,
      product: productOf(repo, products),
      companyUid: opts.companyUid,
      workflows: finite(h.workflows) ?? 0,
      red: redRows(h.red),
      ...(delta ? { delta: { newlyRed: strs(delta.newly_red), stillRed: strs(delta.still_red), recovered: strs(delta.recovered) } } : {}),
    };
  });
  const risks: BriefRisk[] = mainHealth
    .filter((h) => h.red.length > 0)
    .map((h) => {
      const names = h.red.map((r) => r.workflow);
      const sinces = h.red.map((r) => (r.since ? Date.parse(r.since) : NaN)).filter(Number.isFinite);
      const since = sinces.length ? new Date(Math.min(...sinces)).toISOString() : null;
      const ageHours = since && Number.isFinite(nowMs) ? Math.max(0, Math.round((nowMs - Date.parse(since)) / HOUR_MS)) : null;
      const merges = h.red.map((r) => r.mergesOnTop).filter((m): m is number => m != null);
      return {
        id: `ci:${h.repo}`,
        title: `${h.repo} main CI red`,
        summary: `${names.join(", ")} failing on main (${names.length} of ${h.workflows} workflows).`,
        severity: "incident" as const,
        links: [],
        origin: origin(h.repo),
        ci: {
          repo: h.repo,
          workflow: names.length > 1 ? `${names[0]} +${names.length - 1} more` : (names[0] ?? null),
          job: null,
          since,
          ageHours,
          note: `${names.length} of ${h.workflows} workflows red on main.`,
          ...(merges.length ? { mergesOnTop: Math.max(...merges) } : {}),
        },
      };
    });

  // Team: who DM'd you that day, newest first; agt_ senders are agents.
  const seen = new Map<string, BriefTeammate>();
  const dmsToday = (sweep.dms ?? []).filter((m) => localDay(m.at) === opts.day || isDay(m.at, opts.day));
  for (const m of dmsToday) {
    const name = m.from.trim();
    if (!name || name === "assistant" || name === opts.selfName?.trim() || seen.has(name)) continue;
    const agent = m.is_agent === true || (m.from_uid ?? "").startsWith("agt_");
    const count = dmsToday.filter((x) => x.from === m.from).length;
    seen.set(name, {
      id: m.from_uid || name,
      name: name.split(/\s+/)[0]!,
      doing: agent ? "Agent" : "Messaged you",
      dmCount: count,
      tone: agent ? "neutral" : "ok",
      isAgent: agent,
    });
  }

  // Sessions: yours, on the day. Project and product stay inside the sweep's company.
  const sessions: BriefSession[] = (sweep.sessions ?? [])
    .filter((s) => s.date === opts.day && s.company !== "unknown" && (s.kind ?? "you") === "you")
    .map((s, i) => {
      const mine = s.company === sweep.company;
      const end = s.end ?? s.ended_at ?? s.last_activity ?? null;
      return {
        id: s.id?.trim() || `sweep-session-${i}`,
        title: s.title ?? "",
        // Newer sweeps carry an ISO start and a local time; older ones a UTC time.
        startedAt: s.started_at ?? `${s.date}T${s.time.replace(/Z$/, "")}:00Z`,
        workstream: mine ? "Work" : "Other",
        company: mine ? opts.companyUid : s.company,
        ...(mine && s.project?.trim() ? { project: s.project.trim() } : {}),
        ...(mine && s.product?.trim() ? { product: s.product.trim() } : {}),
        ...(end && Number.isFinite(Date.parse(end)) ? { endedAt: end } : {}),
        ...(typeof s.has_handoff === "boolean" ? { hasHandoff: s.has_handoff } : {}),
      };
    });

  const releases: BriefRelease[] = (sweep.releases ?? [])
    .filter((r) => r && (r.product?.trim() || r.repo?.trim()))
    .map((r) => {
      const repo = r.repo?.trim() || null;
      const product = r.product?.trim() || productName(repo);
      const pending = (r.pending_by_day ?? [])
        .filter((d) => d && typeof d.day === "string" && d.day.trim())
        .map((d) => ({ day: d.day.trim().slice(0, 10), count: Math.max(0, Math.round(finite(d.count) ?? 0)), theme: d.theme?.trim() ?? "" }))
        .sort((a, b) => a.day.localeCompare(b.day));
      return {
        product,
        version: r.version?.trim() || null,
        origin: { companyUid: opts.companyUid, repo: repo ? `${org}/${repo}` : null, product },
        releasedAt: r.merged_at?.trim() || null,
        pending,
        pendingCount: finite(r.pending_count) ?? pending.reduce((n, d) => n + d.count, 0),
        held: [],
        light: "ok" as const,
      };
    });

  const fleetIncident = fleetIncidentOf(sweep.fleet, sweep.generated_at, { companyUid: opts.companyUid, repo: null });

  const today = sweep.window?.today;
  return {
    meetingsYesterday,
    risks,
    shipped,
    team: [...seen.values()].slice(0, 6),
    sessions,
    merged: sweep.prs ? windowMerged : null,
    opened: sweep.prs ? windowOpened : null,
    prWindow,
    dmCount: dmsToday.length,
    ...(today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? { today } : {}),
    ...(mainHealth.length ? { mainHealth } : {}),
    ...(fleetIncident ? { fleetIncident } : {}),
    ...(releases.length ? { releases } : {}),
  };
}
