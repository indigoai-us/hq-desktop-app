/**
 * Daily Brief generator. Pure functions: the day's data in, a composition out.
 *
 * - The lead (what lead the brief) is picked by rules from that day's data, and
 *   the reason is a sentence the header shows, so the composition is never a
 *   mystery.
 * - Density (widget count, 4 to 8) grows with open decisions, incidents and
 *   activity. A quiet day gets four calm widgets.
 * - Coming back after three or more days away gets a fixed five-widget
 *   catch-up view.
 * - Widgets are placed into fixed 6x3 grid templates. Each slot has a size
 *   class, and each widget lists the size classes it fits (the mockup's
 *   TPL / FITS approach).
 * - Sessions in companies outside the brief's set are counted, never named.
 */

import type { BriefInput, BriefRisk, BriefSession } from "./brief-types.js";
import { briefPrompts } from "./brief-prompts.js";

export type BriefLead = "decisions" | "incident" | "momentum" | "your-day" | "catch-up";

export type BriefWidgetKind =
  | "sunrise"
  | "needs"
  | "team"
  | "incident"
  | "shipped"
  | "waiting"
  | "meetings"
  | "risk"
  | "agenda"
  | "otherWork"
  | "oneThing"
  | "catchup";

export type BriefSlotSize = "XL" | "M" | "T" | "W" | "W3" | "S";

export interface BriefWidget {
  kind: BriefWidgetKind;
  slot: string;
  size: BriefSlotSize;
  /** Grid span, in columns of 6 and rows of 3. */
  cols: number;
  rows: number;
}

export interface BriefSessionSummary {
  /** Sessions inside the brief's companies. */
  count: number;
  byWorkstream: { name: string; count: number; titles: string[] }[];
  /** Sessions elsewhere. Counted only: no titles or workstreams. */
  otherCompanyCount: number;
}

export interface BriefPlan {
  lead: BriefLead;
  reason: string;
  density: number;
  /** grid-template-areas rows, widget kinds or "." for an empty cell. */
  areas: string[];
  widgets: BriefWidget[];
  sessions: BriefSessionSummary;
  /** Days since the last brief, or null for the first one. */
  daysAway: number | null;
  provenance: { n: number; label: string }[];
  /** Ready-written prompt per actionable item id (decisions, risks, waits, action items). */
  prompts: Record<string, string>;
}

export const MIN_DENSITY = 4;
export const MAX_DENSITY = 8;
export const CATCH_UP_DAYS = 3;
export const CATCH_UP_DENSITY = 5;

interface Template {
  areas: string[];
  cls: Record<string, BriefSlotSize>;
}

export const TEMPLATES: Record<number, Template> = {
  4: { areas: ["a a a b b c", "a a a b b c", "a a a d d c"], cls: { a: "XL", b: "M", c: "T", d: "W" } },
  5: { areas: ["a a a b b c", "a a a b b c", "d d e e e c"], cls: { a: "XL", b: "M", c: "T", d: "W", e: "W3" } },
  6: { areas: ["a a b b c d", "a a b b c d", "e e f f c d"], cls: { a: "M", b: "M", c: "T", d: "T", e: "W", f: "W" } },
  7: { areas: ["a a b b c d", "a a b b c d", "e e f g c d"], cls: { a: "M", b: "M", c: "T", d: "T", e: "W", f: "S", g: "S" } },
  8: {
    areas: ["a a b b c d", "a a b b c d", "e e f g h d"],
    cls: { a: "M", b: "M", c: "T", d: "T", e: "W", f: "S", g: "S", h: "S" },
  },
};

/** Size classes each widget can render in. */
export const FITS: Record<BriefWidgetKind, BriefSlotSize[]> = {
  sunrise: ["XL", "M"],
  needs: ["M", "W"],
  team: ["T"],
  incident: ["T", "S"],
  shipped: ["M", "W", "W3"],
  waiting: ["S"],
  meetings: ["T", "S"],
  risk: ["S"],
  agenda: ["T", "M"],
  otherWork: ["M", "S", "W"],
  oneThing: ["W"],
  catchup: ["XL"],
};

const DAY_MS = 86_400_000;

/** Whole days between the last brief and now; null when there was none. */
export function daysSince(lastBriefAt: string | null, now: string): number | null {
  if (!lastBriefAt) return null;
  const last = Date.parse(lastBriefAt);
  const at = Date.parse(now);
  if (!Number.isFinite(last) || !Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((at - last) / DAY_MS));
}

/**
 * Group sessions by workstream. Sessions in a company outside `companies`
 * only raise `otherCompanyCount`; their titles and workstreams are dropped
 * here so nothing downstream can show them. A session with no company is the
 * user's own and counts as inside.
 */
export function summarizeSessions(
  sessions: readonly BriefSession[],
  companies: readonly string[],
): BriefSessionSummary {
  const inside = new Set(companies.map((c) => c.toLowerCase()));
  const groups = new Map<string, { name: string; count: number; titles: string[] }>();
  let count = 0;
  let other = 0;
  for (const s of sessions) {
    if (s.company && !inside.has(s.company.toLowerCase())) {
      other += 1;
      continue;
    }
    count += 1;
    const name = s.workstream.trim() || "Other";
    const group = groups.get(name) ?? { name, count: 0, titles: [] };
    group.count += 1;
    if (s.title.trim()) group.titles.push(s.title.trim());
    groups.set(name, group);
  }
  const byWorkstream = [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { count, byWorkstream, otherCompanyCount: other };
}

function incidents(risks: readonly BriefRisk[]): BriefRisk[] {
  return risks.filter((r) => r.severity === "incident");
}

function watches(risks: readonly BriefRisk[]): BriefRisk[] {
  return risks.filter((r) => r.severity === "watch");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What leads, and why, in the header's words. */
export function pickLead(input: BriefInput): { lead: BriefLead; reason: string } {
  const away = daysSince(input.lastBriefAt, input.now);
  if (away != null && away >= CATCH_UP_DAYS) {
    return { lead: "catch-up", reason: `you were away ${plural(away, "day")}` };
  }
  const d = input.decisions.length;
  const fire = incidents(input.risks).length;
  if (fire > 0 && d < 3) {
    return {
      lead: "incident",
      reason: d > 0 ? `a live incident and ${plural(d, "call")}` : "a live incident",
    };
  }
  if (d >= 2) {
    return { lead: "decisions", reason: fire > 0 ? `${plural(d, "call")} and a live incident` : `${plural(d, "call")} waiting on you` };
  }
  if (input.shipped.length >= 2) {
    return { lead: "momentum", reason: `${plural(input.shipped.length, "thing")} shipped yesterday` };
  }
  const meetings = input.meetingsYesterday.length;
  if (meetings >= 4) return { lead: "your-day", reason: "yesterday was mostly meetings" };
  return { lead: "your-day", reason: d === 1 ? "one call and a light day" : "a quiet day" };
}

/** Widgets with data behind them, in this lead's order of importance. */
export function candidates(input: BriefInput, lead: BriefLead, sessions: BriefSessionSummary): BriefWidgetKind[] {
  const has: Record<BriefWidgetKind, boolean> = {
    sunrise: true,
    needs: input.decisions.length > 0,
    team: input.team.length > 0,
    incident: incidents(input.risks).length > 0,
    shipped: input.shipped.length > 0,
    waiting: input.waitingOn.length > 0,
    meetings: input.meetingsYesterday.length > 0,
    risk: watches(input.risks).length > 0,
    agenda: input.calendarToday.length > 0,
    otherWork: sessions.otherCompanyCount > 0,
    oneThing: input.decisions.length > 0,
    catchup: true,
  };
  const order: Record<BriefLead, BriefWidgetKind[]> = {
    decisions: ["sunrise", "needs", "team", "incident", "shipped", "waiting", "meetings", "risk", "otherWork", "agenda"],
    incident: ["sunrise", "incident", "needs", "team", "shipped", "waiting", "risk", "meetings", "otherWork", "agenda"],
    momentum: ["sunrise", "shipped", "meetings", "team", "waiting", "needs", "risk", "otherWork", "agenda"],
    "your-day": ["sunrise", "agenda", "shipped", "meetings", "otherWork", "needs", "team", "waiting", "risk"],
    "catch-up": ["catchup", "needs", "agenda", "team", "oneThing", "shipped", "incident"],
  };
  return order[lead].filter((kind) => has[kind]);
}

/** Widget count for the day, 4 to 8. */
export function density(input: BriefInput, lead: BriefLead, available: number): number {
  if (lead === "catch-up") return CATCH_UP_DENSITY;
  const n =
    3 +
    input.decisions.length +
    (incidents(input.risks).length > 0 ? 1 : 0) +
    (input.shipped.length >= 3 ? 1 : 0) +
    (input.meetingsYesterday.length >= 4 ? 1 : 0);
  return Math.max(MIN_DENSITY, Math.min(MAX_DENSITY, n, available));
}

/** Fill a template's slots in order with the first widget that fits each. */
export function place(n: number, pool: readonly BriefWidgetKind[]): { areas: string[]; widgets: BriefWidget[] } {
  const template = TEMPLATES[n] ?? TEMPLATES[MIN_DENSITY]!;
  const left = pool.slice(0, n);
  const bySlot = new Map<string, BriefWidgetKind | null>();
  for (const [slot, size] of Object.entries(template.cls)) {
    const i = left.findIndex((kind) => FITS[kind].includes(size));
    bySlot.set(slot, i >= 0 ? left.splice(i, 1)[0]! : null);
  }
  const areas = template.areas.map((row) =>
    row
      .split(" ")
      .map((slot) => bySlot.get(slot) ?? ".")
      .join(" "),
  );
  const widgets: BriefWidget[] = [];
  for (const [slot, kind] of bySlot) {
    if (!kind) continue;
    let x0 = 9;
    let x1 = -1;
    let y0 = 9;
    let y1 = -1;
    template.areas.forEach((row, y) =>
      row.split(" ").forEach((cell, x) => {
        if (cell !== slot) return;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }),
    );
    widgets.push({ kind, slot, size: template.cls[slot]!, cols: x1 - x0 + 1, rows: y1 - y0 + 1 });
  }
  return { areas, widgets };
}

export function generateBrief(input: BriefInput): BriefPlan {
  const { lead, reason } = pickLead(input);
  const sessions = summarizeSessions(input.sessions, input.companies);
  const pool = candidates(input, lead, sessions);
  // The catch-up template is fixed; a thin pool still fills what it can.
  const n = density(input, lead, pool.length);
  const { areas, widgets } = place(n, pool);
  const provenance = [
    { n: sessions.count, label: sessions.count === 1 ? "session" : "sessions" },
    { n: input.dmCount ?? 0, label: input.dmCount === 1 ? "DM" : "DMs" },
    {
      n: input.decisions.length + input.actionItems.length + input.risks.length,
      label: "signals",
    },
    { n: input.meetingsYesterday.length, label: input.meetingsYesterday.length === 1 ? "meeting" : "meetings" },
  ].filter((p) => p.n > 0);
  return {
    lead,
    reason,
    density: n,
    areas,
    widgets,
    sessions,
    daysAway: daysSince(input.lastBriefAt, input.now),
    provenance,
    prompts: briefPrompts(input),
  };
}

/** Header label for a lead. */
export function leadLabel(lead: BriefLead): string {
  return {
    decisions: "Decisions",
    incident: "Incident",
    momentum: "Momentum",
    "your-day": "Your day",
    "catch-up": "Catch-up",
  }[lead];
}
