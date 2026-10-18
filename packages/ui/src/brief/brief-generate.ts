/**
 * Daily Brief generator. Pure functions: the day's data in, a composition out.
 *
 * - The lead (what lead the brief) is picked by rules from that day's data, and
 *   the reason is a sentence the header shows, so the composition is never a
 *   mystery. Priority 1 is quoted in it.
 * - Widgets come from the catalogue (brief-catalogue.ts): each entry measures
 *   its evidence, is scored against today's priorities and the day type, and
 *   the picker fills a fixed 6-column template with everything that earned a
 *   slot (1 to 8 widgets). Every widget carries the sentence that explains it.
 * - Coming back after three or more days away gets a catch-up hero and at most
 *   five widgets.
 * - Sessions in companies outside the brief's set are counted, never named.
 */

import type { BriefInput, BriefPriority, BriefSession, BriefSlotSize, BriefWidgetKind } from "./brief-types.js";
import { briefPrompts } from "./brief-prompts.js";
import {
  CATALOGUE,
  MIN_DENSITY,
  TEMPLATES,
  VARIANTS,
  assignSlots,
  buildContext,
  eligible,
  entryOf,
  leadReason,
  notReadyScored,
  pick,
  reasonFor,
  spanOf,
  type BriefContext,
  type BriefLead,
  type DayType,
  type Dropped,
  type Scored,
  type Serve,
} from "./brief-catalogue.js";

export type { BriefLead, DayType, Dropped, Scored, Serve } from "./brief-catalogue.js";
export type { BriefSlotSize, BriefWidgetKind } from "./brief-types.js";
export { CATCH_UP_DAYS, CATCH_UP_DENSITY, MAX_DENSITY, MIN_DENSITY, TEMPLATES, daysSince, pickLead } from "./brief-catalogue.js";

export interface BriefWidget {
  kind: BriefWidgetKind;
  slot: string;
  size: BriefSlotSize;
  /** Grid span, in columns of 6 and rows of 2 or 3. */
  cols: number;
  rows: number;
  tier: 1 | 2 | 3;
  score: number;
  /** One sentence: why this card is on the page today. */
  reason: string;
  serves: Serve[];
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
  /** Header reason: priority 1 quoted, then the lead's own words. */
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
  dayType: DayType;
  /** Template name, e.g. "6B". */
  template: string;
  leadPriority: BriefPriority | null;
  /** Every entry with evidence: the eligible pool plus not-ready entries, for review mode. */
  scored: Scored[];
  /** What is not on the page and why, in the entry's own words. */
  dropped: Dropped[];
  /** One line per widget (name — reason), then one per dropped kind. */
  explain: string[];
}

/** Size classes each widget can render in, derived from the catalogue. */
export const FITS: Record<BriefWidgetKind, BriefSlotSize[]> = Object.fromEntries(CATALOGUE.map((e) => [e.id, [...e.fits]])) as Record<
  BriefWidgetKind,
  BriefSlotSize[]
>;

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

/** Areas rows for a template with its slots filled; unfilled slots read ".". */
function areasOf(name: string, slots: ReadonlyMap<string, Scored>): string[] {
  const tpl = TEMPLATES[name]!;
  return tpl.areas.map((row) =>
    row
      .split(" ")
      .map((slot) => slots.get(slot)?.kind ?? ".")
      .join(" "),
  );
}

function widgetsOf(name: string, slots: ReadonlyMap<string, Scored>, ctx: BriefContext | null): BriefWidget[] {
  const tpl = TEMPLATES[name]!;
  const widgets: BriefWidget[] = [];
  for (const slot of Object.keys(tpl.cls)) {
    const s = slots.get(slot);
    if (!s) continue;
    const { cols, rows } = spanOf(tpl, slot);
    widgets.push({
      kind: s.kind,
      slot,
      size: tpl.cls[slot]!,
      cols,
      rows,
      tier: s.tier,
      score: s.score,
      reason: ctx ? reasonFor(s.entry, s.ev, s.why, ctx) : "",
      serves: s.serves,
    });
  }
  return widgets;
}

/** A kind as a bare pool member, for span tests that place kinds without a day. */
function stub(kind: BriefWidgetKind): Scored {
  const entry = entryOf(kind);
  return {
    kind,
    entry,
    ev: { n: 0, value: 1, items: [], hash: kind, fact: "" },
    serves: [],
    tier: 3,
    score: 0,
    idx: CATALOGUE.indexOf(entry),
    parts: { value: 0, priority: 0, day: 0, pref: 0, rotation: 0 },
    why: { kind: "value" },
  };
}

/**
 * Place the first `n` kinds into the density-n template (its first variant):
 * a thin wrapper over `assignSlots` without pair checks, falling back to a
 * first-fit fill with holes when the hero does not fit. For span tests.
 */
export function place(n: number, pool: readonly BriefWidgetKind[]): { areas: string[]; widgets: BriefWidget[] } {
  const name = VARIANTS[n]?.[0] ?? String(MIN_DENSITY);
  const tpl = TEMPLATES[name]!;
  const picks = pool.slice(0, n).map(stub);
  let slots = assignSlots(tpl, picks, null);
  if (!slots) {
    slots = new Map();
    const left = [...picks];
    for (const [slot, size] of Object.entries(tpl.cls)) {
      const i = left.findIndex((p) => p.entry.fits.includes(size));
      if (i >= 0) slots.set(slot, left.splice(i, 1)[0]!);
    }
  }
  return { areas: areasOf(name, slots), widgets: widgetsOf(name, slots, null) };
}

export function generateBrief(input: BriefInput): BriefPlan {
  const ctx = buildContext(input);
  const dropped: Dropped[] = [];
  const pool = eligible(ctx, dropped);
  const picked = pick(ctx, pool);
  const widgets = widgetsOf(picked.template, picked.slots, ctx);
  const areas = areasOf(picked.template, picked.slots);
  const sessions = summarizeSessions(input.sessions, input.companies);

  // Host guarantee: a priority whose item has no card today is said so (the list above still shows it).
  const hosted = new Set([...picked.slots.values()].flatMap((s) => s.ev.items));
  for (const p of ctx.priorities) {
    if (p.itemId && !hosted.has(p.itemId)) dropped.push({ kind: `priority-${p.rank}`, why: `priority ${p.rank} has no card; shown in Today's priorities` });
  }
  dropped.push(...picked.skipped);

  const provenance = [
    { n: sessions.count, label: sessions.count === 1 ? "session" : "sessions" },
    { n: input.dmCount ?? 0, label: input.dmCount === 1 ? "DM" : "DMs" },
    {
      n: input.decisions.length + input.actionItems.length + input.risks.length,
      label: "signals",
    },
    { n: input.meetingsYesterday.length, label: input.meetingsYesterday.length === 1 ? "meeting" : "meetings" },
  ].filter((p) => p.n > 0);
  const leadPriority = ctx.priorities[0] ? (input.priorities?.[0] ?? { n: 1, text: ctx.priorities[0].text, because: ctx.priorities[0].because, itemId: ctx.priorities[0].itemId }) : null;
  return {
    lead: ctx.lead.lead,
    reason: leadReason(ctx, ctx.lead.reason),
    density: widgets.length,
    areas,
    widgets,
    sessions,
    daysAway: ctx.daysAway,
    provenance,
    prompts: briefPrompts(input),
    dayType: ctx.dayType,
    template: picked.template,
    leadPriority,
    scored: [...pool, ...notReadyScored(ctx)],
    dropped,
    explain: [...widgets.map((w) => `${entryOf(w.kind).name} — ${w.reason}`), ...dropped.map((d) => `${d.kind}: ${d.why}`)],
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

/** Rows start this short and grow to their content, so short cards leave no dead space. */
export const BRIEF_ROW_MIN_PX = 120;

/**
 * Inline grid style. Live: the plan's areas, rows sized to content. Review:
 * plain row flow in source order (never `dense`, which pulls a later group's
 * card up into a hole above its own label) with rows sized by their content,
 * so a group label is one short row; the cards keep the row minimum through
 * their own `min-height` in DailyBrief.
 */
export function gridStyle(areas: readonly string[], review: boolean): string {
  const row = `minmax(${BRIEF_ROW_MIN_PX}px, auto)`;
  return review
    ? "grid-auto-flow:row;grid-auto-rows:auto;grid-template-rows:none"
    : `grid-template-rows:repeat(${areas.length}, ${row});grid-template-areas:${areas.map((a) => `'${a}'`).join(" ")}`;
}
