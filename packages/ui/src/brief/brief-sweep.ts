/**
 * The morning sweep's output (`workspace/brief/<date>/brief-data.json`,
 * written by the brief sweep prompt) mapped into brief input. Pure.
 *
 * What the sweep carries, and where it lands:
 * - prs ............................... merged and opened totals for the PR
 *                                       window (the one source for those
 *                                       counts), shipped cards per repo for
 *                                       the day, window totals by repo
 * - meeting_signals ................... yesterday's meetings with real counts
 * - main_health ....................... red main CI becomes a live incident
 * - window.today ...................... the brief's local date (weekday source)
 * The fleet breakdown is read but not mapped: the owner rejected a fleet-count
 * card, and the incident card carries the stuck/healthy measure instead.
 * - dms ............................... who you talked with (agents labeled)
 * - sessions .......................... sessions; other companies counted only
 * It has no calendar, no decision text and no waits; those stay with the
 * adapter or are absent.
 */

import type { BriefInput, BriefMeeting, BriefRisk, BriefSession, BriefShipped, BriefTeammate } from "./brief-types.js";

export interface BriefSweep {
  generated_at?: string;
  company?: string;
  window?: { from: string; to: string; today?: string };
  days?: Record<string, { merged?: number; opened?: number; sessions?: number; other_sessions?: number; meetings?: number }>;
  sessions?: {
    date: string;
    time: string;
    company: string | null;
    title: string | null;
    /** ISO start, written by newer sweeps; older ones only have date + UTC time. */
    started_at?: string;
    /** you | agent | lane; absent in older sweeps (all treated as yours). */
    kind?: string;
  }[];
  meeting_signals?: { meeting: string; start: string; counts: Record<string, number> }[];
  dms?: { from: string; from_uid?: string; is_agent?: boolean; at: string }[];
  fleet?: { total: number; by_status?: Record<string, number> } | null;
  prs?: { repo: string; number: number; title: string; state: string; created: string; closed: string }[];
  main_health?: Record<string, { workflows: number; red: string[] }>;
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

const isDay = (iso: string, day: string) => iso.slice(0, 10) === day;

/** Local calendar day of an ISO time, YYYY-MM-DD. */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseSweep(text: string): BriefSweep | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as BriefSweep) : null;
  } catch {
    return null;
  }
}

/** The fields of BriefInput the sweep can fill. */
export type SweepInput = Pick<
  BriefInput,
  "meetingsYesterday" | "risks" | "shipped" | "team" | "sessions" | "merged" | "opened" | "prWindow" | "dmCount" | "today"
>;

export function sweepToInput(sweep: BriefSweep, opts: SweepOptions): SweepInput {
  const org = opts.org ?? "indigoai-us";
  const origin = (repo: string) => ({ companyUid: opts.companyUid, repo: `${org}/${repo}` });
  const prs = sweep.prs ?? [];
  // One source for merged and opened everywhere: the sweep's PR window
  // (window.from onward). The per-day rollup is not used for these counts.
  const from = sweep.window?.from ?? null;
  const inWindow = (iso: string | undefined) => !!iso && !iso.startsWith("0001") && (!from || iso.slice(0, 10) >= from);
  const windowMerged = prs.filter((p) => p.state === "merged" && inWindow(p.closed)).length;
  const windowOpened = prs.filter((p) => (p.state === "open" || p.state === "merged") && inWindow(p.created)).length;

  // Shipped: the day's merged PRs grouped by repo, biggest first.
  const mergedToday = prs.filter((p) => p.state === "merged" && isDay(p.closed, opts.day));
  const byRepoToday = new Map<string, typeof prs>();
  for (const p of mergedToday) byRepoToday.set(p.repo, [...(byRepoToday.get(p.repo) ?? []), p]);
  const shipped: BriefShipped[] = [...byRepoToday.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([repo, list]) => {
      const open = prs.filter((p) => p.repo === repo && p.state === "open").length;
      return {
        id: `ship:${repo}`,
        title: repo,
        status: `${list.length} merged`,
        note: open ? `${open} open` : "nothing open",
        origin: origin(repo),
        lines: list.map((p) => ({ label: `${p.number} ${p.title}`, state: "MERGED", tone: "ok" as const })),
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

  const risks: BriefRisk[] = Object.entries(sweep.main_health ?? {})
    .filter(([, h]) => h.red.length > 0)
    .map(([repo, h]) => ({
      id: `ci:${repo}`,
      title: `${repo} main CI red`,
      summary: `${h.red.join(", ")} failing on main (${h.red.length} of ${h.workflows} workflows).`,
      severity: "incident" as const,
      links: [],
      origin: origin(repo),
      ci: {
        repo,
        workflow: h.red.length > 1 ? `${h.red[0]} +${h.red.length - 1} more` : (h.red[0] ?? null),
        job: null,
        since: null,
        ageHours: null,
        note: `${h.red.length} of ${h.workflows} workflows red on main.`,
      },
    }));

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

  const sessions: BriefSession[] = (sweep.sessions ?? [])
    .filter((s) => s.date === opts.day && s.company !== "unknown" && (s.kind ?? "you") === "you")
    .map((s, i) => ({
      id: `sweep-session-${i}`,
      title: s.title ?? "",
      // Newer sweeps carry an ISO start and a local time; older ones a UTC time.
      startedAt: s.started_at ?? `${s.date}T${s.time.replace(/Z$/, "")}:00Z`,
      workstream: s.company === sweep.company ? "Work" : "Other",
      company: s.company === sweep.company ? opts.companyUid : s.company,
    }));

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
  };
}
