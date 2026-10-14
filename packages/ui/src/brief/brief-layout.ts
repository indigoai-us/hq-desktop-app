/**
 * Presentation-only layout rules on top of the generator's plan (design,
 * local). The generator keeps its hero-first templates; the page then makes
 * the priorities card (Needs you, which now carries Today's priorities) the
 * main card by giving it the hero's slot, and moves the sunrise into the
 * slot the priorities card had. Nothing here changes what is on the page,
 * only where.
 */
import type { BriefWidget } from "./brief-generate.js";

/** The card that holds the main slot, and the hero kinds it may take that slot from. */
const MAIN = "needs";
const YIELDING_HEROES = new Set(["sunrise"]);

const areaOf = (w: Pick<BriefWidget, "cols" | "rows">) => w.cols * w.rows;

/**
 * Swap the priorities card into the hero's slot when it is placed in a smaller
 * one. Returns new areas and widgets (the main card first); the inputs are
 * left alone. A catch-up hero keeps its slot: it already leads with the calls.
 */
export function promoteMain(areas: readonly string[], widgets: readonly BriefWidget[]): { areas: string[]; widgets: BriefWidget[] } {
  const hero = widgets[0];
  const main = widgets.find((w) => w.kind === MAIN);
  if (!hero || !main || hero === main || !YIELDING_HEROES.has(String(hero.kind)) || areaOf(main) >= areaOf(hero)) {
    return { areas: [...areas], widgets: [...widgets] };
  }
  const swap = (token: string) => (token === hero.kind ? main.kind : token === main.kind ? hero.kind : token);
  const swapped = areas.map((row) => row.split(/\s+/).map(swap));
  const take = (w: BriefWidget, from: BriefWidget): BriefWidget => ({ ...w, size: from.size, cols: from.cols, rows: from.rows });
  const promoted = take(main, hero);
  const demoted = take(hero, main);
  const rest = widgets.filter((w) => w !== hero && w !== main);
  // The sunrise reads first: when the two cards share the same rows side by side, the sunrise
  // moves to the left of the priorities card (each keeps its size).
  const sunriseFirst = leadWith(swapped, String(hero.kind), String(main.kind));
  return {
    areas: (sunriseFirst ?? swapped).map((r) => r.join(" ")),
    widgets: sunriseFirst ? [demoted, promoted, ...rest] : [promoted, demoted, ...rest],
  };
}

/**
 * Put `first`'s block left of `second`'s when, in every row either appears, the two
 * are adjacent runs with `second` on the left. Null when the shapes do not allow it
 * (different rows, not adjacent), so the grid never gets a broken area.
 */
function leadWith(rows: string[][], first: string, second: string): string[][] | null {
  const out: string[][] = [];
  let moved = false;
  for (const row of rows) {
    const hasA = row.includes(first);
    const hasB = row.includes(second);
    if (!hasA && !hasB) {
      out.push(row);
      continue;
    }
    if (hasA !== hasB) return null;
    const b0 = row.indexOf(second);
    const b1 = row.lastIndexOf(second);
    const a0 = row.indexOf(first);
    const a1 = row.lastIndexOf(first);
    if (a0 !== b1 + 1) return null;
    out.push([...row.slice(0, b0), ...row.slice(a0, a1 + 1), ...row.slice(b0, b1 + 1), ...row.slice(a1 + 1)]);
    moved = true;
  }
  return moved ? out : null;
}

/** The call in progress or the next one today, with minutes until it starts (0 while it runs). Busy holds are skipped. */
export function nextCall<E extends { start: string; end?: string | null; busy?: boolean }>(events: readonly E[], nowIso: string): { event: E; inMin: number; live: boolean } | null {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return null;
  const timed = events
    .filter((e) => !e.busy && Number.isFinite(Date.parse(e.start)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const e of timed) {
    const s = Date.parse(e.start);
    const end = e.end ? Date.parse(e.end) : s + 30 * 60_000;
    if (end <= now) continue;
    return { event: e, inMin: Math.max(0, Math.round((s - now) / 60_000)), live: s <= now };
  }
  return null;
}

/** "in 45 min", "in 2h 10m", "now". */
export function inLabel(min: number, live: boolean): string {
  if (live || min <= 0) return "now";
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

/**
 * The colour field a card wears (design, local; after the gradient bento
 * reference). Each kind keeps one field so a card is recognisable day to day:
 * violet for calls you make, dusk for the sunrise, hot pink for a live fire,
 * sunset for things to watch, sky for people and waiting, teal for what got
 * done. Background cards (your calls, your day, the week, the team, meetings,
 * what was settled) are monochrome: the page's own glass panel, so colour is
 * kept for what needs you, what is on fire and what you shipped.
 */
export const FIELD: Record<string, "violet" | "dusk" | "pink" | "sunset" | "sky" | "teal" | "peri" | "mono"> = {
  needs: "violet",
  oneThing: "violet",
  catchup: "dusk",
  sunrise: "dusk",
  incident: "pink",
  blockedByMe: "pink",
  risk: "sunset",
  releaseTrain: "sunset",
  fleetRecovery: "sunset",
  reminders: "sunset",
  waiting: "sky",
  carry: "sky",
  handoffs: "sky",
  team: "mono",
  meetings: "mono",
  decided: "mono",
  shipped: "teal",
  firsts: "teal",
  resolved: "teal",
  weekArc: "mono",
  focus: "mono",
  agenda: "mono",
  runway: "mono",
};

type Box = { left: number; right: number; top: number; bottom: number };

/**
 * Where a hover card goes, by one rule so every peek lands next to what you
 * are pointing at: beside the hovered thing's own content (its text, not the
 * full width of its row or panel), on the right when it fits, else on the
 * left, else kept inside the window. The top aligns with the hovered thing;
 * `peekTop` then keeps it on screen once its real height is known.
 */
export function placePeek(anchor: Box, view: { w: number; h: number }, width = 340, gap = 10): { x: number; anchorTop: number; side: "r" | "l" | "b" } {
  if (anchor.right + gap + width <= view.w - 8) return { x: anchor.right + gap, anchorTop: anchor.top, side: "r" };
  if (anchor.left - gap - width >= 8) return { x: anchor.left - gap - width, anchorTop: anchor.top, side: "l" };
  return { x: Math.max(8, Math.min(view.w - width - 8, anchor.right + gap)), anchorTop: anchor.top, side: "r" };
}

/**
 * Below the hovered thing, left edges aligned: for a row of neighbours (the
 * stats) where a peek on the side would cover the next one.
 */
export function placePeekBelow(anchor: Box, view: { w: number; h: number }, width = 340, gap = 14): { x: number; anchorTop: number; side: "b" } {
  return { x: Math.max(8, Math.min(view.w - width - 8, anchor.left)), anchorTop: anchor.bottom + gap + 6, side: "b" };
}

/** The box of what an element actually shows (its text and inline content), within the element; the element's own box when empty. */
export function contentBox(el: Element): Box {
  const own = el.getBoundingClientRect();
  if (typeof document === "undefined" || !document.createRange) return own;
  const r = document.createRange();
  r.selectNodeContents(el);
  // Decorations hung outside the element (the timeline's active-call arrow) do not count as content.
  const rects = [...r.getClientRects()].filter((c) => c.width && c.height && c.right > own.left && c.left < own.right);
  if (!rects.length) return own;
  const left = Math.min(...rects.map((c) => c.left));
  const right = Math.max(...rects.map((c) => c.right));
  return { left: Math.max(own.left, left), right: Math.min(own.right, right), top: own.top, bottom: own.bottom };
}

/** The peek's top: level with the hovered thing, moved up only as far as needed to stay 16px inside the window. */
export function peekTop(anchorTop: number, height: number, viewH: number): number {
  return Math.max(16, Math.min(anchorTop - 6, viewH - height - 16));
}

/** Who is on a call, in a few words: "with Lizzie", "with Jacob and Corey", "with Jacob, Corey +2". */
export function withLine(people: readonly string[]): string {
  const names = people.map((p) => p.trim()).filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return `with ${names[0]}`;
  if (names.length === 2) return `with ${names[0]} and ${names[1]}`;
  return `with ${names[0]}, ${names[1]} +${names.length - 2}`;
}

/** A clock time in the brief's short form: "2 PM", "2:30 PM". */
export function clockLabel(iso: string): string {
  const d = new Date(iso);
  const m = d.getMinutes();
  return `${d.getHours() % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${d.getHours() >= 12 ? "PM" : "AM"}`;
}

export type TodayStatKey = "decide" | "calls" | "dms" | "risks";
export interface TodayStat {
  key: TodayStatKey;
  label: string;
  n: number;
  caption: string;
}

/**
 * The counts under the greeting, all about today: what to decide, the calls on
 * the calendar, the DMs to read and the risks to watch. A count of zero is left
 * out rather than shown as an empty stat.
 */
export function todayStats(input: {
  now: string;
  decisions: readonly unknown[];
  calendarToday: readonly { start: string; end?: string | null; busy?: boolean }[];
  dmCount?: number | null;
  team: readonly { name: string; dmCount?: number }[];
  risks: readonly { severity: "incident" | "watch" }[];
  timeToClearMin?: number | null;
}): TodayStat[] {
  const calls = input.calendarToday.filter((e) => !e.busy);
  const next = nextCall(calls, input.now);
  const clear = input.timeToClearMin ?? 0;
  const topDm = [...input.team].filter((t) => t.dmCount).sort((a, b) => (b.dmCount ?? 0) - (a.dmCount ?? 0))[0];
  const live = input.risks.filter((r) => r.severity === "incident").length;
  const stats: TodayStat[] = [
    {
      key: "decide",
      label: "To decide",
      n: input.decisions.length,
      caption: clear > 0 ? `about ${clear < 60 ? `${clear} min` : `${Math.floor(clear / 60)}h${clear % 60 ? ` ${clear % 60}m` : ""}`} to clear` : "for today",
    },
    {
      key: "calls",
      label: "Calls",
      n: calls.length,
      caption: next ? (next.live ? "on one now" : `next at ${clockLabel(next.event.start)}`) : "all done",
    },
    { key: "dms", label: "DMs", n: input.dmCount ?? 0, caption: topDm ? `most from ${topDm.name}` : "to read" },
    { key: "risks", label: "Risks", n: input.risks.length, caption: live ? `${live} live incident${live === 1 ? "" : "s"}` : "to watch" },
  ];
  return stats.filter((s) => s.n > 0);
}
