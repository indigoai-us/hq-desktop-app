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
  const nextAreas = areas.map((row) => row.split(/\s+/).map(swap).join(" "));
  const take = (w: BriefWidget, from: BriefWidget): BriefWidget => ({ ...w, size: from.size, cols: from.cols, rows: from.rows });
  const promoted = take(main, hero);
  const demoted = take(hero, main);
  const rest = widgets.filter((w) => w !== hero && w !== main);
  return { areas: nextAreas, widgets: [promoted, demoted, ...rest] };
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
 * done, periwinkle for your own day.
 */
export const FIELD: Record<string, "violet" | "dusk" | "pink" | "sunset" | "sky" | "teal" | "peri"> = {
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
  team: "sky",
  meetings: "sky",
  decided: "sky",
  shipped: "teal",
  firsts: "teal",
  resolved: "teal",
  weekArc: "teal",
  focus: "teal",
  agenda: "peri",
  runway: "peri",
};
