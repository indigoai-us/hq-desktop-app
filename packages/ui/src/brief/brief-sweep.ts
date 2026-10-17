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
import { briefCompanyUid, type BriefCompanyIdentity } from "./brief-company.js";
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

/** One repo's main-branch health as the sweep writes it. */
export interface SweepMainHealthRow {
  company?: string | null;
  repo?: string;
  workflows: number;
  red: SweepRed[];
  product?: string | null;
  delta?: { newly_red?: string[]; still_red?: string[]; recovered?: string[] };
}

/** A repo whose health check failed: the sweep writes `{ error }` with no workflows and no red rows. */
export interface SweepMainHealthError {
  error: string;
}

/**
 * True when a main_health entry carries health (a workflows count or a red
 * array). An error object, null, or an empty object says nothing about the
 * repo: its health is unknown, not green, so the caller leaves it out.
 */
export function isMainHealthRow(h: unknown): h is SweepMainHealthRow {
  if (!h || typeof h !== "object" || Array.isArray(h)) return false;
  const row = h as Partial<SweepMainHealthRow> & Partial<SweepMainHealthError>;
  if (typeof row.error === "string" && row.error.trim()) return false;
  return Array.isArray(row.red) || (typeof row.workflows === "number" && Number.isFinite(row.workflows));
}

export interface BriefSweep {
  mode?: "person" | "company" | "personal";
  personal?: BriefSweep;
  companies?: Record<string, BriefSweep>;
  generated_at?: string;
  company?: string | null;
  /**
   * `from`/`to` are the gh search reach (dates); the brief's own 24h PR window
   * is `prs_from`..`prs_to` (ISO), written by newer sweeps.
   */
  window?: { from: string; to: string; today?: string; sessions_from?: string; sessions_to?: string; prs_from?: string; prs_to?: string; hours?: number };
  days?: Record<string, { merged?: number; opened?: number; sessions?: number; other_sessions?: number; meetings?: number }>;
  /** The writer's numbers: the 24h window, the owner's own PRs. The app shows the same ones. */
  prs_summary?: { merged?: number; opened?: number; open?: number; review_requested?: number; median_merge_hours?: number | null } | null;
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
  /** A meeting whose `hq meetings get` failed is written as `{ meeting, error }` with no start or counts. */
  meeting_signals?: { company?: string | null; meeting: string; start?: string | null; counts?: Record<string, number> | null; error?: string }[];
  dms?: { from: string | null; from_uid?: string; is_agent?: boolean; at: string }[];
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
    company?: string | null;
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
    /** False on rows the owner did not author (reviews asked of them); absent in older sweeps (all theirs). */
    authored_by_me?: boolean;
    url?: string;
  }[];
  main_health?: Record<string, SweepMainHealthRow | SweepMainHealthError | null>;
  releases?: {
    company?: string | null;
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
  companies?: readonly BriefCompanyIdentity[];
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

/** Local calendar day of an ISO time, YYYY-MM-DD; "" when the value is not a time (a missing field never throws). */
function localDay(iso: string | null | undefined): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Epoch ms of an ISO time, NaN when absent or unparseable. */
const ms = (iso: string | null | undefined): number => (typeof iso === "string" && iso ? Date.parse(iso) : NaN);

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
  | "fleetIncidents"
  | "releases"
>;

export function sweepToInput(sweep: BriefSweep, opts: SweepOptions): SweepInput {
  if (sweep.mode === "person") {
    const sections: [string | null, BriefSweep][] = [
      ...(sweep.personal ? [[null, sweep.personal] as [null, BriefSweep]] : []),
      ...Object.entries(sweep.companies ?? {}),
    ];
    const parts = sections.filter(([company, section]) => section && typeof section === "object" && section.mode !== "person" && (company === null || !opts.companies || briefCompanyUid(company, opts.companies) !== null)).map(([company, section]) => {
      const uid = briefCompanyUid(company, opts.companies ?? opts.companyUid);
      const scoped = <T extends { company?: string | null }>(rows: T[] | undefined) => rows?.map(row => ({ ...row, company }));
      const part = sweepToInput({
        ...section,
        generated_at: section.generated_at ?? sweep.generated_at,
        prs: scoped(section.prs),
        meeting_signals: scoped(section.meeting_signals),
        releases: scoped(section.releases),
        sessions: scoped(section.sessions),
        main_health: Object.fromEntries(Object.entries(section.main_health ?? {}).map(([repo, h]) => [repo, isMainHealthRow(h) ? { ...h, company } : h])),
      }, { ...opts, companyUid: uid });
      const prefix = company ?? "personal";
      part.meetingsYesterday = part.meetingsYesterday.map(row => ({ ...row, id: `${prefix}:${row.id}` }));
      part.sessions = part.sessions.map(row => ({ ...row, id: `${prefix}:${row.id}` }));
      part.team = part.team.map(row => ({ ...row, companyUid: uid }));
      return part;
    });
    const sum = (field: "merged" | "opened") => parts.some(part => part[field] != null) ? parts.reduce((n, part) => n + (part[field] ?? 0), 0) : null;
    const windows = parts.flatMap(part => part.prWindow ? [part.prWindow] : []);
    const team = new Map<string, BriefTeammate>();
    for (const part of parts) for (const member of part.team) {
      const memberKey = JSON.stringify([member.companyUid, member.id]);
      const previous = team.get(memberKey);
      team.set(memberKey, previous ? { ...previous, dmCount: (previous.dmCount ?? 0) + (member.dmCount ?? 0) } : member);
    }
    return {
      meetingsYesterday: parts.flatMap(part => part.meetingsYesterday),
      risks: parts.flatMap(part => part.risks),
      shipped: parts.flatMap(part => part.shipped),
      sessions: parts.flatMap(part => part.sessions),
      team: [...team.values()],
      merged: sum("merged"), opened: sum("opened"),
      dmCount: parts.reduce((n, part) => n + (part.dmCount ?? 0), 0),
      today: sweep.window?.today ?? parts.find(part => part.today)?.today,
      mainHealth: parts.flatMap(part => part.mainHealth ?? []),
      releases: parts.flatMap(part => part.releases ?? []),
      fleetIncidents: parts.flatMap(part => part.fleetIncidents ?? []),
      fleetIncident: null,
      prWindow: windows.length ? {
        from: windows.map(w => w.from).sort()[0]!,
        to: windows.map(w => w.to).sort().at(-1)!,
        total: windows.reduce((n, w) => n + w.total, 0),
        merged: windows.reduce((n, w) => n + w.merged, 0),
        byRepo: windows.flatMap(w => w.byRepo),
      } : null,
    };
  }
  const org = opts.org ?? "indigoai-us";
  const prs = sweep.prs ?? [];
  const companyUid = (company: unknown) => briefCompanyUid(company, opts.companies ?? opts.companyUid);
  const key = (repo: string, company: unknown) => JSON.stringify([companyUid(company), repo]);
  const repoPath = (repo: string) => repo.includes("/") ? repo : `${org}/${repo}`;
  const nowMs = Date.parse(sweep.generated_at ?? "");
  // The product each repo's rows name, from the sweep's PR rows (newer sweeps).
  const products = new Map<string, string>();
  for (const p of prs) if (p.product?.trim()) products.set(key(p.repo, p.company), p.product.trim());
  const origin = (repo: string, company: unknown): BriefOrigin => {
    const product = products.get(key(repo, company));
    return { companyUid: companyUid(company), repo: repoPath(repo), ...(product ? { product } : {}) };
  };
  // One source for merged and opened everywhere, the same one the writer reads:
  // the brief's 24h PR window (window.prs_from..prs_to) over the owner's own
  // PRs, summarised by the sweep in prs_summary. Older sweeps have neither, so
  // they fall back to window.from (the gh search reach, dates only). The
  // per-day rollup is never used for these counts.
  const own = prs.filter((p) => p.authored_by_me !== false);
  const prsFrom = ms(sweep.window?.prs_from);
  const prsTo = ms(sweep.window?.prs_to);
  const hasPrWindow = Number.isFinite(prsFrom) && Number.isFinite(prsTo);
  const from = sweep.window?.from ?? null;
  const inWindow = (iso: string | null | undefined): boolean => {
    if (!iso || iso.startsWith("0001")) return false;
    if (hasPrWindow) {
      const t = Date.parse(iso);
      return t >= prsFrom && t <= prsTo;
    }
    return !from || iso.slice(0, 10) >= from;
  };
  const summary = sweep.prs_summary ?? null;
  const windowMerged = finite(summary?.merged) ?? own.filter((p) => p.state === "merged" && inWindow(p.closed)).length;
  const windowOpened = finite(summary?.opened) ?? own.filter((p) => (p.state === "open" || p.state === "merged") && inWindow(p.created)).length;

  // Shipped: the owner's PRs merged inside the same window, grouped by repo, biggest
  // first. Without a PR window: the ones closed on the brief's day, by local date.
  const mergedToday = own.filter((p) => p.state === "merged" && (hasPrWindow ? inWindow(closedAt(p.closed)) : localDay(closedAt(p.closed)) === opts.day));
  const byRepoToday = new Map<string, typeof prs>();
  for (const p of mergedToday) byRepoToday.set(key(p.repo, p.company), [...(byRepoToday.get(key(p.repo, p.company)) ?? []), p]);
  const shipped: BriefShipped[] = [...byRepoToday.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([group, rows]) => {
      const repo = rows[0]!.repo;
      const company = rows[0]!.company;
      const open = prs.filter((p) => key(p.repo, p.company) === group && p.state === "open").length;
      const hours = rows.map((p) => finite(p.merge_hours)).filter((h): h is number => h != null).sort((a, b) => a - b);
      const median = hours.length ? (hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2) : null;
      return {
        id: opts.companies ? `ship:${group}` : `ship:${repo}`,
        title: repo,
        status: `${rows.length} merged`,
        note: open ? `${open} open` : "nothing open",
        origin: origin(repo, company),
        lines: rows.map((p) => ({ label: `${p.number} ${p.title}`, state: "MERGED", tone: "ok" as const })),
        ...(median != null ? { mergeHoursMedian: median } : {}),
      };
    });

  // The window line on the shipped card: with a PR window, the rows opened or closed inside it
  // (its local days label the line); older sweeps describe the whole search reach.
  const windowRows = hasPrWindow ? prs.filter((p) => inWindow(p.created) || inWindow(closedAt(p.closed))) : prs;
  const repoTotals = new Map<string, { repo: string; total: number; merged: number }>();
  for (const p of windowRows) {
    const row = repoTotals.get(key(p.repo, p.company)) ?? { repo: p.repo, total: 0, merged: 0 };
    row.total += 1;
    if (p.state === "merged" && (!hasPrWindow || inWindow(closedAt(p.closed)))) row.merged += 1;
    repoTotals.set(key(p.repo, p.company), row);
  }
  const prWindow = sweep.window
    ? {
        from: hasPrWindow ? localDay(sweep.window.prs_from) : sweep.window.from,
        to: hasPrWindow ? localDay(sweep.window.prs_to) : sweep.window.to,
        total: windowRows.length,
        merged: [...repoTotals.values()].reduce((n, r) => n + r.merged, 0),
        byRepo: [...repoTotals.values()].sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo)),
      }
    : null;

  // A meeting whose read failed has no start and no counts; it is not a meeting on the day.
  const meetingsYesterday: BriefMeeting[] = (sweep.meeting_signals ?? [])
    .filter((m): m is typeof m & { start: string } => typeof m.start === "string" && !!m.start && (localDay(m.start) === opts.day || isDay(m.start, opts.day)))
    .map((m, i) => {
      const counts = m.counts ?? {};
      return {
        id: `sweep-meeting-${i}`,
        title: m.meeting,
        startTime: m.start,
        companyUid: companyUid(m.company),
        decisions: finite(counts.decision) ?? 0,
        actions: finite(counts.action_item) ?? 0,
        risks: finite(counts.risk) ?? 0,
        questions: finite(counts.question) ?? 0,
      };
    })
    .sort((a, b) => b.decisions + b.actions - (a.decisions + a.actions));

  // Main health: every repo for the release train; the red ones are incidents. A repo
  // whose check failed (an `{ error }` entry) is unknown, not green: it gets no row, so
  // "N of M products green" never counts it.
  const mainHealth: BriefMainHealth[] = Object.entries(sweep.main_health ?? {})
    .filter((entry): entry is [string, SweepMainHealthRow] => isMainHealthRow(entry[1]))
    .map(([entryKey, h]) => {
      const repo = h.repo ?? entryKey;
      const delta = h.delta;
      return {
        repo,
        product: h.product?.trim() || products.get(key(repo, h.company)) || productOf(repo, new Map()),
        companyUid: companyUid(h.company),
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
        id: opts.companies ? `ci:${h.companyUid ?? "personal"}:${h.repo}` : `ci:${h.repo}`,
        title: `${h.repo} main CI red`,
        summary: `${names.join(", ")} failing on main (${names.length} of ${h.workflows} workflows).`,
        severity: "incident" as const,
        links: [],
        origin: { companyUid: h.companyUid, repo: repoPath(h.repo), ...(h.product ? { product: h.product } : {}) },
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
    const name = (typeof m.from === "string" ? m.from : "").trim();
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
      const mine = opts.companies != null || s.company === sweep.company;
      const end = s.end ?? s.ended_at ?? s.last_activity ?? null;
      return {
        id: s.id?.trim() || `sweep-session-${i}`,
        title: s.title ?? "",
        // Newer sweeps carry an ISO start and a local time; older ones a UTC time.
        startedAt: s.started_at ?? `${s.date}T${s.time.replace(/Z$/, "")}:00Z`,
        workstream: mine ? "Work" : "Other",
        company: opts.companies ? companyUid(s.company) : mine ? opts.companyUid : s.company,
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
        origin: { companyUid: companyUid(r.company), repo: repo ? repoPath(repo) : null, product },
        releasedAt: r.merged_at?.trim() || null,
        pending,
        pendingCount: finite(r.pending_count) ?? pending.reduce((n, d) => n + d.count, 0),
        held: [],
        light: "ok" as const,
      };
    });

  const fleetIncident = fleetIncidentOf(sweep.fleet, sweep.generated_at, { companyUid: opts.companyUid, repo: null });
  if (fleetIncident) fleetIncident.companyUid = opts.companyUid;

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
    ...(fleetIncident ? { fleetIncidents: [fleetIncident] } : {}),
    ...(releases.length ? { releases } : {}),
  };
}
