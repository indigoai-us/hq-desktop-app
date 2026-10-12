/**
 * Where your day went: your own sessions from the last 24 hours grouped by
 * product, in the picker's own terms (the same session filter and product key
 * as the catalogue's focus entry, so the card and the picker count alike),
 * the context switches between products in time order, and the first and
 * last start. Pure: no clock, no locale; the component formats times.
 */

import { humanTitle } from "./brief-distill.js";
import { isTimelineSession } from "./brief-timeline.js";
import type { BriefSession } from "./brief-types.js";

/** Every list on the card: five, then "+N more". */
export const FOCUS_CAP = 5;
/** The picker's gate: fewer own sessions, or fewer products, and the card is hidden. */
export const FOCUS_MIN_SESSIONS = 3;
export const FOCUS_MIN_PRODUCTS = 2;

const HOUR_MS = 3_600_000;

export interface FocusGroup {
  /** The product's human name ("Desktop app"). */
  name: string;
  count: number;
  /** Fraction of the counted sessions, 0..1. */
  share: number;
  /** Company most of its sessions ran in (uid or slug), for the logo. */
  company: string | null;
  /** Oldest first. */
  sessions: BriefSession[];
}

export interface FocusSummary {
  /** Own sessions inside the brief's companies in the window. */
  total: number;
  /** Busiest first, then by name. */
  groups: FocusGroup[];
  /** Transitions between products in time order. */
  switches: number;
  /** ISO start of the first and last session, or null when there are none. */
  first: string | null;
  last: string | null;
  headline: string;
}

export interface TileLayout {
  /** grid-template-columns. */
  columns: string;
  rows: number;
  /** The busiest tile spans both rows. */
  spanFirst: boolean;
  /** The last tile spans two columns (four tiles: no empty cell). */
  spanLast: boolean;
}

/** The product a session counts under: the same key the picker's focus entry uses. */
export function productKey(s: BriefSession): string {
  return (s.product ?? s.project ?? s.workstream ?? "").trim();
}

const byStart = (a: BriefSession, b: BriefSession) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);

/**
 * Your own sessions (not agents or lanes) inside the brief's companies that
 * started in the `hours` before `now`, oldest first. Sessions with no company
 * are yours; sessions in another company never come out of here.
 */
export function focusSessions(sessions: readonly BriefSession[], companies: readonly string[], now: string, hours = 24): BriefSession[] {
  const inside = new Set(companies.map((c) => c.trim().toLowerCase()));
  const end = Date.parse(now);
  const windowed = Number.isFinite(end);
  return sessions
    .filter(isTimelineSession)
    .filter((s) => !s.company || inside.has(s.company.trim().toLowerCase()))
    .filter((s) => {
      if (!windowed) return true;
      const t = Date.parse(s.startedAt);
      return Number.isFinite(t) && t > end - hours * HOUR_MS && t <= end;
    })
    .sort(byStart);
}

/** The company most of a group's sessions ran in; ties go to the earliest seen. */
function mainCompany(sessions: readonly BriefSession[]): string | null {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const c = s.company?.trim();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [c, n] of counts) if (best == null || n > counts.get(best)!) best = c;
  return best;
}

/** Sessions grouped by product, busiest first then by name. Sessions with no product key are not grouped. */
export function focusGroups(sessions: readonly BriefSession[]): FocusGroup[] {
  const by = new Map<string, BriefSession[]>();
  for (const s of [...sessions].sort(byStart)) {
    const k = productKey(s);
    if (!k) continue;
    const list = by.get(k);
    if (list) list.push(s);
    else by.set(k, [s]);
  }
  const counted = [...by.values()].reduce((n, l) => n + l.length, 0);
  return [...by.entries()]
    .map(([name, list]) => ({ name, count: list.length, share: counted ? list.length / counted : 0, company: mainCompany(list), sessions: list }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** How many times the product changed between consecutive sessions, in time order. */
export function contextSwitches(sessions: readonly BriefSession[]): number {
  let n = 0;
  let prev: string | null = null;
  for (const s of [...sessions].sort(byStart)) {
    const k = productKey(s);
    if (!k) continue;
    if (prev != null && k !== prev) n += 1;
    prev = k;
  }
  return n;
}

/** "Mostly Desktop app"; a tie at the top reads "Split between Desktop app and HQ Cloud". */
export function focusHeadline(groups: readonly FocusGroup[]): string {
  const [a, b] = groups;
  if (!a) return "";
  if (b && b.count === a.count) return `Split between ${a.name} and ${b.name}`;
  return `Mostly ${a.name}`;
}

export function focusSummary(sessions: readonly BriefSession[], companies: readonly string[], now: string): FocusSummary {
  const own = focusSessions(sessions, companies, now);
  const groups = focusGroups(own);
  return {
    total: own.length,
    groups,
    switches: contextSwitches(own),
    first: own[0]?.startedAt ?? null,
    last: own[own.length - 1]?.startedAt ?? null,
    headline: focusHeadline(groups),
  };
}

/** The picker's gate for the focus entry: 3+ own sessions across 2+ products. */
export function hasFocus(sum: FocusSummary): boolean {
  return sum.total >= FOCUS_MIN_SESSIONS && sum.groups.length >= FOCUS_MIN_PRODUCTS;
}

/** A session title as a plain to-do: no repo, PR number or commit prefix. */
export function sessionLabel(title: string): string {
  return humanTitle(title).text.trim() || "Untitled session";
}

/**
 * Treemap shape for `n` tiles (product tiles plus the "+N more" tile): the
 * busiest product takes the wide left column; never an empty cell.
 */
export function tileLayout(n: number): TileLayout {
  if (n <= 1) return { columns: "1fr", rows: 1, spanFirst: false, spanLast: false };
  if (n === 2) return { columns: "2fr 1fr", rows: 1, spanFirst: false, spanLast: false };
  if (n === 3) return { columns: "2fr 1fr 1fr", rows: 1, spanFirst: false, spanLast: false };
  if (n === 4) return { columns: "2fr 1fr 1fr", rows: 2, spanFirst: true, spanLast: true };
  if (n === 5) return { columns: "2fr 1fr 1fr", rows: 2, spanFirst: true, spanLast: false };
  return { columns: "2fr 1fr 1fr", rows: 2, spanFirst: false, spanLast: false };
}
