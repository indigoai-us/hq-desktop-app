/**
 * Peek contents shared by several cards (Needs you, the incident, the watch
 * list, Yesterday, Today's priorities), the priorities list itself, and the
 * pure helpers the health cards (incident, risk) render from: plain titles
 * with product names, red ages, main-health summaries, five-row caps. Pure.
 * Display-only helpers here may read `now`; none use toLocale*.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { humanTitle } from "./brief-distill.js";
import { productName, repoShort } from "./brief-origin.js";
import type { BriefDecision, BriefInput, BriefLine, BriefMainHealth, BriefMeeting, BriefPriority, BriefRisk } from "./brief-types.js";

/** Lines per peek section for meetings: past three the peek stops being a glance. */
const MEETING_LINES = 3;

/** Every list on a card shows at most this many rows, then "+N more". */
export const LIST_CAP = 5;

/** "1 agent", "5 agents", "2 people". */
export function countNoun(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(parts: readonly string[]): string {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return p[0] ?? "";
  return `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}

/** The first `cap` rows and the rest, for a list with a "+N more" row. */
export function capList<T>(rows: readonly T[], cap = LIST_CAP): { shown: T[]; rest: T[] } {
  return { shown: rows.slice(0, cap), rest: rows.slice(cap) };
}

/** A decision's peek: why, what clearing it unlocks, and its prompt. */
export function decisionPeek(d: BriefDecision, prompt: string | undefined): PeekContent {
  const sections: PeekContent["sections"] = [];
  if (d.detail?.why) sections.push({ label: "Why it matters", text: d.detail.why });
  if (d.detail?.unlocks.length) sections.push({ label: "Clearing it unlocks", lines: d.detail.unlocks });
  if (d.detail?.risk) sections.push({ label: "Watch", tone: "warn", text: d.detail.risk });
  return {
    sample: d.sample,
    title: d.title,
    status: d.detail?.source ?? d.summary,
    sections,
    prompt: prompt ? { id: d.id, text: prompt } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Incidents and watches: what the health cards say, in the owner's words
// ---------------------------------------------------------------------------

/** The product a risk is about: the writer's product, else from its repo (the CI repo as a fallback). "" when unknown. */
export function riskProduct(r: BriefRisk): string {
  return productName(r.origin.repo ?? r.ci?.repo ?? null, r.origin.product ?? null);
}

/** "HQ Cloud main is red" for a red main; "Main is red" when the product is unknown. */
export function redMainTitle(r: BriefRisk): string {
  const product = riskProduct(r);
  return `${product ? `${product} main` : "Main"} is red`;
}

/**
 * The incident card's eyebrow, never a repo slug: "HQ Cloud main is red" for a
 * red main, "Fleet incident" for a measured one, else the title as a to-do.
 */
export function incidentEyebrow(r: BriefRisk): string {
  if (r.ci) return redMainTitle(r);
  if (r.measure) {
    const product = riskProduct(r);
    return product ? `${product} incident` : "Incident";
  }
  return humanTitle(r.title).text;
}

/** A watch row's plain title: red mains name the product; anything else loses its repo slug, PR number and prefix. */
export function watchTitle(r: BriefRisk): string {
  return r.ci ? redMainTitle(r) : humanTitle(r.title).text;
}

/** A label that is only a reference: "hq-cloud #913", "#913", "org/repo #913". */
const REF_ONLY = /^(?:[\w.-]+\/)?[\w.-]*\s*#\d+$/;

/**
 * A fix-in-review link as a person's to-do, never a repo slug, PR number or
 * commit prefix: "Retry the nightly sync" from "fix(sync): retry the nightly
 * sync"; a bare reference ("hq-cloud #913") becomes "HQ Cloud fix".
 */
export function fixTitle(link: BriefRisk["links"][number]): string {
  const label = link.label.trim();
  if (!label || REF_ONLY.test(label)) {
    const product = productName(link.origin.repo || label.replace(/\s*#\d+$/, "") || null, link.origin.product ?? null);
    return product ? `${product} fix` : "A fix";
  }
  return humanTitle(label).text;
}

/** The fixes a risk card lists, plain, with the product each one is in; the rest go behind "+N more". */
export function fixLines(links: readonly BriefRisk["links"][number][]): BriefLine[] {
  return links.map((l) => {
    const product = productName(l.origin.repo, l.origin.product ?? null);
    return { label: fixTitle(l), state: product ? product.toUpperCase() : "REVIEW", tone: "warn" as const };
  });
}

/** The peek behind an incident card's "+N more" fixes chip: the fixes the face did not show. */
export function moreFixesPeek(rest: readonly BriefRisk["links"][number][]): PeekContent {
  return {
    title: `${countNoun(rest.length, "more fix", "more fixes")} in review`,
    sections: [{ label: "Fixes in review", lines: fixLines(rest) }],
  };
}

/** How long a main has been red, in hours, from ci.ageHours or ci.since; null when unknown. */
export function redHoursOf(r: BriefRisk, nowIso: string): number | null {
  if (!r.ci) return null;
  if (r.ci.ageHours != null && Number.isFinite(r.ci.ageHours) && r.ci.ageHours >= 0) return r.ci.ageHours;
  if (r.ci.since) {
    const t = Date.parse(r.ci.since);
    const now = Date.parse(nowIso);
    if (Number.isFinite(t) && Number.isFinite(now)) return Math.max(0, (now - t) / 3_600_000);
  }
  return null;
}

/** Mono age for a row end: "<1h", "5h", "2d"; null when unknown. */
export function shortHours(hours: number | null | undefined): string | null {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return null;
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Affected count of a measured incident (stuck = total - healthy), or null. */
export function affectedOf(r: BriefRisk): number | null {
  const m = r.measure;
  if (!m) return null;
  return Math.max(0, m.total - m.healthy);
}

/** A short state for a secondary incident row: "2d red", "5 agents stuck", or "". */
export function incidentShortState(r: BriefRisk, nowIso: string): string {
  if (r.ci) {
    const age = shortHours(redHoursOf(r, nowIso));
    return age ? `${age} red` : "red";
  }
  const n = affectedOf(r);
  if (n != null && r.measure) return `${countNoun(n, r.measure.unit.replace(/s$/, ""), r.measure.unit)} stuck`;
  return "";
}

/** "3 changes merged on top" when the writer counted merges after the main went red; null otherwise. */
export function mergesOnTopText(r: BriefRisk): string | null {
  const n = r.ci?.mergesOnTop;
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return `${countNoun(Math.round(n), "change")} merged on top`;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const UNIT_HOURS: Record<string, number> = { hour: 1, day: 24, week: 168 };
/** "for three days", "for the past 2 weeks", "for 5 hours": the writer's own duration, as hours. */
const FOR_SPAN = /\bfor\s+(?:the\s+(?:last|past)\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(hour|day|week)s?\b/i;

/**
 * How long an incident has been live, in hours: a red main's age (age_hours or
 * since), else the span the writer gave a measured incident in its summary or
 * title ("Five agents have sat in setup for three days" is 72). Null when the
 * brief carries no duration, so the card never invents one.
 */
export function incidentHoursOf(r: BriefRisk, nowIso: string): number | null {
  if (r.ci) return redHoursOf(r, nowIso);
  for (const text of [r.summary, r.title]) {
    const m = FOR_SPAN.exec(text ?? "");
    if (!m) continue;
    const word = m[1]!.toLowerCase();
    const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
    if (n != null && n > 0) return n * UNIT_HOURS[m[2]!.toLowerCase()]!;
  }
  return null;
}

/** The duration as the card's mono pill reads it: "UNDER 1 HOUR", "5 HOURS", "30 HOURS", then "3 DAYS" from two days (as red ages round). */
export function durationLabel(hours: number): string {
  if (hours < 1) return "UNDER 1 HOUR";
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} HOUR${h === 1 ? "" : "S"}`;
  }
  return `${Math.round(hours / 24)} DAYS`;
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

/** The incident card's "stuck for" track: where the live stretch sits on a short timeline that ends now. */
export interface DurationTrack {
  hours: number;
  /** "3 DAYS", the pill. */
  label: string;
  /** "days": the last seven calendar days, a letter each; "hours": the last 24 hours. */
  scale: "days" | "hours";
  /** The live stretch, as fractions of the track (0 = its left end). */
  from: number;
  to: number;
  /** It began before the track does: its left end runs off the track. */
  clipped: boolean;
  /** Labels under the track, centred at `at` (a fraction); `now` marks today's / the current one. */
  ticks: { label: string; at: number; now: boolean }[];
}

/**
 * The track for an incident live for `hours` as of `nowIso`. Past a day it is
 * this week: seven local calendar days with their initials, today last, the
 * stretch drawn from when it began to now. Under a day it is the last 24 hours.
 * Null when the duration or the clock is unknown.
 */
export function durationTrack(hours: number | null, nowIso: string): DurationTrack | null {
  const now = Date.parse(nowIso);
  if (hours == null || !Number.isFinite(hours) || hours < 0 || !Number.isFinite(now)) return null;
  const label = durationLabel(hours);
  if (hours < 24) {
    const from = Math.max(0, 1 - hours / 24);
    return {
      hours,
      label,
      scale: "hours",
      from,
      to: 1,
      clipped: false,
      ticks: [
        { label: "24H AGO", at: 0, now: false },
        { label: "12H", at: 0.5, now: false },
        { label: "NOW", at: 1, now: true },
      ],
    };
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  const span = end.getTime() - start.getTime();
  const began = now - hours * 3_600_000;
  const ticks = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return { label: DAY_LETTERS[d.getDay()]!, at: (i + 0.5) / 7, now: i === 6 };
  });
  return {
    hours,
    label,
    scale: "days",
    from: Math.max(0, (began - start.getTime()) / span),
    to: Math.min(1, (now - start.getTime()) / span),
    clipped: began < start.getTime(),
    ticks,
  };
}

/**
 * A risk or incident's peek: the plain title with the company chip, the
 * summary, the facts the card counted (red age, job, merges on top, the
 * affected set), fixes in review, and its prompt.
 */
export function riskPeek(risk: BriefRisk, prompt: string | undefined, nowIso = ""): PeekContent {
  const live = risk.severity === "incident";
  const facts: BriefLine[] = [];
  if (risk.ci) {
    const age = redAge(risk.ci, nowIso);
    if (age) facts.push({ label: age, state: "SINCE", tone: "red" });
    if (risk.ci.job) facts.push({ label: risk.ci.job, state: "JOB", tone: "neutral" });
    const onTop = mergesOnTopText(risk);
    if (onTop) facts.push({ label: onTop, state: "ON TOP", tone: "warn" });
  }
  const affected = affectedOf(risk);
  // The affected set only; the fleet's headcount is not a fact about the incident.
  if (risk.measure && affected != null) {
    facts.push({ label: `${countNoun(affected, risk.measure.unit.replace(/s$/, ""), risk.measure.unit)} ${risk.measure.cause}`, state: "MEASURED", tone: "red" });
  }
  const sections: PeekContent["sections"] = [];
  if (facts.length) sections.push({ label: live ? "Live" : "Facts", lines: facts });
  if (risk.links.length) sections.push({ label: "Fixes in review", lines: fixLines(risk.links) });
  const product = riskProduct(risk) || repoShort(risk.origin.repo);
  return {
    sample: risk.sample,
    eyebrow: live ? "Incident · live" : "Watch",
    origin: risk.origin.companyUid || product ? { companyUid: risk.origin.companyUid, label: product } : undefined,
    // A red main is titled by its workflow (the chip already names the product); anything else by its plain title.
    title: risk.ci?.workflow ?? (risk.ci ? redMainTitle(risk) : humanTitle(risk.title).text),
    status: risk.summary,
    sections,
    prompt: prompt ? { id: risk.id, text: prompt } : undefined,
  };
}

/** The peek behind an incident card's "+N more" row: the other live incidents with their state. */
export function moreIncidentsPeek(rest: readonly BriefRisk[], nowIso: string): PeekContent {
  return {
    title: `${rest.length} more live`,
    status: "Also live",
    sections: [{ label: "Incidents", lines: rest.map((r) => ({ label: watchTitle(r), state: incidentShortState(r, nowIso).toUpperCase(), tone: "red" as const })) }],
  };
}

/** The peek behind the watch card's "+N more" row: the other watch rows, red mains marked. */
export function moreWatchesPeek(rest: readonly BriefRisk[]): PeekContent {
  return {
    title: `${rest.length} more`,
    status: "Also worth watching",
    sections: [{ label: "Watch", lines: rest.map((r) => ({ label: watchTitle(r), state: r.ci ? "RED" : "", tone: r.ci ? ("red" as const) : ("neutral" as const) })) }],
  };
}

// ---------------------------------------------------------------------------
// Main health (the watch card's footer)
// ---------------------------------------------------------------------------

/** Case-insensitive name order, the same on every machine (no locale). */
const byName = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

export interface MainHealthSummary {
  total: number;
  green: number;
  /** Products with a red workflow, most red first. */
  red: BriefMainHealth[];
}

/** Products green of total from the sweep's main health; null when the sweep carried none. */
export function mainHealthSummary(rows: readonly BriefMainHealth[] | null | undefined): MainHealthSummary | null {
  if (!rows?.length) return null;
  const red = rows.filter((r) => r.red.length > 0).sort((a, b) => b.red.length - a.red.length || byName(a.repo, b.repo));
  return { total: rows.length, green: rows.length - red.length, red };
}

/** "Main health · 6 of 7 products green". */
export function mainHealthLabel(s: MainHealthSummary): string {
  return `Main health · ${s.green} of ${countNoun(s.total, "product")} green`;
}

/** The product a main-health row is about, never a repo slug. */
export function mainHealthProduct(r: BriefMainHealth): string {
  return productName(r.repo, r.product);
}

/** The footer's peek: every product GREEN or RED, red first (the peek shows five, then "+N more"). */
export function mainHealthPeek(rows: readonly BriefMainHealth[]): PeekContent {
  const s = mainHealthSummary(rows) ?? { total: 0, green: 0, red: [] };
  const redIds = new Set(s.red.map((r) => r.repo));
  const greens = rows.filter((r) => !redIds.has(r.repo)).sort((a, b) => byName(mainHealthProduct(a), mainHealthProduct(b)));
  const lines: BriefLine[] = [
    ...s.red.map((r) => ({
      label: `${mainHealthProduct(r)}${r.red.length > 1 ? ` · ${countNoun(r.red.length, "workflow")} red` : r.red[0]?.workflow ? ` · ${r.red[0].workflow}` : ""}`,
      state: "RED",
      tone: "red" as const,
    })),
    ...greens.map((r) => ({ label: mainHealthProduct(r), state: "GREEN", tone: "ok" as const })),
  ];
  const redNames = s.red.map(mainHealthProduct);
  return {
    title: "Main health",
    status: `${s.green} of ${countNoun(s.total, "product")} green${redNames.length ? ` · ${joinAnd(redNames)} red` : ""}`,
    sections: [{ label: "Products", lines }],
  };
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/** The prompt that starts one of your own meeting to-dos. */
export function todoPrompt(meeting: string, text: string): string {
  return `Do this action item from ${meeting}: ${text}. Check HQ for context first.`;
}

/**
 * What a meeting left you to act on: up to three decisions, up to three
 * to-dos with yours first (tagged "you", each with Start and Copy prompt),
 * and "+N more in Meetings" only when there is more.
 */
export function meetingPeek(m: BriefMeeting, actions: PeekContent["actions"] = []): PeekContent {
  const sections: PeekContent["sections"] = [];
  const decided = m.decided ?? [];
  const todo = [...(m.todo ?? [])].sort((a, b) => Number(!!b.mine) - Number(!!a.mine));
  if (decided.length) sections.push({ label: "Decided", lines: decided.slice(0, MEETING_LINES).map((d) => ({ label: d, state: "" })) });
  if (todo.length) {
    sections.push({
      label: "To do",
      lines: todo.slice(0, MEETING_LINES).map((t, i) => ({
        label: t.text,
        state: t.mine ? "" : (t.owner ?? ""),
        ...(t.mine ? { tag: "you", prompt: { id: `${m.id}:todo${i}`, text: todoPrompt(m.title, t.text) } } : {}),
      })),
    });
  }
  if (!sections.length && m.summary) sections.push({ label: "Summary", text: m.summary });
  const shown = Math.min(decided.length, MEETING_LINES) + Math.min(todo.length, MEETING_LINES);
  const rest = Math.max(m.decisions, decided.length) + Math.max(m.actions, todo.length) - shown;
  return {
    title: m.title,
    status: rest > 0 ? `+${rest} more in Meetings` : undefined,
    sections,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Today's priorities
// ---------------------------------------------------------------------------

/**
 * Today's priorities: the writer's list from brief.json when it has one,
 * else the top three decisions and then the live incident, so the card is
 * never empty while there is something to do. At most five.
 */
export function briefPriorities(input: BriefInput): BriefPriority[] {
  if (input.priorities?.length) return input.priorities.slice(0, 5);
  const out: BriefPriority[] = input.decisions.slice(0, 3).map((d, i) => ({
    n: i + 1,
    text: d.title,
    because: d.detail?.why && d.detail.why !== d.title ? d.detail.why : d.summary !== d.title ? d.summary : null,
    itemId: d.id,
  }));
  const incident = input.risks.find((r) => r.severity === "incident");
  if (incident) {
    // Never a repo slug: "Fix HQ core's red Nightly sync check" from the product and the workflow.
    const product = riskProduct(incident);
    const text = incident.ci?.workflow
      ? `Fix ${product ? `${product}'s` : "the"} red ${incident.ci.workflow} check`
      : incident.ci
        ? `Fix ${redMainTitle(incident).replace(/ is red$/, "")}`
        : watchTitle(incident);
    out.push({ n: out.length + 1, text, because: incident.summary || null, itemId: incident.id });
  }
  return out;
}

/**
 * The writer's unblock score said in words, for a priority row's peek:
 * "unblocks 3 people and revenue · 44h old" for a decision, "red for 2 days"
 * or "5 agents stuck" for an incident. Falls back to "rank score N" when the
 * item carries no facts. Null when the writer wrote no score.
 */
export function priorityScoreWords(p: BriefPriority, item: BriefDecision | BriefRisk | null, nowIso = ""): string | null {
  if (p.score == null || !Number.isFinite(p.score)) return null;
  const parts: string[] = [];
  if (item && "action" in item) {
    const people = item.peopleWaiting ?? new Set((item.blocks ?? []).filter((b) => b.kind === "person").map((b) => b.who.trim().toLowerCase())).size;
    const things = item.detail?.unlocks.length ?? (item.blocks ?? []).filter((b) => b.kind === "work").length;
    const frees = [people > 0 ? countNoun(people, "person", "people") : "", things > 0 ? countNoun(things, "thing") : "", item.revenue ? "revenue" : ""].filter(Boolean);
    if (frees.length) parts.push(`unblocks ${joinAnd(frees)}`);
    const age = shortHours(item.ageHours);
    if (age) parts.push(`${age} old`);
  } else if (item) {
    if (item.ci) {
      const age = redAge(item.ci, nowIso);
      parts.push(age ? age.charAt(0).toLowerCase() + age.slice(1) : "red on main");
    }
    const n = affectedOf(item);
    if (n != null && item.measure) parts.push(`${countNoun(n, item.measure.unit.replace(/s$/, ""), item.measure.unit)} stuck`);
  }
  if (!parts.length) parts.push(`rank score ${p.score}`);
  return parts.join(" · ");
}

/** "Red for 3h", "Red for 2 days" or "Red since Oct 9", from the incident's CI detail; null when unknown. */
export function redAge(ci: NonNullable<BriefRisk["ci"]>, nowIso: string): string | null {
  let hours = ci.ageHours;
  if (hours == null && ci.since) {
    const t = Date.parse(ci.since);
    if (Number.isFinite(t)) hours = (Date.parse(nowIso) - t) / 3_600_000;
  }
  if (hours != null && Number.isFinite(hours) && hours >= 0) {
    if (hours < 1) return "Red for under an hour";
    if (hours < 48) return `Red for ${Math.round(hours)}h`;
    return `Red for ${Math.round(hours / 24)} days`;
  }
  const since = ci.note?.match(/since\s+([A-Z][a-z]{2}\s+\d{1,2})/)?.[1];
  return since ? `Red since ${since}` : null;
}

/**
 * A red main's "N of M workflows red on main." note as numbers, so the card can
 * draw it (M dots, N lit) instead of a sentence. Null for any other note.
 */
export function workflowsRed(note: string | null | undefined): { red: number; total: number } | null {
  const m = /^(\d+) of (\d+) workflows? red on main\.?$/i.exec((note ?? "").trim());
  if (!m) return null;
  const red = Number(m[1]);
  const total = Number(m[2]);
  return total > 0 && red <= total && total <= 12 ? { red, total } : null;
}
