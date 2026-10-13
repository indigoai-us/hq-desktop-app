/**
 * Daily Brief widget catalogue and picker core. Pure: the same (input, prefs,
 * previous) always gives the same plan. No Date.now, no Math.random, no
 * toLocale*; `today`, `now`, `prefs` and `previous` are inputs.
 *
 * Every grid card is one catalogue entry with a single `measure()` that
 * returns Evidence (headline count, value 0..3 from fixed thresholds, the item
 * ids it hosts, a content hash for rotation, a lowercase fact clause) and a
 * `serves()` that maps the card to today's priorities. The picker scores the
 * entries, ranks them (tier, best contained priority, score, value, registry
 * order), sizes the grid from what earned a slot, and fills a fixed template
 * with a backtracking slot assignment that honours the overlap pairs. Reason
 * sentences are composed here from fixed patterns so one lint covers all of
 * them. Review mode and the live page use the same functions.
 */

import { briefPriorities } from "./brief-peeks.js";
import { productName } from "./brief-origin.js";
import { isTimelineSession } from "./brief-timeline.js";
import type {
  BriefCalendarEvent,
  BriefDecision,
  BriefInput,
  BriefMeeting,
  BriefOrigin,
  BriefPrefs,
  BriefPrevious,
  BriefRisk,
  BriefSession,
  BriefSlotSize,
  BriefWidgetKind,
} from "./brief-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_DENSITY = 4;
export const MAX_DENSITY = 8;
export const CATCH_UP_DAYS = 3;
export const CATCH_UP_DENSITY = 5;
export const WEIGHTS = { value: 10, elaborates: 2, mentions: 1, priorityCap: 10, pref: 5, rotation: 5, weekendMinValue: 2 } as const;
const RANK_W = (rank: number) => 6 - rank; // 5..1

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Lead (moved here from brief-generate.ts, which re-exports it)
// ---------------------------------------------------------------------------

export type BriefLead = "decisions" | "incident" | "momentum" | "your-day" | "catch-up";

/** Whole days between the last brief and now; null when there was none. */
export function daysSince(lastBriefAt: string | null, now: string): number | null {
  if (!lastBriefAt) return null;
  const last = Date.parse(lastBriefAt);
  const at = Date.parse(now);
  if (!Number.isFinite(last) || !Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((at - last) / DAY_MS));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What leads, and why, in the header's words. */
export function pickLead(input: BriefInput): { lead: BriefLead; reason: string } {
  const away = daysSince(input.lastBriefAt, input.now);
  if (away != null && away >= CATCH_UP_DAYS) {
    return { lead: "catch-up", reason: `you were away ${plural(away, "day")}` };
  }
  if (input.catchUp === true) {
    return { lead: "catch-up", reason: away != null && away > 0 ? `you were away ${plural(away, "day")}` : "a catch-up brief" };
  }
  const d = input.decisions.length;
  const fire = input.risks.filter((r) => r.severity === "incident").length;
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

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type DayType = "catch-up" | "post-incident" | "monday" | "friday" | "weekend" | "midweek";

export interface PriorityItem {
  rank: number;
  text: string;
  because: string | null;
  itemId: string | null;
  kind: "decision" | "incident" | "handoff" | "carry" | null;
}

export interface BriefContext {
  input: BriefInput;
  /** YYYY-MM-DD local. */
  today: string;
  /** 0 = Sunday .. 6 = Saturday, by arithmetic on `today`. */
  weekday: number;
  dayType: DayType;
  daysAway: number | null;
  lead: { lead: BriefLead; reason: string };
  priorities: PriorityItem[];
  incidents: BriefRisk[];
  watches: BriefRisk[];
  /** Start of the window cards look back over (ms). */
  windowFrom: number;
  nowMs: number;
  /** Your own sessions inside the brief's companies. */
  ownSessions: BriefSession[];
  prefs: BriefPrefs;
  previous: BriefPrevious | null;
}

/** Weekday of a YYYY-MM-DD date, 0 = Sunday. Machine-timezone independent (1970-01-01 was a Thursday). */
export function weekdayOf(today: string): number {
  const [y, m, d] = today.split("-").map(Number);
  const days = Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / DAY_MS);
  return (((days + 4) % 7) + 7) % 7;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The brief's local date: `input.today` from the sweep, else the date part of `now`. */
export function todayOf(input: BriefInput): string {
  const t = input.today?.trim() ?? "";
  return DAY_RE.test(t) ? t : input.now.slice(0, 10);
}

const NEVER_HIDDEN: readonly BriefWidgetKind[] = ["sunrise", "catchup", "needs"];

export function normalizePrefs(prefs: BriefPrefs | null | undefined): BriefPrefs {
  return {
    density: prefs?.density === "calm" || prefs?.density === "full" ? prefs.density : "auto",
    pinned: [...new Set(prefs?.pinned ?? [])],
    hidden: [...new Set(prefs?.hidden ?? [])].filter((k) => !NEVER_HIDDEN.includes(k)),
    weights: { ...(prefs?.weights ?? {}) },
  };
}

function resolveKind(input: BriefInput, itemId: string | null): PriorityItem["kind"] {
  if (!itemId) return null;
  if (input.decisions.some((d) => d.id === itemId)) return "decision";
  if (input.risks.some((r) => r.id === itemId && r.severity === "incident")) return "incident";
  if ((input.handoffs ?? []).some((h) => h.id === itemId)) return "handoff";
  if ((input.carry ?? []).some((c) => c.id === itemId || c.itemId === itemId)) return "carry";
  return null;
}

export function buildContext(input: BriefInput): BriefContext {
  const today = todayOf(input);
  const weekday = weekdayOf(today);
  const daysAway = daysSince(input.lastBriefAt, input.now);
  const lead = pickLead(input);
  const incidents = input.risks.filter((r) => r.severity === "incident");
  const watches = input.risks.filter((r) => r.severity === "watch");
  const catchUp = input.catchUp === true || (daysAway != null && daysAway >= CATCH_UP_DAYS);
  const dayType: DayType = catchUp
    ? "catch-up"
    : (input.recovered?.length ?? 0) > 0 && incidents.length === 0
      ? "post-incident"
      : weekday === 1
        ? "monday"
        : weekday === 5
          ? "friday"
          : weekday === 0 || weekday === 6
            ? "weekend"
            : "midweek";
  const nowMs = Date.parse(input.now);
  const lastMs = input.lastBriefAt ? Date.parse(input.lastBriefAt) : NaN;
  const windowFrom = catchUp && Number.isFinite(lastMs) && lastMs < nowMs ? lastMs : nowMs - DAY_MS;
  const inside = new Set(input.companies.map((c) => c.toLowerCase()));
  const ownSessions = (input.recentSessions ?? input.sessions)
    .filter(isTimelineSession)
    .filter((s) => !s.company || inside.has(s.company.toLowerCase()));
  const priorities: PriorityItem[] = briefPriorities(input).map((p, i) => ({
    rank: i + 1,
    text: p.text,
    because: p.because,
    itemId: p.itemId,
    kind: resolveKind(input, p.itemId),
  }));
  return {
    input,
    today,
    weekday,
    dayType,
    daysAway,
    lead,
    priorities,
    incidents,
    watches,
    windowFrom,
    nowMs,
    ownSessions,
    prefs: normalizePrefs(input.prefs),
    previous: input.previous ?? null,
  };
}

// ---------------------------------------------------------------------------
// Catalogue entry shape
// ---------------------------------------------------------------------------

export interface Evidence {
  /** Headline count, shown in review mode. */
  n: number;
  /** Fixed thresholds written in the entry; 0 = quiet filler = hidden. */
  value: 0 | 1 | 2 | 3;
  /** Decision/incident/handoff/carry ids the card shows (host guarantee for priorities). */
  items: string[];
  /** Content key for rotation (sorted ids or titles). */
  hash: string;
  /** Lowercase clause with real counts and product names: "5 calls wait on you, 3 over a day". */
  fact: string;
}

export interface Serve {
  priority: number;
  itemId: string | null;
  role: "contains" | "elaborates" | "mentions";
  what: string;
}

export type WidgetGroup = "hero" | "needs" | "health" | "waiting" | "momentum" | "people" | "self";

export interface WidgetEntry {
  id: BriefWidgetKind;
  /** Eyebrow wording ("What your calls unblock"). */
  name: string;
  group: WidgetGroup;
  /** "BriefNeedsYou" (file Brief<Name>.svelte). */
  component: string;
  /** false until the component exists and DailyBrief has its branch. */
  ready: boolean;
  /** Best first; review mode uses fits[0]. */
  fits: BriefSlotSize[];
  hero?: (ctx: BriefContext) => boolean;
  /** Rotation applies (informational cards only). */
  novel: boolean;
  /** null = no data, trivial data, or a gate failed (window, attended, weekday). */
  measure(ctx: BriefContext): Evidence | null;
  serves(ctx: BriefContext, ev: Evidence): Serve[];
  dayBonus?(ctx: BriefContext, ev: Evidence): number;
}

// ---------------------------------------------------------------------------
// Fact helpers (pure, no locale)
// ---------------------------------------------------------------------------

function names(list: readonly string[], max = 3): string {
  const u = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  if (!u.length) return "";
  if (u.length === 1) return u[0]!;
  if (u.length <= max) return `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
  return `${u.slice(0, max).join(", ")} and ${u.length - max} more`;
}

function productOf(origin: BriefOrigin | null | undefined): string {
  const p = productName(origin?.repo ?? null, origin?.product ?? null);
  return p || "a product";
}

function hoursText(h: number): string {
  if (h < 1) return "under an hour";
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)} days`;
}

function minutesText(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

const sortedKey = (ids: readonly string[]) => [...ids].sort().join("|");
const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
const sortedIds = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();

function redHours(r: BriefRisk, nowMs: number): number | null {
  if (r.ci?.ageHours != null && Number.isFinite(r.ci.ageHours)) return r.ci.ageHours;
  if (r.ci?.since) {
    const t = Date.parse(r.ci.since);
    if (Number.isFinite(t)) return Math.max(0, (nowMs - t) / HOUR_MS);
  }
  return null;
}

/** A red main by product and workflow; anything else as "a <product> problem", since a verb-first title cannot be a sentence subject. */
function incidentLabel(r: BriefRisk): string {
  if (r.ci) return `${productOf(r.origin)}'s ${r.ci.workflow ?? "main CI"}`;
  return `a ${productOf(r.origin)} problem`;
}

function incidentState(r: BriefRisk, nowMs: number): string {
  const age = redHours(r, nowMs);
  if (r.ci) return `has been red${age != null ? ` for ${hoursText(age)}` : ""}`;
  return `is live${age != null ? ` for ${hoursText(age)}` : ""}`;
}

const decisionWeight = (d: BriefDecision) => (d.peopleWaiting ?? 0) + (d.detail?.unlocks.length ?? 0) + (d.revenue ? 2 : 0);

/** Decisions with an edge: named blocks or unlock lines. */
const edgedDecisions = (ctx: BriefContext) => ctx.input.decisions.filter((d) => (d.blocks?.length ?? 0) > 0 || (d.detail?.unlocks.length ?? 0) > 0);

/** What one decision frees: named people, else "N things". Never "people" without names. */
function freedBy(d: BriefDecision): string {
  const people = (d.blocks ?? []).filter((b) => b.kind === "person").map((b) => b.who);
  if (people.length) return names(people);
  const n = (d.blocks?.length ?? 0) || (d.detail?.unlocks.length ?? 0);
  return plural(n, "thing");
}

/** Meetings the owner attended inside the window. */
function meetingsInWindow(ctx: BriefContext): BriefMeeting[] {
  return ctx.input.meetingsYesterday
    .filter((m) => m.attended !== false && Date.parse(m.startTime) >= ctx.windowFrom)
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || byId(a, b));
}

const decidedLines = (ms: readonly BriefMeeting[]) => ms.reduce((n, m) => n + (m.decided?.length ?? 0), 0);

/** The decision a priority points at, if any. */
const priorityDecision = (ctx: BriefContext, p: PriorityItem) => (p.itemId ? ctx.input.decisions.find((d) => d.id === p.itemId) ?? null : null);

/** Whether a decision came out of a meeting (origin names it, or the source line does). */
function decisionFromMeeting(d: BriefDecision, m: BriefMeeting): boolean {
  const title = m.title.trim().toLowerCase();
  if (!title) return false;
  return (d.origin.repo ?? "").trim().toLowerCase() === title || (d.detail?.source ?? "").toLowerCase().includes(title);
}

function sessionProducts(sessions: readonly BriefSession[]): string[] {
  return [...new Set(sessions.map((s) => (s.product ?? s.project ?? s.workstream ?? "").trim()).filter(Boolean))].sort();
}

const timedEvents = (events: readonly BriefCalendarEvent[]) => events.filter((e) => !e.busy && Number.isFinite(Date.parse(e.start)));

interface Gap {
  minutes: number;
  /** Event the gap follows, or null when it runs from now to the first call. */
  after: BriefCalendarEvent | null;
  before: BriefCalendarEvent | null;
}

function longestGap(ctx: BriefContext): Gap | null {
  const events = [...ctx.input.calendarToday]
    .filter((e) => Number.isFinite(Date.parse(e.start)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  if (!events.length) return null;
  const endOf = (e: BriefCalendarEvent) => {
    const end = e.end ? Date.parse(e.end) : NaN;
    return Number.isFinite(end) && end > Date.parse(e.start) ? end : Date.parse(e.start) + 30 * 60_000;
  };
  const gaps: Gap[] = [];
  const first = events[0]!;
  if (Date.parse(first.start) > ctx.nowMs) gaps.push({ minutes: (Date.parse(first.start) - ctx.nowMs) / 60_000, after: null, before: first });
  for (let i = 0; i < events.length - 1; i += 1) {
    const a = events[i]!;
    const b = events[i + 1]!;
    const minutes = (Date.parse(b.start) - endOf(a)) / 60_000;
    if (minutes > 0) gaps.push({ minutes, after: a, before: b });
  }
  let best: Gap | null = null;
  for (const g of gaps) if (g.minutes >= 30 && (!best || g.minutes > best.minutes)) best = g;
  return best;
}

const gapText = (g: Gap) => `${minutesText(g.minutes)} clear ${g.after ? `after ${g.after.title}` : `before ${g.before!.title}`}`;

// ---------------------------------------------------------------------------
// The catalogue, in registry order (= final tiebreak = review-mode order)
// ---------------------------------------------------------------------------

const value3 = (n: number, two: number, three: number): 1 | 2 | 3 => (n >= three ? 3 : n >= two ? 2 : 1);

export const CATALOGUE: readonly WidgetEntry[] = [
  {
    id: "sunrise",
    name: "Sunrise",
    group: "hero",
    component: "BriefSunrise",
    ready: true,
    fits: ["XL", "L", "M"],
    hero: (ctx) => ctx.dayType !== "catch-up",
    novel: false,
    measure(ctx) {
      if (ctx.dayType === "catch-up") return null; // the Welcome back hero greets instead
      const d = ctx.input.decisions.length;
      const s = ctx.ownSessions.length;
      const calls = d ? `${plural(d, "call")} before a clear day` : "a clear day";
      const sessions = s ? `your ${plural(s, "session")} since yesterday` : "no sessions since yesterday";
      return { n: d, value: 3, items: [], hash: "sunrise", fact: `${calls}, and ${sessions}` };
    },
    serves: () => [],
  },
  {
    id: "catchup",
    name: "Welcome back",
    group: "hero",
    component: "BriefCatchUp",
    ready: true,
    // L as well as XL: quiet template 2 seats its hero at L, and a catch-up day with one card
    // besides the hero (two calls, nothing else) must keep that card rather than fall to the hero alone.
    fits: ["XL", "L"],
    hero: (ctx) => ctx.dayType === "catch-up",
    novel: false,
    measure(ctx) {
      if (ctx.dayType !== "catch-up") return null;
      const items = [
        ...sortedIds(ctx.incidents),
        ...rankDecisions(ctx).slice(0, 2).map((d) => d.id),
        ...sortedIds(ctx.input.recovered ?? []),
        ...sortedIds(ctx.input.handoffs ?? []),
      ];
      const p1 = ctx.priorities[0];
      // brief.json can ask for a catch-up on a day the owner was not away (daysAway 0 or
      // unknown): say what was asked for rather than "you were away 0 days".
      const away = ctx.daysAway;
      const opener = away != null && away >= 1 ? `you were away ${plural(away, "day")}` : "you asked for a catch-up";
      return {
        n: items.length,
        value: 3,
        items,
        hash: sortedKey(items),
        fact: `${opener}: what changed, in five tiles${p1 ? `, starting with "${p1.text}"` : ""}`,
      };
    },
    serves(ctx, ev) {
      return ctx.priorities
        .filter((p) => p.itemId && ev.items.includes(p.itemId))
        .map((p) => ({ priority: p.rank, itemId: p.itemId, role: "contains" as const, what: "it is one of the tiles" }));
    },
  },
  {
    id: "needs",
    name: "Needs you",
    group: "needs",
    component: "BriefNeedsYou",
    ready: true,
    fits: ["M", "L", "W"],
    novel: false,
    measure(ctx) {
      const ds = ctx.input.decisions;
      if (!ds.length) return null;
      const old = ds.filter((d) => (d.ageHours ?? 0) > 24).length;
      return {
        n: ds.length,
        value: value3(ds.length, 2, 4),
        items: sortedIds(ds),
        hash: sortedKey(ds.map((d) => d.id)),
        fact: `${plural(ds.length, "call")} wait${ds.length === 1 ? "s" : ""} on you${old ? `, ${old} over a day` : ""}`,
      };
    },
    serves(ctx, ev) {
      const more = ev.n - 1;
      return ctx.priorities
        .filter((p) => p.itemId && ev.items.includes(p.itemId))
        .map((p) => ({
          priority: p.rank,
          itemId: p.itemId,
          role: "contains" as const,
          what: more > 0 ? `it and ${plural(more, "more call")} wait on you` : "it waits on you",
        }));
    },
  },
  {
    id: "oneThing",
    name: "If you do one thing",
    group: "needs",
    component: "BriefOneThing",
    ready: true,
    fits: ["W", "W3"],
    novel: false,
    measure(ctx) {
      const ds = ctx.input.decisions;
      if (!ctx.input.leadHint && !ds.length) return null;
      if (ds.length > 2 && ctx.dayType !== "catch-up") return null;
      let best: BriefDecision | null = null;
      for (const d of [...ds].sort(byId)) if (!best || decisionWeight(d) > decisionWeight(best)) best = d;
      const k = best ? (best.detail?.unlocks.length ?? 0) + (best.blocks?.length ?? 0) : 0;
      const fact = best
        ? `one call unlocks the most${k ? `, ${plural(k, "thing")}` : ""}: "${best.title}"`
        : `your lead hint says "${ctx.input.leadHint}"`;
      return { n: best ? 1 : 0, value: 2, items: best ? [best.id] : [], hash: best?.id ?? "hint", fact };
    },
    serves(ctx, ev) {
      const p1 = ctx.priorities[0];
      if (!p1) return [];
      const best = ev.items[0] ? ctx.input.decisions.find((d) => d.id === ev.items[0]) : null;
      const what = best && p1.itemId === best.id ? "it is the one call that unlocks the most" : best ? `"${best.title}" unlocks the most` : "it is the one thing to do first";
      return [{ priority: 1, itemId: p1.itemId, role: "elaborates", what }];
    },
  },
  {
    id: "blockedByMe",
    name: "What your calls unblock",
    group: "needs",
    component: "BriefBlockedByMe",
    ready: true,
    fits: ["M", "W", "W3"],
    novel: false,
    measure(ctx) {
      const edged = edgedDecisions(ctx).sort(byId);
      if (!edged.length) return null;
      const blocks = edged.flatMap((d) => d.blocks ?? []);
      const parties = [...new Set(blocks.map((b) => b.who.trim()).filter(Boolean))].sort();
      const people = [...new Set(blocks.filter((b) => b.kind === "person").map((b) => b.who.trim()).filter(Boolean))].sort();
      const unlocks = edged.reduce((n, d) => n + (d.detail?.unlocks.length ?? 0), 0);
      const value: 1 | 2 | 3 = parties.length ? (parties.length >= 5 ? 3 : parties.length >= 2 ? 2 : 1) : 1;
      const verb = edged.length === 1 ? "frees" : "free";
      const who = parties.length ? (people.length ? names(people) : plural(parties.length, "thing")) : plural(unlocks, "thing");
      return {
        n: parties.length || unlocks,
        value,
        items: edged.map((d) => d.id),
        hash: sortedKey(edged.map((d) => d.id)),
        fact: `${plural(edged.length, "call")} of yours ${verb} ${who}`,
      };
    },
    serves(ctx, ev) {
      return ctx.priorities
        .filter((p) => p.itemId && ev.items.includes(p.itemId))
        .map((p) => ({ priority: p.rank, itemId: p.itemId, role: "elaborates" as const, what: `it frees ${freedBy(priorityDecision(ctx, p)!)}` }));
    },
  },
  {
    id: "incident",
    name: "Incident",
    group: "health",
    component: "BriefIncident",
    ready: true,
    fits: ["S", "W", "W3", "M"],
    novel: false,
    measure(ctx) {
      const inc = [...ctx.incidents].sort(byId);
      if (!inc.length) return null;
      const ages = inc.map((r) => redHours(r, ctx.nowMs)).filter((h): h is number => h != null);
      const oldest = ages.length ? Math.max(...ages) : null;
      const value: 2 | 3 = inc.length >= 2 || (oldest != null && oldest > 24) ? 3 : 2;
      const fact =
        inc.length === 1
          ? `${incidentLabel(inc[0]!)} ${incidentState(inc[0]!, ctx.nowMs)}`
          : `${plural(inc.length, "incident")} are live${oldest != null ? `, one red for ${hoursText(oldest)}` : ""}`;
      return { n: inc.length, value, items: inc.map((r) => r.id), hash: sortedKey(inc.map((r) => r.id)), fact };
    },
    serves(ctx, ev) {
      return ctx.priorities
        .filter((p) => p.itemId && ev.items.includes(p.itemId))
        .map((p) => {
          // One other incident is named; past that they are counted, so the sentence stays inside the lint's 160 characters.
          const others = [...ctx.incidents].sort(byId).filter((r) => r.id !== p.itemId);
          const ages = others.map((r) => redHours(r, ctx.nowMs)).filter((h): h is number => h != null);
          const oldest = ages.length ? Math.max(...ages) : null;
          const rest =
            others.length === 1
              ? `${incidentLabel(others[0]!)} ${incidentState(others[0]!, ctx.nowMs)}`
              : others.length > 1
                ? `so are ${others.length} more${oldest != null ? `, one red for ${hoursText(oldest)}` : ""}`
                : "";
          return { priority: p.rank, itemId: p.itemId, role: "contains" as const, what: `it is live${rest ? `, and ${rest}` : ""}` };
        });
    },
  },
  {
    id: "fleetRecovery",
    name: "Fleet recovery",
    group: "health",
    component: "BriefFleetRecovery",
    ready: true,
    fits: ["M", "W", "S"],
    novel: false,
    measure(ctx) {
      const fi = ctx.input.fleetIncident;
      if (!fi) return null;
      const ended = fi.incidentEnd ? Date.parse(fi.incidentEnd) : NaN;
      if (Number.isFinite(ended) && ctx.nowMs - ended > DAY_MS) return null;
      // A recovery arc needs a previous run to compare with; the first brief has only today's point,
      // and "plateaued" would be a claim with no evidence. The incident card still hosts the stuck set.
      if (fi.series.length < 2 && fi.verdict !== "healed") return null;
      const value: 1 | 2 | 3 = fi.verdict === "relapsing" || fi.verdict === "plateaued" ? 3 : fi.verdict === "healing" ? 2 : 1;
      const stuck = fi.stillStuck.length;
      const fact = fi.verdict === "healed" ? "the fleet healed: no agent still stuck" : `the fleet is ${fi.verdict}: ${plural(stuck, "agent")} still stuck`;
      return { n: stuck, value, items: [fi.id], hash: `${fi.id}|${fi.verdict}|${stuck}`, fact };
    },
    serves(ctx, ev) {
      const fi = ctx.input.fleetIncident!;
      return ctx.priorities
        .filter((p) => p.itemId && ev.items.includes(p.itemId))
        .map((p) => ({ priority: p.rank, itemId: p.itemId, role: "contains" as const, what: `it is ${fi.verdict}, ${plural(fi.stillStuck.length, "agent")} still stuck` }));
    },
  },
  {
    id: "resolved",
    name: "Resolved",
    group: "health",
    component: "BriefResolved",
    ready: true,
    fits: ["M", "W", "W3", "S"],
    novel: true,
    measure(ctx) {
      const rec = [...(ctx.input.recovered ?? [])].sort(byId);
      if (!rec.length) return null;
      const value: 2 | 3 = ctx.dayType === "post-incident" ? 3 : 2;
      const fact = rec.length === 1 ? `one thing recovered since yesterday: ${rec[0]!.title}` : `${plural(rec.length, "thing")} recovered since yesterday`;
      return { n: rec.length, value, items: rec.map((r) => r.id), hash: sortedKey(rec.map((r) => r.id)), fact };
    },
    serves: () => [],
    dayBonus: (ctx) => (ctx.dayType === "post-incident" ? 15 : 0),
  },
  {
    id: "risk",
    name: "Watch",
    group: "health",
    component: "BriefRisk",
    ready: true,
    fits: ["S", "W", "W3", "M"],
    novel: true,
    measure(ctx) {
      const ws = ctx.watches;
      if (!ws.length) return null;
      const red = ws.filter((w) => w.ci).length;
      return {
        n: ws.length,
        value: value3(ws.length, 2, 4),
        items: sortedIds(ws),
        hash: sortedKey(ws.map((w) => w.id)),
        fact: `${plural(ws.length, "thing")} ${ws.length === 1 ? "is" : "are"} worth watching${red ? `, ${red} red on main` : ""}`,
      };
    },
    serves: () => [],
  },
  {
    id: "waiting",
    name: "Waiting on",
    group: "waiting",
    component: "BriefWaiting",
    ready: true,
    fits: ["S", "W", "W3", "M"],
    novel: false,
    measure(ctx) {
      const ws = ctx.input.waitingOn;
      if (!ws.length) return null;
      const old = ws.filter((w) => (w.ageHours ?? 0) > 24).length;
      const value: 1 | 2 | 3 = old ? 3 : ws.length >= 2 ? 2 : 1;
      return {
        n: ws.length,
        value,
        items: sortedIds(ws),
        hash: sortedKey(ws.map((w) => w.id)),
        fact: `you are waiting on ${names([...ws].sort(byId).map((w) => w.who))}${old ? `, ${old} over a day` : ""}`,
      };
    },
    serves(ctx) {
      const out: Serve[] = [];
      for (const p of ctx.priorities) {
        const text = `${p.text} ${p.because ?? ""}`.toLowerCase();
        const w = [...ctx.input.waitingOn].sort(byId).find((x) => x.who.trim() && text.includes(x.who.trim().toLowerCase()));
        if (w) out.push({ priority: p.rank, itemId: p.itemId, role: "mentions", what: `you are waiting on ${w.who} ${w.what}` });
      }
      return out;
    },
  },
  {
    id: "carry",
    name: "Carried over",
    group: "waiting",
    component: "BriefCarry",
    ready: true,
    fits: ["W", "W3", "S", "M"],
    novel: false,
    measure(ctx) {
      const rows = ctx.input.carry ?? [];
      if (!rows.length) return null;
      const present = new Set([...ctx.input.decisions.map((d) => d.id), ...ctx.incidents.map((r) => r.id)]);
      const orphans = rows.filter((c) => !c.itemId || !present.has(c.itemId));
      if (!orphans.length) return null;
      const items = [...new Set(orphans.flatMap((c) => (c.itemId ? [c.id, c.itemId] : [c.id])))].sort();
      const longest = Math.max(...orphans.map((c) => c.briefs));
      return {
        n: orphans.length,
        value: orphans.length >= 3 ? 3 : 2,
        items,
        hash: sortedKey(items),
        fact: `${plural(orphans.length, "thing")} carried from earlier briefs with no card today${longest > 1 ? `, one for ${longest} briefs running` : ""}`,
      };
    },
    serves(ctx, ev) {
      return ctx.priorities
        .filter((p) => p.itemId && ev.items.includes(p.itemId))
        .map((p) => ({ priority: p.rank, itemId: p.itemId, role: "contains" as const, what: "it has been carried from an earlier brief" }));
    },
    dayBonus: (ctx) => (ctx.dayType === "catch-up" ? 10 : ctx.dayType === "monday" ? 5 : 0),
  },
  {
    id: "handoffs",
    name: "Ownership moved",
    group: "waiting",
    component: "BriefHandoffs",
    ready: true,
    fits: ["W", "W3", "M", "S"],
    novel: false,
    measure(ctx) {
      const stale = (ctx.input.handoffs ?? []).filter((h) => {
        const since = Date.parse(h.since);
        const missing = Object.values(h.receipts).some((v) => v !== true);
        return missing && Number.isFinite(since) && ctx.nowMs - since > 4 * HOUR_MS;
      });
      if (!stale.length) return null;
      const prod = stale.some((h) => h.me && h.production);
      return {
        n: stale.length,
        value: prod ? 3 : 2,
        items: sortedIds(stale),
        hash: sortedKey(stale.map((h) => h.id)),
        fact: `${plural(stale.length, "handoff")} without a receipt after 4 hours${prod ? ", one in production" : ""}`,
      };
    },
    serves(ctx, ev) {
      return ctx.priorities
        .filter((p) => p.itemId && ev.items.includes(p.itemId))
        .map((p) => ({ priority: p.rank, itemId: p.itemId, role: "contains" as const, what: "its receipt is still missing" }));
    },
  },
  {
    id: "shipped",
    name: "Shipped",
    group: "momentum",
    component: "BriefShipped",
    ready: true,
    fits: ["L", "M", "W3", "W"],
    novel: true,
    measure(ctx) {
      const rows = ctx.input.shipped;
      const merged = ctx.input.merged ?? rows.reduce((n, s) => n + s.lines.length, 0);
      if (!rows.length && merged === 0) return null;
      const products = new Set(rows.map((s) => productOf(s.origin))).size;
      const firsts = rows.filter((s) => s.first).length;
      const value: 1 | 2 | 3 = merged >= 10 || firsts > 0 ? 3 : merged >= 3 || products >= 2 ? 2 : 1;
      const across = products ? ` across ${plural(products, "product")}` : "";
      const first = firsts ? `, ${firsts === 1 ? "one of them a first" : `${firsts} of them firsts`}` : "";
      return {
        n: merged,
        value,
        items: [],
        hash: `${sortedKey(rows.map((s) => s.id))}|${merged}`,
        fact: `you merged ${plural(merged, "change")}${across} yesterday${first}`,
      };
    },
    serves: () => [],
    dayBonus: (ctx) => (ctx.dayType === "friday" ? 5 : 0),
  },
  {
    id: "firsts",
    name: "Firsts",
    group: "momentum",
    component: "BriefFirsts",
    ready: true,
    fits: ["W", "W3", "S"],
    novel: true,
    measure(ctx) {
      const firsts = ctx.input.shipped.filter((s) => s.first);
      if (!firsts.length) return null;
      return {
        n: firsts.length,
        value: firsts.length >= 2 ? 2 : 1,
        items: [],
        hash: sortedKey(firsts.map((s) => s.id)),
        fact: firsts.length === 1 ? "a first shipped yesterday" : `${firsts.length} firsts shipped yesterday`,
      };
    },
    serves: () => [],
  },
  {
    id: "releaseTrain",
    name: "Release train",
    group: "momentum",
    component: "BriefReleaseTrain",
    ready: true,
    fits: ["W3", "W", "M"],
    novel: true,
    measure(ctx) {
      const due = (ctx.input.releases ?? []).filter((r) => {
        const at = r.releasedAt ? Date.parse(r.releasedAt) : NaN;
        return r.pendingCount >= 3 || r.held.length > 0 || (Number.isFinite(at) && ctx.nowMs - at > DAY_MS);
      });
      if (!due.length) return null;
      const r = due[0]!;
      const held = r.held.length;
      return {
        n: r.pendingCount,
        value: due.some((x) => x.light === "red") ? 3 : 2,
        items: [],
        hash: due.map((x) => `${x.product}|${x.pendingCount}|${x.held.length}`).sort().join("|"),
        fact: `${plural(r.pendingCount, "change")} wait on a ${r.product} release${held ? `, ${held} held` : ""}`,
      };
    },
    serves(ctx, ev) {
      return ctx.priorities
        .filter((p) => priorityDecision(ctx, p)?.action === "cut")
        .map((p) => ({ priority: p.rank, itemId: p.itemId, role: "elaborates" as const, what: `${plural(ev.n, "change")} ship when you cut it` }));
    },
  },
  {
    id: "meetings",
    name: "Yesterday",
    group: "momentum",
    component: "BriefMeetings",
    ready: true,
    fits: ["M", "W3", "W", "S"],
    novel: true,
    measure(ctx) {
      const ms = meetingsInWindow(ctx);
      if (!ms.length) return null;
      const decided = decidedLines(ms);
      const mine = ms.reduce((n, m) => n + (m.todo ?? []).filter((t) => t.mine).length, 0);
      const value: 1 | 2 | 3 = mine ? 3 : ms.length >= 3 || decided ? 2 : 1;
      return {
        n: ms.length,
        value,
        items: [],
        hash: sortedKey(ms.map((m) => m.id)),
        fact: `${plural(ms.length, "meeting")} since yesterday${decided ? `, ${plural(decided, "decision")} made` : ""}${mine ? `, ${plural(mine, "to-do")} yours` : ""}`,
      };
    },
    serves(ctx) {
      const ms = meetingsInWindow(ctx);
      const out: Serve[] = [];
      for (const p of ctx.priorities) {
        const d = priorityDecision(ctx, p);
        if (!d) continue;
        const m = ms.find((x) => decisionFromMeeting(d, x));
        if (m) out.push({ priority: p.rank, itemId: p.itemId, role: "mentions", what: `it came out of ${m.title}` });
      }
      return out;
    },
    dayBonus: (ctx) => (ctx.dayType === "catch-up" ? 5 : 0),
  },
  {
    id: "decided",
    name: "What got settled",
    group: "momentum",
    component: "BriefDecided",
    ready: true,
    fits: ["W", "W3", "S", "M"],
    novel: true,
    measure(ctx) {
      const ms = meetingsInWindow(ctx);
      const lines = decidedLines(ms);
      if (lines < 3) return null;
      const with_ = ms.filter((m) => m.decided?.length).length;
      return {
        n: lines,
        value: 2,
        items: [],
        hash: sortedKey(ms.flatMap((m) => m.decided ?? [])),
        fact: `${plural(lines, "decision")} settled across ${plural(with_, "meeting")} since yesterday`,
      };
    },
    serves: () => [],
  },
  {
    id: "weekArc",
    name: "Your week",
    group: "momentum",
    component: "BriefWeekArc",
    ready: true,
    fits: ["M", "W", "W3"],
    novel: true,
    measure(ctx) {
      const days = ctx.input.days ?? [];
      if (days.length < 3) return null;
      const beats = days.filter((d) => d.beat).length;
      const sessions = days.reduce((n, d) => n + d.sessions, 0);
      return {
        n: days.length,
        value: beats >= 2 ? 3 : beats === 1 ? 2 : 1,
        items: [],
        hash: days.map((d) => `${d.date}:${d.beat?.label ?? ""}`).join("|"),
        fact: `${plural(days.length, "day")} of work, ${plural(beats, "turning point")}${sessions ? `, ${plural(sessions, "session")}` : ""}`,
      };
    },
    serves: () => [],
    dayBonus(ctx) {
      if (ctx.dayType === "catch-up") return 15;
      if (ctx.dayType === "monday") return 10;
      if (ctx.dayType === "friday" && (ctx.input.days ?? []).filter((d) => d.beat).length >= 2) return 10;
      return 0;
    },
  },
  {
    id: "team",
    name: "Team",
    group: "people",
    component: "BriefTeam",
    ready: true,
    fits: ["M", "W3", "W"],
    novel: true,
    measure(ctx) {
      const team = ctx.input.team;
      if (!team.length) return null;
      const needing = team.filter((t) => t.tone === "decision").sort((a, b) => a.name.localeCompare(b.name) || byId(a, b));
      if (!needing.length && team.length < 2) return null;
      const value: 1 | 2 | 3 = needing.length >= 3 ? 3 : needing.length >= 1 ? 2 : 1;
      const fact = needing.length
        ? `${names(needing.map((t) => t.name))} ${needing.length === 1 ? "is" : "are"} waiting on you`
        : `${plural(team.length, "teammate")} active, nobody waiting on you`;
      return { n: team.length, value, items: [], hash: sortedKey(team.map((t) => `${t.id}:${t.tone}`)), fact };
    },
    serves(ctx) {
      const out: Serve[] = [];
      for (const p of ctx.priorities) {
        const d = priorityDecision(ctx, p);
        const text = `${p.text} ${p.because ?? ""} ${(d?.blocks ?? []).map((b) => b.who).join(" ")}`.toLowerCase();
        const named = ctx.input.team
          .filter((t) => t.name.trim() && new RegExp(`\\b${t.name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text))
          .sort((a, b) => a.name.localeCompare(b.name) || byId(a, b));
        if (named.length) {
          out.push({
            priority: p.rank,
            itemId: p.itemId,
            role: "mentions",
            what: `${names(named.map((t) => t.name))} ${named.length === 1 ? "is" : "are"} waiting on you`,
          });
        }
      }
      return out;
    },
    dayBonus: (ctx) => (ctx.dayType === "friday" && ctx.input.team.some((t) => t.thanks) ? 3 : 0),
  },
  {
    id: "agenda",
    name: "Today",
    group: "self",
    component: "BriefAgenda",
    ready: true,
    fits: ["M", "W3", "W", "S"],
    novel: false,
    measure(ctx) {
      const events = timedEvents(ctx.input.calendarToday);
      if (!events.length) return null;
      const ext = events.filter((e) => e.kind === "ext").length;
      return {
        n: events.length,
        value: events.length >= 3 ? 2 : 1,
        items: [],
        hash: sortedKey(events.map((e) => e.id)),
        fact: `${plural(events.length, "call")} today${ext ? `, ${ext} with people outside` : ""}`,
      };
    },
    serves: () => [],
  },
  {
    id: "runway",
    name: "Focus time",
    group: "self",
    component: "BriefRunway",
    ready: true,
    fits: ["W3", "W", "M"],
    novel: false,
    measure(ctx) {
      if (ctx.dayType === "weekend" || ctx.dayType === "catch-up") return null;
      if (!timedEvents(ctx.input.calendarToday).length || !ctx.priorities.length) return null;
      const gap = longestGap(ctx);
      return {
        n: gap ? Math.round(gap.minutes) : 0,
        value: gap && gap.minutes >= 90 ? 3 : 2,
        items: [],
        hash: sortedKey(ctx.input.calendarToday.map((e) => e.id)),
        fact: gap ? gapText(gap) : "no clear stretch between today's calls",
      };
    },
    serves(ctx) {
      const p1 = ctx.priorities[0];
      if (!p1) return [];
      const gap = longestGap(ctx);
      return [{ priority: 1, itemId: p1.itemId, role: "elaborates", what: gap ? `${gapText(gap)} fits it` : "it needs a clear stretch the day does not have" }];
    },
  },
  {
    id: "focus",
    name: "Where your day went",
    group: "self",
    component: "BriefFocus",
    ready: true,
    fits: ["M", "W"],
    novel: true,
    measure(ctx) {
      if (ctx.dayType === "catch-up") return null;
      const sessions = ctx.ownSessions;
      const products = sessionProducts(sessions);
      if (sessions.length < 3 || products.length < 2) return null;
      const value: 1 | 2 | 3 = products.length >= 4 || sessions.length >= 10 ? 3 : products.length === 3 ? 2 : 1;
      return {
        n: sessions.length,
        value,
        items: [],
        hash: `${products.join("|")}|${sessions.length}`,
        fact: `${plural(sessions.length, "session")} across ${plural(products.length, "product")} since yesterday`,
      };
    },
    serves: () => [],
  },
  {
    id: "reminders",
    name: "You asked to be reminded",
    group: "self",
    component: "BriefReminders",
    ready: true,
    fits: ["W", "W3", "S"],
    novel: false,
    measure(ctx) {
      const due = (ctx.input.reminders ?? []).filter((r) => {
        const t = r.dueAt ? Date.parse(r.dueAt) : NaN;
        return Number.isFinite(t) && t <= ctx.nowMs + 2 * DAY_MS;
      });
      if (!due.length) return null;
      const soon = due.filter((r) => Date.parse(r.dueAt!) <= ctx.nowMs + DAY_MS).length;
      return {
        n: due.length,
        value: soon ? 2 : 1,
        items: [],
        hash: sortedKey(due.map((r) => r.id)),
        fact: `${plural(due.length, "reminder")} in your own words${soon ? `, ${soon} due today` : ""}`,
      };
    },
    serves: () => [],
  },
];

const ENTRY: ReadonlyMap<BriefWidgetKind, WidgetEntry> = new Map(CATALOGUE.map((e) => [e.id, e]));
export const entryOf = (kind: BriefWidgetKind): WidgetEntry => ENTRY.get(kind)!;

// ---------------------------------------------------------------------------
// Scoring, tiers, density (all integers)
// ---------------------------------------------------------------------------

export type Tier = 1 | 2 | 3;
export type PickWhy = { kind: "pinned" } | { kind: "priority"; serve: Serve } | { kind: "value" } | { kind: "day" } | { kind: "pref" };
export interface Scored {
  kind: BriefWidgetKind;
  entry: WidgetEntry;
  ev: Evidence;
  serves: Serve[];
  tier: Tier;
  score: number;
  idx: number;
  parts: { value: number; priority: number; day: number; pref: number; rotation: number };
  why: PickWhy;
}
export interface Dropped {
  kind: BriefWidgetKind | `priority-${number}`;
  why: string;
}

export function priorityPoints(serves: readonly Serve[]): number {
  let pts = 0;
  for (const s of serves) if (s.role !== "contains") pts += RANK_W(s.priority) * (s.role === "elaborates" ? WEIGHTS.elaborates : WEIGHTS.mentions);
  return Math.min(WEIGHTS.priorityCap, pts);
}

const ROLE_ORDER = { contains: 0, elaborates: 1, mentions: 2 } as const;
const bestServe = (serves: readonly Serve[]): Serve | null =>
  [...serves].sort((a, b) => a.priority - b.priority || ROLE_ORDER[a.role] - ROLE_ORDER[b.role])[0] ?? null;

/** Score an entry whose evidence passed the gates (also used for not-ready entries in review mode). */
function scoreWith(entry: WidgetEntry, ctx: BriefContext, ev: Evidence, hero: boolean, serves: Serve[]): Scored {
  const idx = CATALOGUE.indexOf(entry);
  const pinned = ctx.prefs.pinned.includes(entry.id);
  const tier: Tier = hero ? 1 : serves.some((s) => s.role === "contains") || pinned ? 2 : 3;
  const w = Math.max(-2, Math.min(2, ctx.prefs.weights[entry.id] ?? 0));
  const rotation = tier === 3 && entry.novel && ctx.previous?.hashes[entry.id] === ev.hash ? WEIGHTS.rotation : 0;
  const parts = { value: ev.value * WEIGHTS.value, priority: priorityPoints(serves), day: entry.dayBonus?.(ctx, ev) ?? 0, pref: w * WEIGHTS.pref, rotation };
  const score = parts.value + parts.priority + parts.day + parts.pref - parts.rotation;
  const serve = bestServe(serves);
  const why: PickWhy = hero ? { kind: "pinned" } : serve ? { kind: "priority", serve } : pinned ? { kind: "pref" } : parts.day > 0 ? { kind: "day" } : { kind: "value" };
  return { kind: entry.id, entry, ev, serves, tier, score, idx, parts, why };
}

export function scoreEntry(entry: WidgetEntry, ctx: BriefContext, dropped: Dropped[]): Scored | null {
  const hero = entry.hero?.(ctx) ?? false;
  if (!hero && ctx.prefs.hidden.includes(entry.id)) {
    dropped.push({ kind: entry.id, why: "hidden by you" });
    return null;
  }
  const ev = entry.measure(ctx);
  if (!ev) return null; // no data or gated: review mode lists it as "no data"
  if (!entry.ready) {
    dropped.push({ kind: entry.id, why: `no card yet; it would say: ${ev.fact}` });
    return null;
  }
  if (ev.value < 1 && !hero) {
    dropped.push({ kind: entry.id, why: `too little behind it (${ev.fact})` });
    return null;
  }
  const serves = hero ? [] : entry.serves(ctx, ev);
  const pinned = ctx.prefs.pinned.includes(entry.id);
  if (!hero && ctx.dayType === "weekend" && ev.value < WEIGHTS.weekendMinValue && !serves.length && !pinned) {
    dropped.push({ kind: entry.id, why: "a weekend filler; it comes back Monday" });
    return null;
  }
  return scoreWith(entry, ctx, ev, hero, serves);
}

/** Not-ready entries with evidence, scored as if built, for review mode. */
export function notReadyScored(ctx: BriefContext): Scored[] {
  const out: Scored[] = [];
  for (const entry of CATALOGUE) {
    if (entry.ready) continue;
    const ev = entry.measure(ctx);
    if (!ev) continue;
    out.push(scoreWith(entry, ctx, ev, false, entry.serves(ctx, ev)));
  }
  return out;
}

/** Total order: tier; inside tier 2 the best contained rank; then score, value, registry index. */
export function rank(a: Scored, b: Scored): number {
  const best = (s: Scored) => Math.min(6, ...s.serves.filter((x) => x.role === "contains").map((x) => x.priority));
  return a.tier - b.tier || (a.tier === 2 ? best(a) - best(b) : 0) || b.score - a.score || b.ev.value - a.ev.value || a.idx - b.idx;
}

export function eligible(ctx: BriefContext, dropped: Dropped[]): Scored[] {
  return CATALOGUE.map((e) => scoreEntry(e, ctx, dropped))
    .filter((x): x is Scored => !!x)
    .sort(rank);
}

/** 1 + every strong widget (tier 2, or tier 3 with value >= 2); value-1 cards only top up to MIN_DENSITY; never above the cap or the pool. */
export function density(ctx: BriefContext, pool: readonly Scored[]): number {
  const cap = ctx.dayType === "catch-up" ? CATCH_UP_DENSITY : ctx.prefs.density === "calm" ? 5 : MAX_DENSITY;
  const strong = pool.filter((p) => p.tier === 2 || (p.tier === 3 && p.ev.value >= 2)).length;
  const calm = pool.filter((p) => p.tier === 3 && p.ev.value < 2).length;
  const n = 1 + strong + Math.min(calm, Math.max(0, MIN_DENSITY - 1 - strong));
  return Math.max(1, Math.min(cap, n, pool.length));
}

// ---------------------------------------------------------------------------
// Templates, fits, overlap pairs
// ---------------------------------------------------------------------------

export interface Template {
  areas: string[];
  cls: Record<string, BriefSlotSize>;
}

// Slot a is the hero's; slots are listed biggest first. No full-height single
// columns: short cards take 1x1 squares so they never stretch into dead space.
export const TEMPLATES: Record<string, Template> = {
  "1": { areas: ["a a a a a a", "a a a a a a"], cls: { a: "XL" } }, // quiet: hero alone, no holes (flagged for Corey's glance)
  "2": { areas: ["a a a b b b", "a a a b b b"], cls: { a: "L", b: "L" } }, // quiet (flagged)
  "3": { areas: ["a a a b b b", "a a a b b b", "a a a c c c"], cls: { a: "XL", b: "L", c: "W3" } }, // quiet (flagged)
  "4": { areas: ["a a a b b b", "a a a b b b", "a a a c c d"], cls: { a: "XL", b: "L", c: "W", d: "S" } },
  "5": { areas: ["a a a b b c", "a a a b b d", "a a a e e e"], cls: { a: "XL", b: "M", c: "S", d: "S", e: "W3" } },
  "6A": { areas: ["a a b b c d", "a a b b e f"], cls: { a: "M", b: "M", c: "S", d: "S", e: "S", f: "S" } },
  "6B": { areas: ["a a a b b c", "a a a b b d", "e e e f f f"], cls: { a: "L", b: "M", c: "S", d: "S", e: "W3", f: "W3" } },
  "7": { areas: ["a a a b b c", "a a a b b d", "e e f f g g"], cls: { a: "L", b: "M", c: "S", d: "S", e: "W", f: "W", g: "W" } },
  "8": { areas: ["a a b b c d", "a a b b e f", "g g g h h h"], cls: { a: "M", b: "M", c: "S", d: "S", e: "S", f: "S", g: "W3", h: "W3" } },
};
export const VARIANTS: Record<number, string[]> = { 1: ["1"], 2: ["2"], 3: ["3"], 4: ["4"], 5: ["5"], 6: ["6A", "6B"], 7: ["7"], 8: ["8"] };
/** false: n < 4 falls back to template 4 with holes (the older behaviour) while Corey decides. */
export const QUIET_TEMPLATES = true;
/** An M card in a 3x2 slot and a W card in a 3x1 slot are only wider. */
export const WIDEN: Partial<Record<BriefSlotSize, BriefSlotSize>> = { L: "M", W3: "W" };
export const fitsSlot = (e: WidgetEntry, size: BriefSlotSize): boolean => e.fits.includes(size) || (WIDEN[size] != null && e.fits.includes(WIDEN[size]!));

/** Span of a slot in a template: columns and rows. */
export function spanOf(tpl: Template, slot: string): { cols: number; rows: number } {
  let x0 = 9;
  let x1 = -1;
  let y0 = 9;
  let y1 = -1;
  tpl.areas.forEach((row, y) =>
    row.split(" ").forEach((cell, x) => {
      if (cell !== slot) return;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }),
  );
  return { cols: x1 - x0 + 1, rows: y1 - y0 + 1 };
}

/** Canonical span per size class, read from the templates (6A..8 first so XL reads 3x3, not template 1's 6x2). */
export const SPAN: Record<BriefSlotSize, [number, number]> = (() => {
  const out: Partial<Record<BriefSlotSize, [number, number]>> = {};
  for (const name of ["4", "5", "6A", "6B", "7", "8", "1", "2", "3"]) {
    const tpl = TEMPLATES[name]!;
    for (const [slot, size] of Object.entries(tpl.cls)) {
      if (out[size]) continue;
      const { cols, rows } = spanOf(tpl, slot);
      out[size] = [cols, rows];
    }
  }
  return out as Record<BriefSlotSize, [number, number]>;
})();

export interface Placed {
  kind: BriefWidgetKind;
  rows: number;
  size: BriefSlotSize;
}

export interface PairRule {
  pair: [BriefWidgetKind, BriefWidgetKind];
  /** `placed` is null at admission (rows unknown): row conditions are deferred to assignSlots. */
  coexist(ctx: BriefContext, placed: readonly Placed[] | null): boolean;
  /**
   * Skip sentence for the later-ranked one. A string names the card that stays
   * either way (the kept card is always on the grid, or the sentence names
   * neither); a map is keyed by the kind that stays, so the sentence never
   * names a card that is not shown.
   */
  skip: string | Partial<Record<BriefWidgetKind, string>>;
}

const placedOf = (placed: readonly Placed[] | null, kind: BriefWidgetKind) => placed?.find((p) => p.kind === kind) ?? null;

/** The rule's skip sentence when `kept` is the card that stays on the grid. */
export function skipFor(rule: PairRule, kept: BriefWidgetKind): string {
  if (typeof rule.skip === "string") return rule.skip;
  return rule.skip[kept] ?? rule.skip[rule.pair[0]] ?? rule.skip[rule.pair[1]] ?? "it would repeat a card already on the grid";
}

export const PAIRS: readonly PairRule[] = [
  {
    pair: ["needs", "oneThing"],
    coexist: (ctx, placed) => ctx.dayType === "catch-up" || (placed ? placedOf(placed, "needs")?.rows === 1 : true),
    skip: "Needs you shows every call; the priorities list orders them",
  },
  {
    pair: ["needs", "blockedByMe"],
    coexist: (ctx, placed) => edgedDecisions(ctx).length >= 2 && (placed ? placedOf(placed, "needs")?.rows !== 1 : true),
    skip: "Needs you is in a one-row slot; this would repeat the same calls",
  },
  {
    pair: ["needs", "releaseTrain"],
    coexist: (ctx) => !ctx.input.decisions.some((d) => d.action === "cut" && d.source === "prs"),
    skip: "Cut the release is already a call in Needs you",
  },
  {
    pair: ["blockedByMe", "releaseTrain"],
    coexist: () => false,
    skip: { blockedByMe: "the unblock graph already shows the release", releaseTrain: "the Release train card already shows the release call" },
  },
  {
    pair: ["meetings", "decided"],
    coexist: (ctx) => {
      const ms = meetingsInWindow(ctx);
      return decidedLines(ms) >= 3 && ms.filter((m) => m.decided?.length).length >= 2;
    },
    skip: { meetings: "the Yesterday card already lists each meeting's decisions", decided: "What got settled already lists the decisions from yesterday's meetings" },
  },
  {
    pair: ["shipped", "firsts"],
    coexist: (ctx, placed) => ctx.input.shipped.filter((s) => s.first).length >= 2 || (placed ? placedOf(placed, "shipped")?.rows === 1 : true),
    skip: { shipped: "the shipped card already carries the FIRST badge", firsts: "the Firsts card already shows what shipped" },
  },
  {
    pair: ["agenda", "runway"],
    coexist: () => false,
    skip: { runway: "Focus time already shows today's calls and gaps", agenda: "the Today card already shows the agenda" },
  },
  {
    pair: ["sunrise", "focus"],
    coexist: (ctx, placed) => sessionProducts(ctx.ownSessions).length >= 3 || (placed ? placedOf(placed, "sunrise")?.size === "M" : true),
    skip: "the sunrise timeline already shows the sessions",
  },
  {
    pair: ["weekArc", "focus"],
    coexist: () => false,
    skip: { weekArc: "Your week covers where the days went", focus: "Where your day went already covers the last seven days" },
  },
  {
    pair: ["incident", "fleetRecovery"],
    coexist: (ctx) => ctx.incidents.length > 1,
    skip: { incident: "the incident card already shows the stuck agents", fleetRecovery: "Fleet recovery already shows the stuck agents" },
  },
  { pair: ["catchup", "incident"], coexist: () => false, skip: "shown in the Welcome back tiles" },
  { pair: ["catchup", "shipped"], coexist: () => false, skip: "shown in the Welcome back tiles" },
  { pair: ["catchup", "resolved"], coexist: () => false, skip: "shown in the Welcome back tiles" },
  { pair: ["catchup", "handoffs"], coexist: () => false, skip: "shown in the Welcome back tiles" },
];

export function pairRuleFor(a: BriefWidgetKind, b: BriefWidgetKind): PairRule | null {
  return PAIRS.find((r) => (r.pair[0] === a && r.pair[1] === b) || (r.pair[0] === b && r.pair[1] === a)) ?? null;
}

/** The skip sentence for `b` when it may not share the grid with the kept `a`, else null. Both directions. */
export function pairClash(a: Scored, b: Scored, ctx: BriefContext, placed: readonly Placed[] | null): string | null {
  const rule = pairRuleFor(a.kind, b.kind);
  return rule && !rule.coexist(ctx, placed) ? skipFor(rule, a.kind) : null;
}

/** Every pair whose two kinds are placed must coexist with rows known. */
export function pairsHold(placed: readonly Placed[], ctx: BriefContext): boolean {
  for (const rule of PAIRS) {
    if (placedOf(placed, rule.pair[0]) && placedOf(placed, rule.pair[1]) && !rule.coexist(ctx, placed)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pick loop
// ---------------------------------------------------------------------------

/**
 * Assign picks to a template's slots: the hero takes slot a; every other pick
 * gets a free slot that fits, backtracking until the pairs hold with rows
 * known. Null when no assignment exists. With `ctx` null the pairs are not
 * checked (span tests).
 */
export function assignSlots(tpl: Template, picks: readonly Scored[], ctx: BriefContext | null): Map<string, Scored> | null {
  const slots = Object.keys(tpl.cls);
  const hero = picks[0];
  if (!hero || !fitsSlot(hero.entry, tpl.cls[slots[0]!]!)) return null;
  if (picks.length > slots.length) return null;
  const out = new Map<string, Scored>([[slots[0]!, hero]]);
  const placed = (): Placed[] => [...out].map(([slot, s]) => ({ kind: s.kind, rows: spanOf(tpl, slot).rows, size: tpl.cls[slot]! }));
  const go = (i: number): boolean => {
    if (i === picks.length) return ctx ? pairsHold(placed(), ctx) : true;
    for (const slot of slots) {
      if (out.has(slot) || !fitsSlot(picks[i]!.entry, tpl.cls[slot]!)) continue;
      out.set(slot, picks[i]!);
      if (go(i + 1)) return true;
      out.delete(slot);
    }
    return false;
  };
  return go(1) ? out : null;
}

export interface Picked {
  template: string;
  picks: Scored[];
  slots: Map<string, Scored>;
  skipped: Dropped[];
}

/** At the first index where the sorted rank-index vectors differ, the smaller wins; equal keeps the earlier. */
export function lexBetter(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

/** Fill a template's slots in order with the first pick that fits each; unfilled slots stay empty ('.' cells). */
function fillWithHoles(tpl: Template, picks: readonly Scored[]): Map<string, Scored> {
  const left = [...picks];
  const out = new Map<string, Scored>();
  for (const [slot, size] of Object.entries(tpl.cls)) {
    const i = left.findIndex((p) => fitsSlot(p.entry, size));
    if (i >= 0) out.set(slot, left.splice(i, 1)[0]!);
  }
  return out;
}

/** The older behaviour: template 4, holes allowed. Used only when QUIET_TEMPLATES is off. */
export function placeWithHoles(ctx: BriefContext, pool: readonly Scored[]): Picked {
  const tpl = TEMPLATES["4"]!;
  const picks: Scored[] = [];
  const skipped: Dropped[] = [];
  for (const c of pool) {
    if (picks.length === MIN_DENSITY) break;
    const clash = picks.map((p) => pairClash(p, c, ctx, null)).find(Boolean);
    if (clash) {
      skipped.push({ kind: c.kind, why: clash });
      continue;
    }
    picks.push(c);
  }
  const slots = fillWithHoles(tpl, picks);
  for (const p of picks) if (![...slots.values()].includes(p)) skipped.push({ kind: p.kind, why: `no slot fits it at ${MIN_DENSITY} widgets` });
  return { template: "4", picks: [...slots.values()], slots, skipped };
}

/** Greedy by rank with a feasibility check per candidate; variants of the same n compete; step down only when no variant fills. */
export function pick(ctx: BriefContext, pool: readonly Scored[]): Picked {
  const hero = pool[0];
  if (!hero) throw new Error("pick: the pool has no hero");
  // Variants compete on rank position (the pool is sorted by rank), never on registry index.
  const pos = new Map<Scored, number>(pool.map((s, i) => [s, i]));
  const key = (p: Picked) => p.picks.map((s) => pos.get(s) ?? pool.length).sort((a, b) => a - b);
  for (let n = density(ctx, pool); n >= 1; n -= 1) {
    const variants = (QUIET_TEMPLATES || n >= MIN_DENSITY ? VARIANTS[n] : []) ?? [];
    let best: Picked | null = null;
    for (const name of variants) {
      const tpl = TEMPLATES[name]!;
      const picks: Scored[] = [hero];
      const skipped: Dropped[] = [];
      for (const c of pool) {
        if (c === hero) continue;
        // A pair's own sentence explains a skip better than "no room", so it is checked first.
        const clash = picks.map((p) => pairClash(p, c, ctx, null)).find(Boolean);
        if (clash) {
          skipped.push({ kind: c.kind, why: clash });
          continue;
        }
        if (picks.length === n) {
          skipped.push({ kind: c.kind, why: `no room at ${plural(n, "widget")}` });
          continue;
        }
        if (!assignSlots(tpl, [...picks, c], ctx)) {
          // When the slots alone would take it, a pair's row condition is what failed, and that
          // pair's sentence explains it; when no layout fits even with pairs ignored, say so.
          const fitsSomewhere = assignSlots(tpl, [...picks, c], null) !== null;
          const kept = fitsSomewhere ? picks.find((p) => pairRuleFor(p.kind, c.kind)) : undefined;
          const rule = kept ? pairRuleFor(kept.kind, c.kind) : null;
          skipped.push({ kind: c.kind, why: rule && kept ? skipFor(rule, kept.kind) : `no slot fits it at ${plural(n, "widget")}` });
          continue;
        }
        picks.push(c);
      }
      if (picks.length !== n) continue;
      const cand: Picked = { template: name, picks, slots: assignSlots(tpl, picks, ctx)!, skipped };
      if (!best || lexBetter(key(cand), key(best))) best = cand;
    }
    if (best) return best;
  }
  if (!QUIET_TEMPLATES) return placeWithHoles(ctx, pool);
  throw new Error("unreachable: template 1 always fits the hero");
}

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

const DAY_LABEL: Partial<Record<DayType, string>> = {
  monday: "Monday",
  friday: "Friday",
  "catch-up": "your first day back",
  "post-incident": "the day after an incident",
};

/** One sentence per card, from fixed patterns, so one lint covers them all. */
export function reasonFor(entry: WidgetEntry, ev: Evidence, why: PickWhy, ctx: BriefContext): string {
  switch (why.kind) {
    case "pinned":
      return `Always first: ${ev.fact}.`;
    case "priority": {
      const r = why.serve.priority;
      const p = ctx.priorities[r - 1];
      return `Shown for priority ${r}, "${p?.text ?? ""}": ${why.serve.what}.`;
    }
    case "day":
      return `Shown because it is ${DAY_LABEL[ctx.dayType] ?? "today"}: ${ev.fact}.`;
    case "pref":
      return `Shown because you asked for it always; ${ev.fact}.`;
    default:
      return `Shown because ${ev.fact}.`;
  }
}

/**
 * Lint for a reason sentence: exactly one sentence, at most 160 characters,
 * no owner/repo slug, no #123 reference, no conventional-commit prefix, no
 * path. Returns what is wrong, or null when it passes.
 */
export function lintReason(reason: string): string | null {
  const r = reason.trim();
  if (!r) return "empty";
  if (r.length > 160) return `too long (${r.length} chars)`;
  if (!/[.!?]$/.test(r)) return "does not end a sentence";
  if (/[.!?]\s+[A-Z"]/.test(r.replace(/\.\.\./g, ""))) return "more than one sentence";
  if (/(^|\s)(\.{0,2}\/)?(src|packages|workspace|companies|core|personal)\/[\w./-]+/.test(r)) return "path";
  if (/[A-Za-z][\w.-]*\/[A-Za-z][\w.-]*/.test(r)) return "repo slug";
  if (/#\d+/.test(r)) return "PR or issue number";
  if (/\b(feat|fix|chore|docs|refactor|test|ci|build|perf|style)(\([^)]*\))?!?:/i.test(r)) return "conventional prefix";
  return null;
}

/** The header chip's reason: priority 1 leads, then the lead's own words. */
export function leadReason(ctx: BriefContext, reason: string): string {
  const p1 = ctx.priorities[0];
  return p1 ? `"${p1.text}" leads · ${reason}` : reason;
}

/** Needs rows: referenced by a priority first (by rank), then unblock weight, then age, then id. */
export function rankDecisions(ctx: BriefContext): BriefDecision[] {
  const rankOf = (d: BriefDecision) => ctx.priorities.find((p) => p.itemId === d.id)?.rank ?? 99;
  return [...ctx.input.decisions].sort(
    (a, b) => rankOf(a) - rankOf(b) || decisionWeight(b) - decisionWeight(a) || (b.ageHours ?? 0) - (a.ageHours ?? 0) || a.id.localeCompare(b.id),
  );
}

/** Each entry's content hash for a day, for rotation against the next run. Read-only. */
export function digest(input: BriefInput): Partial<Record<BriefWidgetKind, string>> {
  const ctx = buildContext(input);
  const out: Partial<Record<BriefWidgetKind, string>> = {};
  for (const entry of CATALOGUE) {
    const ev = entry.measure(ctx);
    if (ev) out[entry.id] = ev.hash;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Load-time assertions: the catalogue and the templates agree
// ---------------------------------------------------------------------------

/**
 * Every entry fits some template slot; every non-hero slot size has at least
 * three fitters; sunrise fits every hero slot; catchup fits the hero slot of
 * every template a catch-up day can reach (density up to CATCH_UP_DENSITY).
 */
export function checkCatalogue(): string[] {
  const problems: string[] = [];
  const sizes = new Set<BriefSlotSize>();
  for (const [name, tpl] of Object.entries(TEMPLATES)) {
    const slots = Object.keys(tpl.cls);
    if (slots.length !== new Set(tpl.areas.flatMap((r) => r.split(" "))).size) problems.push(`template ${name}: slots and areas disagree`);
    for (const row of tpl.areas) if (row.split(" ").length !== 6) problems.push(`template ${name}: a row is not 6 wide`);
    if (!fitsSlot(entryOf("sunrise"), tpl.cls[slots[0]!]!)) problems.push(`template ${name}: sunrise does not fit the hero slot`);
    if (slots.length <= CATCH_UP_DENSITY && !fitsSlot(entryOf("catchup"), tpl.cls[slots[0]!]!)) problems.push(`template ${name}: catchup does not fit the hero slot`);
    for (const slot of slots.slice(1)) sizes.add(tpl.cls[slot]!);
  }
  for (const size of sizes) {
    const fitters = CATALOGUE.filter((e) => fitsSlot(e, size)).length;
    if (fitters < 3) problems.push(`size ${size}: only ${fitters} fitters`);
  }
  const all = new Set(Object.values(TEMPLATES).flatMap((t) => Object.values(t.cls)));
  for (const e of CATALOGUE) if (!e.fits.some((s) => all.has(s))) problems.push(`${e.id}: fits no template slot`);
  const ids = new Set(CATALOGUE.map((e) => e.id));
  if (ids.size !== CATALOGUE.length) problems.push("duplicate entry ids");
  for (const r of PAIRS) for (const k of r.pair) if (!ids.has(k)) problems.push(`pair names unknown kind ${k}`);
  return problems;
}

{
  const problems = checkCatalogue();
  if (problems.length) throw new Error(`brief catalogue: ${problems.join("; ")}`);
}
