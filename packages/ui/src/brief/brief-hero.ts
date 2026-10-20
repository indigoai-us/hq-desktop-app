/**
 * Pure helpers for the two hero cards, Sunrise and Welcome back: the "First:"
 * line that names priority 1, the time-to-clear estimate beside the meter,
 * day tags, and the catch-up tiles with their peeks. Display only: the picker
 * never reads this file, so local-time formatting is fine here.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { humanTitle } from "./brief-distill.js";
import { productName } from "./brief-origin.js";
import { decisionPeek, redAge, riskPeek } from "./brief-peeks.js";
import { clockLabel } from "./brief-time.js";
import type {
  BriefDay,
  BriefDecision,
  BriefHandoff,
  BriefInput,
  BriefLine,
  BriefOrigin,
  BriefRecovered,
  BriefRisk,
  BriefShipped,
  BriefTone,
} from "./brief-types.js";

/** Priority 1 in the writer's words, as the heroes receive it. */
export interface HeroLead {
  text: string;
  because: string | null;
  /** The item priority 1 is about, when the writer named one. */
  itemId?: string | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Trims a sentence and drops its closing punctuation. */
const clause = (s: string | null | undefined) => (s ?? "").trim().replace(/[.!?]+$/, "");

/** A because clause as its own sentence: capitalised, ending in a period. */
function becauseSentence(because: string | null | undefined): string {
  const b = (because ?? "").trim();
  if (!b) return "";
  return `${b.charAt(0).toUpperCase()}${b.slice(1)}${/[.!?]$/.test(b) ? "" : "."}`;
}

/** "First: Cut the release. Investors wait on it." Empty when there is no lead. */
export function firstLine(lead: HeroLead | null | undefined): string {
  const text = clause(lead?.text);
  if (!text) return "";
  const because = becauseSentence(lead?.because);
  return `First: ${text}.${because ? ` ${because}` : ""}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When the last brief was, in words: "since Sunday's brief" inside the week,
 * "since your Oct 2 brief" beyond it, "since yesterday's brief". Empty when
 * there was no last brief or its time is unreadable.
 */
export function catchUpSince(lastBriefAt: string | null | undefined, nowIso: string): string {
  if (!lastBriefAt) return "";
  const t = new Date(lastBriefAt);
  const n = new Date(nowIso);
  if (Number.isNaN(t.getTime()) || Number.isNaN(n.getTime())) return "";
  const days = Math.round((localDayStart(n) - localDayStart(t)) / DAY_MS);
  if (days <= 0) return "since this morning's brief";
  if (days === 1) return "since yesterday's brief";
  if (days < 7) return `since ${WEEKDAYS[t.getDay()]}'s brief`;
  return `since your ${MONTH_NAMES[t.getMonth()]} ${t.getDate()} brief`;
}

/**
 * The Welcome back greeting under the days-away number: "Here's what changed
 * since Sunday's brief." The lead itself is the card's featured block, so the
 * greeting never repeats it.
 */
export function catchUpGreet(lastBriefAt: string | null | undefined, nowIso: string): string {
  const since = catchUpSince(lastBriefAt, nowIso);
  return since ? `Here's what changed ${since}.` : "Here's what changed.";
}

/** The lead's because as the line under the Welcome back greeting; empty without one. */
export function catchUpBecause(lead: HeroLead | null | undefined): string {
  return clause(lead?.text) ? becauseSentence(lead?.because) : "";
}

/** Minutes a decision takes by the writer's effort size. */
export const EFFORT_MIN = { quick: 2, medium: 6, large: 15 } as const;

/**
 * Minutes to clear the open decisions from their effort sizes. Unsized
 * decisions count as medium once at least one is sized; null when none is,
 * so the meter shows nothing rather than a guess.
 */
export function effortMinutes(decisions: readonly Pick<BriefDecision, "effort">[]): number | null {
  if (!decisions.some((d) => d.effort && d.effort in EFFORT_MIN)) return null;
  return decisions.reduce((n, d) => n + EFFORT_MIN[d.effort && d.effort in EFFORT_MIN ? d.effort : "medium"], 0);
}

/**
 * "~6 min" for what is still open. The writer's total covers every open
 * decision at brief time; once some are cleared here the estimate scales by
 * what is left. Empty when nothing is left or no estimate exists.
 */
export function etaLabel(totalMin: number | null | undefined, left: number, total: number): string {
  if (totalMin == null || !Number.isFinite(totalMin) || totalMin <= 0 || left <= 0 || total <= 0) return "";
  const min = left >= total ? Math.round(totalMin) : Math.max(1, Math.round((totalMin * left) / total));
  return `~${min} min`;
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const localDayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When something happened, as a short mono tag: "TODAY", a weekday ("THU")
 * inside the last week, else "OCT 2". Empty when the time is unknown.
 */
export function dayTag(iso: string | null | undefined, nowIso: string): string {
  if (!iso) return "";
  const t = new Date(iso);
  const n = new Date(nowIso);
  if (Number.isNaN(t.getTime()) || Number.isNaN(n.getTime())) return "";
  const days = Math.round((localDayStart(n) - localDayStart(t)) / DAY_MS);
  if (days === 0) return "TODAY";
  if (days > 0 && days < 7) return DAYS[t.getDay()]!;
  return `${MONTHS[t.getMonth()]} ${t.getDate()}`;
}

/** One Welcome back tile: what changed, in which tone, with its peek. */
export interface CatchUpTile {
  id: string;
  tone: BriefTone;
  /** Mono tag: "THU · INCIDENT", "WAITING ON YOU", "SHIPPED". */
  tag: string;
  text: string;
  sub: string;
  /** Company logo and product chips (up to three shown). */
  origins: BriefOrigin[];
  peek: PeekContent;
}

/** Tiles on the face of the card; the rest sit behind "+N more". */
export const CATCH_UP_TILES = 5;

const tagOf = (day: string, kind: string) => (day ? `${day} · ${kind}` : kind);

function incidentTile(r: BriefRisk, prompt: string | undefined, nowIso: string): CatchUpTile {
  const title = humanTitle(r.title).text;
  let text = title;
  let sub = r.summary;
  let when = "";
  if (r.measure) {
    const stuck = r.measure.total - r.measure.healthy;
    sub = `${stuck} of ${r.measure.total} ${r.measure.unit} affected. ${r.summary}`.trim();
  } else if (r.ci) {
    when = dayTag(r.ci.since, nowIso);
    const age = redAge(r.ci, nowIso);
    const product = productName(r.ci.repo, r.origin.product);
    text = r.ci.workflow ? `${product}: ${r.ci.workflow} is red` : title;
    sub = age ? `${age}. ${r.summary}`.trim() : r.summary;
  }
  return { id: r.id, tone: "red", tag: tagOf(when || "NOW", "INCIDENT"), text, sub, origins: [r.origin], peek: riskPeek(r, prompt) };
}

function decisionTile(d: BriefDecision, prompt: string | undefined, nowIso: string): CatchUpTile {
  const raised = d.ageHours != null && Number.isFinite(d.ageHours) ? new Date(Date.parse(nowIso) - d.ageHours * HOUR_MS).toISOString() : null;
  const text = humanTitle(d.title).text;
  const sub = d.summary && d.summary !== d.title ? d.summary : "";
  return { id: d.id, tone: "decision", tag: tagOf(dayTag(raised, nowIso), "WAITING ON YOU"), text, sub, origins: [d.origin], peek: decisionPeek(d, prompt) };
}

/** What got fixed: its timeline when the writer kept one, else the post-incident lines. */
export function recoveredPeek(r: BriefRecovered): PeekContent {
  const sections: PeekContent["sections"] = [];
  if (r.timeline?.length) {
    sections.push({ label: "Timeline", lines: r.timeline.map((t) => ({ label: t.text, state: clockLabel(t.at), tone: "ok" as const })) });
  }
  if (r.postIncident) {
    sections.push({ label: "What broke", text: r.postIncident.broke });
    sections.push({ label: "What we did", text: r.postIncident.did });
    sections.push({ label: "What changed", text: r.postIncident.changes });
  }
  return { title: humanTitle(r.title).text, status: r.what, sections };
}

function recoveredTile(r: BriefRecovered, nowIso: string): CatchUpTile {
  return { id: r.id, tone: "ok", tag: tagOf(dayTag(r.at, nowIso), "FIXED"), text: humanTitle(r.title).text, sub: r.what, origins: [r.origin], peek: recoveredPeek(r) };
}

/** A receipt's state: true done, false still waiting, null never shown as done. */
const RECEIPT: Record<string, { state: string; tone: BriefTone }> = {
  true: { state: "DONE", tone: "ok" },
  false: { state: "WAITING", tone: "warn" },
  null: { state: "UNKNOWN", tone: "neutral" },
};

/** A handoff's peek: who to whom, the three receipts, the note, and its prompt. */
export function handoffPeek(h: BriefHandoff, nowIso: string): PeekContent {
  const receipt = (label: string, v: boolean | null): BriefLine => ({ label, ...RECEIPT[String(v)]! });
  const since = dayTag(h.since, nowIso);
  const sections: PeekContent["sections"] = [
    { label: "Receipts", lines: [receipt("Access granted", h.receipts.access), receipt("Acknowledged", h.receipts.ack), receipt("Active", h.receipts.active)] },
  ];
  if (h.note) sections.push({ label: "Note", text: h.note });
  return {
    title: h.object,
    status: `${h.me ? `From ${h.from}` : `${h.from} to ${h.to}`}${h.production ? " · production" : ""}${since ? ` · since ${since}` : ""}`,
    sections,
    prompt: h.prompt ? { id: h.id, text: h.prompt } : undefined,
  };
}

function handoffTile(h: BriefHandoff, nowIso: string): CatchUpTile {
  const kind = h.me ? "NOW YOURS" : "HANDED OFF";
  const sub = h.me ? `From ${h.from}${h.production ? " · production" : ""}` : `${h.from} to ${h.to}`;
  return { id: h.id, tone: h.me ? "decision" : "neutral", tag: tagOf(dayTag(h.since, nowIso), kind), text: h.object, sub, origins: [h.origin], peek: handoffPeek(h, nowIso) };
}

/** What shipped while you were away, by product name (never a repo slug). */
export function shippedPeek(shipped: readonly BriefShipped[], merged: number | null | undefined): PeekContent {
  const byProduct = shipped.map((s) => ({ label: productName(s.origin.repo, s.origin.product), state: s.status, tone: "ok" as const }));
  const worth = shipped
    .map((s) => s.highlights?.[0] ?? s.why ?? "")
    .filter(Boolean)
    .map((t) => ({ label: humanTitle(t).text, state: "" }));
  const sections: PeekContent["sections"] = [];
  if (byProduct.length) sections.push({ label: "By product", lines: byProduct });
  if (worth.length) sections.push({ label: "Worth knowing", lines: worth });
  return { title: merged != null ? `${merged} merged` : `${shipped.length} product${shipped.length === 1 ? "" : "s"} shipped`, status: "Since your last brief", sections };
}

function shippedTile(shipped: readonly BriefShipped[], merged: number | null | undefined): CatchUpTile | null {
  if (!shipped.length && !(merged != null && merged > 0)) return null;
  const names = [...new Set(shipped.map((s) => productName(s.origin.repo, s.origin.product)))];
  const text = merged != null ? `${merged} merged` : `${names.length} product${names.length === 1 ? "" : "s"} shipped`;
  const sub = names.length ? `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}` : "";
  const seen = new Set<string>();
  const origins = shipped.map((s) => s.origin).filter((o) => {
    const k = productName(o.repo, o.product);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { id: "shipped", tone: "ok", tag: "SHIPPED", text, sub, origins, peek: shippedPeek(shipped, merged) };
}

/**
 * The Welcome back tiles, in the order the catalogue counts them: live
 * incidents, the two decisions it ranked first, what got fixed, what was
 * handed to you, then one tile for everything shipped. The caller shows the
 * first five and puts the rest behind "+N more".
 */
export function catchUpTiles(
  input: BriefInput,
  opts: { decisions: readonly BriefDecision[]; prompts: Record<string, string>; now?: string },
): CatchUpTile[] {
  const now = opts.now ?? input.now;
  const tiles: CatchUpTile[] = [];
  for (const r of input.risks.filter((r) => r.severity === "incident")) tiles.push(incidentTile(r, opts.prompts[r.id], now));
  for (const d of opts.decisions.slice(0, 2)) tiles.push(decisionTile(d, opts.prompts[d.id], now));
  for (const r of input.recovered ?? []) tiles.push(recoveredTile(r, now));
  for (const h of input.handoffs ?? []) tiles.push(handoffTile(h, now));
  const ship = shippedTile(input.shipped, input.merged);
  if (ship) tiles.push(ship);
  return tiles;
}

/** The peek behind "+N more": every tile that did not fit on the face. */
export function moreTilesPeek(rest: readonly CatchUpTile[]): PeekContent {
  return {
    title: `${rest.length} more change${rest.length === 1 ? "" : "s"}`,
    status: "Also since your last brief",
    sections: [{ label: "Changes", lines: rest.map((t) => ({ label: t.text, state: t.tag.split(" · ").pop() ?? t.tag, tone: t.tone })) }],
  };
}

/** Priority 1 as Welcome back features it: the writer's words, the why, and its tile when it has one. */
export interface CatchUpLead {
  text: string;
  because: string;
  /** The tile it is about (its tag, product, peek and prompt); null when priority 1 has no tile. */
  tile: CatchUpTile | null;
}

const sameText = (a: string, b: string) => clause(a).toLowerCase() === clause(b).toLowerCase();

/**
 * The one thing Welcome back starts with: priority 1 in the writer's words,
 * matched to its tile by item id (else by its words). Without a priority the
 * first tile leads, the way the catalogue counts them. Null when there is
 * nothing to lead with.
 */
export function catchUpLead(tiles: readonly CatchUpTile[], lead: HeroLead | null | undefined): CatchUpLead | null {
  const text = clause(lead?.text);
  if (text) {
    const tile = (lead?.itemId ? tiles.find((t) => t.id === lead.itemId) : undefined) ?? tiles.find((t) => sameText(t.text, text)) ?? null;
    return { text, because: catchUpBecause(lead) || becauseSentence(tile?.sub), tile };
  }
  const first = tiles[0];
  return first ? { text: first.text, because: becauseSentence(first.sub), tile: first } : null;
}

/** One big number on the Welcome back card: what moved while you were away. */
export interface CatchUpStat {
  key: "waiting" | "merged" | "shipped" | "meetings" | "sessions" | "dms";
  /** Mono caps label: "WAITING ON YOU", "MERGED". */
  label: string;
  value: number;
  /** The number to read first (calls waiting on you); the rest are quieter. */
  focus: boolean;
  peek: PeekContent | null;
}

/** The local YYYY-MM-DD of a time; "" when unreadable. */
function localDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A YYYY-MM-DD as a local date, or null. */
function parseDay(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** One day you were away, as the orbit on the Welcome back card draws it. */
export interface AwayDay {
  date: string;
  /** Mono weekday tag: "SUN". */
  tag: string;
  /** Sessions, meetings and merges that day; 0 when the brief has no day stats. */
  weight: number;
  /** That day's numbers; null when the brief has no day stats. */
  peek: PeekContent | null;
}

/** The days in the away window that the brief has stats for, oldest first (at most seven). */
export function awayWindow(input: Pick<BriefInput, "days" | "lastBriefAt" | "now" | "today">): BriefDay[] {
  const from = localDate(input.lastBriefAt);
  const today = input.today ?? localDate(input.now);
  return (input.days ?? []).filter((d) => (!from || d.date >= from) && (!today || d.date < today)).slice(-7);
}

/**
 * The days you were away, oldest first, for the orbit: the brief's own day
 * stats when it has them (each with a peek of that day's numbers), else just
 * the dates counted back from today. At most seven; empty when you were not away.
 */
export function awayDays(input: Pick<BriefInput, "days" | "lastBriefAt" | "now" | "today">, daysAway: number): AwayDay[] {
  if (!(daysAway >= 1)) return [];
  const window = awayWindow(input);
  if (window.length) {
    return window.map((d) => {
      const at = parseDay(d.date);
      const lines: BriefLine[] = [
        { label: "Sessions", state: String(d.sessions) },
        { label: "Meetings", state: String(d.meetings) },
        { label: "Merged", state: String(d.merged) },
      ];
      return {
        date: d.date,
        tag: at ? DAYS[at.getDay()]! : "",
        weight: d.sessions + d.meetings + d.merged,
        peek: {
          title: at ? `${WEEKDAYS[at.getDay()]}, ${MONTH_NAMES[at.getMonth()]} ${at.getDate()}` : d.date,
          status: d.beat?.label ?? "While you were away",
          sections: [{ label: "That day", lines }],
        },
      };
    });
  }
  const end = parseDay(input.today ?? localDate(input.now)) ?? new Date(input.now);
  const n = Math.min(Math.floor(daysAway), 7);
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (n - i));
    return { date: localDate(at.toISOString()), tag: DAYS[at.getDay()]!, weight: 0, peek: null };
  });
}

const sum = (days: readonly BriefDay[], key: "sessions" | "meetings" | "merged") => days.reduce((n, d) => n + (Number.isFinite(d[key]) ? d[key] : 0), 0);

/** A by-day peek for one of the away numbers. */
function byDayPeek(title: string, days: readonly BriefDay[], key: "sessions" | "meetings"): PeekContent {
  return {
    title,
    status: "While you were away",
    sections: [
      {
        label: "By day",
        lines: days.map((d) => {
          const at = parseDay(d.date);
          return { label: at ? `${WEEKDAYS[at.getDay()]}, ${MONTH_NAMES[at.getMonth()]} ${at.getDate()}` : d.date, state: String(d[key]) };
        }),
      },
    ],
  };
}

const countOf = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What moved while you were away, as up to four big numbers: the calls
 * waiting on you first (the one to read), then merged (or products shipped),
 * meetings, sessions and DMs over the away window. A number the brief does
 * not know is left out rather than shown as 0; waiting always shows.
 */
export function catchUpStats(input: BriefInput, decisions: readonly BriefDecision[]): CatchUpStat[] {
  const window = awayWindow(input);
  const waiting = decisions.length;
  const out: CatchUpStat[] = [
    {
      key: "waiting",
      label: "WAITING ON YOU",
      value: waiting,
      focus: waiting > 0,
      peek: waiting
        ? {
            title: `${countOf(waiting, "call")} ${waiting === 1 ? "waits" : "wait"} on you`,
            status: "Ranked by what they unblock",
            sections: [{ label: "Waiting on you", lines: decisions.map((d) => ({ label: humanTitle(d.title).text, state: productName(d.origin.repo, d.origin.product) })) }],
          }
        : null,
    },
  ];
  const merged = input.merged ?? (window.length ? sum(window, "merged") : null);
  if (merged != null && merged > 0) out.push({ key: "merged", label: "MERGED", value: merged, focus: false, peek: shippedPeek(input.shipped, merged) });
  else if (input.shipped.length) out.push({ key: "shipped", label: "SHIPPED", value: input.shipped.length, focus: false, peek: shippedPeek(input.shipped, input.merged) });
  const meetings = sum(window, "meetings");
  if (meetings > 0) out.push({ key: "meetings", label: "MEETINGS", value: meetings, focus: false, peek: byDayPeek(countOf(meetings, "meeting"), window, "meetings") });
  const sessions = sum(window, "sessions");
  if (sessions > 0) out.push({ key: "sessions", label: "SESSIONS", value: sessions, focus: false, peek: byDayPeek(countOf(sessions, "session"), window, "sessions") });
  if (input.dmCount && input.dmCount > 0) out.push({ key: "dms", label: "DMS", value: input.dmCount, focus: false, peek: null });
  return out.slice(0, 4);
}

/**
 * A point on the Welcome back orbit at t in [0, 1], in percent of the orbit's
 * box: a curve that rises from the bottom left to "today" at the top right.
 */
export const ORBIT = { p0: [0, 94], p1: [46, 94], p2: [80, 66], p3: [97, 10] } as const;
export function orbitPoint(t: number): [number, number] {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * ORBIT.p0[0] + b * ORBIT.p1[0] + c * ORBIT.p2[0] + d * ORBIT.p3[0], a * ORBIT.p0[1] + b * ORBIT.p1[1] + c * ORBIT.p2[1] + d * ORBIT.p3[1]];
}
