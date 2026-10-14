/**
 * Carried over: what was open at the last brief and still has no follow-up
 * today, said as the owner reads it. Pure helpers for BriefCarry.svelte.
 *
 * `linked` mirrors the catalogue's carry.measure: a row continues into today
 * only when its itemId is a decision or a live incident present today, so the
 * card's headline count and the picker's evidence agree (a watch risk does not
 * count). No toLocale*, no Date.now: `nowMs` is an input; the day a row was
 * first seen comes from the run id it was carried from (brief-YYYYMMDD-HHMMSS,
 * local date) or, failing that, the date part of its carriedSince ISO.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { humanTitle } from "./brief-distill.js";
import type { BriefCarry, BriefDecision, BriefRisk, BriefTone } from "./brief-types.js";

/** Rows shown in a two-row slot before "+N more". */
export const CARRY_CAP = 5;
/** Rows shown in a one-row slot before "+N more". */
export const CARRY_CAP_SHORT = 3;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** An orphan older than this is cold (amber); older than DROPPED_HOURS is likely dropped (red). */
export const COLD_HOURS = 24;
export const DROPPED_HOURS = 48;
/** The micro-timeline under each row covers this many hours. */
export const THREAD_HOURS = 72;

/** Ring colour: white = under a day, warn = cold, red = likely dropped, grey = continued by a card today. */
export type RingTone = "white" | "warn" | "red" | "grey";

export interface CarryRow {
  carry: BriefCarry;
  /** Plain title: no repo, PR number or commit prefix. */
  title: string;
  /** Today's decision or live incident that continues it, when present. */
  linked: BriefDecision | BriefRisk | null;
  /** Hours since it was first carried; null when carriedSince is unknown. */
  ageHours: number | null;
  tone: RingTone;
  /** Launch id: the linked item's (so clearing it clears it everywhere) or the row's own. */
  launchId: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GUARD =
  "Read what you need first. Stop and confirm with me before any irreversible step (merge, release, publish, deploy, or sending a message).";

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The local day a row was first seen, YYYY-MM-DD: from the run id it was
 * carried from ("brief-20261010-142540" -> "2026-10-10"), else the date part
 * of carriedSince, else null.
 */
export function carryDay(c: Pick<BriefCarry, "carriedFrom" | "carriedSince">): string | null {
  const run = /^brief-(\d{4})(\d{2})(\d{2})-\d{6}$/.exec((c.carriedFrom ?? "").trim());
  if (run) return `${run[1]}-${run[2]}-${run[3]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec((c.carriedSince ?? "").trim());
  return iso ? iso[1]! : null;
}

/** Day number of a YYYY-MM-DD; null when it is not a date. */
function dayIndex(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/** "Fri" for a YYYY-MM-DD, by arithmetic (1970-01-01 was a Thursday). */
export function dayShort(day: string): string {
  const idx = dayIndex(day);
  return idx == null ? "" : WEEKDAYS[(((idx + 4) % 7) + 7) % 7]!;
}

/** "Oct 10" for a YYYY-MM-DD. */
export function monthDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return "";
  return `${MONTHS[Number(m[2]) - 1] ?? ""} ${Number(m[3])}`;
}

/** "brief of Oct 10", or "an earlier brief" when the row does not say. */
export function firstSeenLabel(c: Pick<BriefCarry, "carriedFrom" | "carriedSince">): string {
  const day = carryDay(c);
  return day ? `brief of ${monthDay(day)}` : "an earlier brief";
}

/** Hours since the row was first carried; null when carriedSince is missing or unreadable. */
export function carryAge(c: Pick<BriefCarry, "carriedSince">, nowMs: number): number | null {
  if (!c.carriedSince) return null;
  const t = Date.parse(c.carriedSince);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, (nowMs - t) / HOUR_MS);
}

/**
 * Ring colour by age: grey when a card today continues it; else white under a
 * day, warn past a day, red past two. With no carriedSince the brief count
 * stands in (one brief a day).
 */
export function ringTone(linked: boolean, ageHours: number | null, briefs: number): RingTone {
  if (linked) return "grey";
  if (ageHours != null) return ageHours > DROPPED_HOURS ? "red" : ageHours > COLD_HOURS ? "warn" : "white";
  return briefs >= 3 ? "red" : briefs === 2 ? "warn" : "white";
}

/** The decision or live incident a row's itemId points at today; a watch risk does not count (same rule as the picker). */
export function linkedItem(c: Pick<BriefCarry, "itemId">, decisions: readonly BriefDecision[], risks: readonly BriefRisk[]): BriefDecision | BriefRisk | null {
  if (!c.itemId) return null;
  return decisions.find((d) => d.id === c.itemId) ?? risks.find((r) => r.id === c.itemId && r.severity === "incident") ?? null;
}

const byAge = (a: CarryRow, b: CarryRow): number =>
  (b.ageHours ?? -1) - (a.ageHours ?? -1) || b.carry.briefs - a.carry.briefs || a.carry.id.localeCompare(b.carry.id);

/**
 * Rows for the card: orphans first, coldest first; rows a card today
 * continues come last and render grey. Stable for equal ages (brief count,
 * then id).
 */
export function carryRows(carry: readonly BriefCarry[] | undefined, decisions: readonly BriefDecision[], risks: readonly BriefRisk[], nowMs: number): CarryRow[] {
  const rows = (carry ?? []).map((c): CarryRow => {
    const linked = linkedItem(c, decisions, risks);
    const ageHours = carryAge(c, nowMs);
    return {
      carry: c,
      title: humanTitle(c.title).text,
      linked,
      ageHours,
      tone: ringTone(!!linked, ageHours, c.briefs),
      launchId: linked?.id ?? c.id,
    };
  });
  return [...rows.filter((r) => !r.linked).sort(byAge), ...rows.filter((r) => r.linked).sort(byAge)];
}

export const orphanRows = (rows: readonly CarryRow[]): CarryRow[] => rows.filter((r) => !r.linked);

/** The h3: "One promise has no follow-up yet", "3 things carried over"; every row linked reads as such (the picker hides that day). */
export function carryHeadline(orphans: number): string {
  if (orphans <= 0) return "Everything carried has a card today";
  if (orphans === 1) return "One promise has no follow-up yet";
  return `${orphans} things carried over`;
}

/**
 * The mono tag at the right of a row: "2 briefs" when it has run more than
 * one, else "since Fri" (or "since Oct 3" past a week). On a catch-up day
 * every row shows the day it was first seen ("Oct 10") so the owner can
 * place it in the time away.
 */
export function carryTag(row: CarryRow, catchUp = false): string {
  const day = carryDay(row.carry);
  if (catchUp && day) return monthDay(day);
  if (row.carry.briefs >= 2) return `${row.carry.briefs} briefs`;
  if (!day) return "1 brief";
  return row.ageHours != null && row.ageHours > 6 * 24 ? `since ${monthDay(day)}` : `since ${dayShort(day)}`;
}

/** Status line in the peek: "Cold · 30h", "Likely dropped · 50h", "Open · 12h", or the card that continues it. */
export function ageLabel(row: CarryRow): string {
  if (row.linked) return "Has a card today";
  if (row.ageHours == null) return `Carried ${plural(row.carry.briefs, "brief")}`;
  const h = Math.round(row.ageHours);
  const word = row.ageHours > DROPPED_HOURS ? "Likely dropped" : row.ageHours > COLD_HOURS ? "Cold" : "Open";
  return `${word} · ${h}h`;
}

/** x of the first-seen dot on a 160-wide, 72-hour micro-timeline (today sits at 154); null when the age is unknown. */
export function threadX(ageHours: number | null): number | null {
  if (ageHours == null) return null;
  const h = Math.max(0, Math.min(THREAD_HOURS, ageHours));
  return 4 + ((THREAD_HOURS - h) / THREAD_HOURS) * 150;
}

/** A written prompt for a row with none of its own: pick it up where it was left. */
export function carryPrompt(row: CarryRow): string {
  const why = row.carry.why.trim();
  const running = row.carry.briefs > 1 ? ` after ${plural(row.carry.briefs, "brief")}` : "";
  const because = why ? ` ${/[.?!]$/.test(why) ? why : `${why}.`}` : "";
  return `Pick up "${row.title}". It was open at my ${firstSeenLabel(row.carry)} and still has no follow-up${running}.${because} Find any session, change or edit since, tell me in two lines where it stands, then give me the single next step. ${GUARD}`;
}

/** The prompt a row launches: the linked item's (from the plan, then its own), else the row's own, else a written one. */
export function resolvePrompt(row: CarryRow, prompts: Record<string, string>): string {
  if (row.linked) return prompts[row.linked.id] ?? row.linked.prompt ?? carryPrompt(row);
  return prompts[row.carry.id] ?? row.carry.prompt ?? carryPrompt(row);
}

const toneOf = (tone: RingTone): BriefTone => (tone === "red" ? "red" : tone === "warn" ? "warn" : "neutral");

/** A row's peek: why, when it was first seen, the closest follow-up, and its prompt. */
export function carryPeek(row: CarryRow, prompt: string): PeekContent {
  const sections: PeekContent["sections"] = [];
  if (row.carry.why.trim()) sections.push({ label: "Why", text: row.carry.why.trim() });
  const running = row.carry.briefs > 1 ? ` · ${plural(row.carry.briefs, "brief")} running` : "";
  sections.push({ label: "First seen", text: `${firstSeenLabel(row.carry)}${running}` });
  if (row.linked) {
    const live = "severity" in row.linked;
    sections.push({
      label: "Closest follow-up",
      tone: "ok",
      lines: [{ label: row.linked.title, state: live ? "LIVE" : "NEEDS YOU", tone: live ? "red" : "decision" }],
    });
  } else {
    sections.push({ label: "Closest follow-up", tone: "warn", text: "No session, change or edit since" });
  }
  return { title: row.title, status: ageLabel(row), sections, prompt: { id: row.launchId, text: prompt } };
}

/** The "+N more" row's peek: the rows past the cap, each with its tag. */
export function carryMorePeek(rest: readonly CarryRow[], catchUp = false): PeekContent {
  return {
    title: `${rest.length} more carried over`,
    status: "Also still open since your last brief",
    sections: [{ label: "Carried over", lines: rest.map((r) => ({ label: r.title, state: carryTag(r, catchUp), tone: toneOf(r.tone) })) }],
  };
}
