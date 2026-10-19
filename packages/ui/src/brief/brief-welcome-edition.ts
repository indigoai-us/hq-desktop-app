/**
 * The welcome edition after the rise (round 11b final frame): the greeting,
 * three cards (your decision, your day, the work to pick up) and one short
 * section per company. Built from the brief input only, so nothing on the
 * page is sample copy.
 */

import type { BriefCalendarEvent, BriefDecision, BriefInput } from "./brief-types.js";

export const WELCOME_EDITION_EYEBROW = "Your welcome edition · Ready";
export const WELCOME_EDITION_SUB = "Your decisions, your day, and the work worth picking up.";
export const WELCOME_EDITION_ZERO_HEADLINE = "A place to begin.";
export const WELCOME_EDITION_ZERO_SUB = "Your personal brief is ready. No company needed.";
export const WELCOME_EDITION_HEAD = "Your day, ready to read.";
/** The day card's label when the calendar could not be read (the brief's own priorities heading). */
export const WELCOME_EDITION_PRIORITIES = "Today's priorities";

/** What a card's link does: hand the item's prompt to a session, or open the Meetings page. */
export type WelcomeEditionAction =
  | { kind: "launch"; itemId: string; prompt: string }
  | { kind: "meetings" };

export interface WelcomeEditionCard {
  id: "decision" | "day" | "work" | "task" | "context";
  /** The small pill before the kicker ("Your decision"), when the card has one. */
  pill: string | null;
  kicker: string;
  title: string;
  lines: string[];
  label: string | null;
  action: WelcomeEditionAction | null;
}

export interface WelcomeEditionSection {
  name: string;
  lines: string[];
}

export interface WelcomeEdition {
  zero: boolean;
  headline: string;
  sub: string;
  cards: WelcomeEditionCard[];
  sections: WelcomeEditionSection[];
  /** One quiet line under the greeting: the run stats and any source that could not be read. Null when empty. */
  note: string | null;
}

const FILE = /\b[\w.-]+\.(?:svelte|tsx?|jsx?|mjs|cjs|vue|astro|json|mdx?|txt|csv|sql|lock|rs|py|java|php|cpp|css|scss|html|ya?ml|toml|sh|go|rb|swift|kt)\b/i;
/** Library names that read like a filename ("Node.js", "Next.js") and are not one. */
const LIBRARY = /\b(?:node|next|nuxt|vue|react|express|three|d3|chart|alpine|ember|angular|deno|nest|solid|p5)\.js\b/gi;
/** A path segment has a lowercase letter, so dates, "24/7", and "Q3/Q4" are not paths. */
const SEG = "[\\w.@-]*[a-z][\\w.@-]*";
const BARE_PATH = new RegExp(`^\\s*~?${SEG}(?:/${SEG})+/?\\s*$`);
const DEEP_PATH = new RegExp(`${SEG}/${SEG}/${SEG}`);
/** A one-slash path inside a sentence, named by a code folder ("Fix the bug in src/brief"). */
const CODE_DIR = /(?:^|[\s(])(?:src|apps?|packages|libs?|components|scripts|tests?|docs|crates|repos|companies|workspace)\/[\w.@-]+/;
/** Slashed words that are prose, not a path. */
const PROSE = new Set(["and/or", "either/or", "he/she", "his/her", "him/her", "s/he", "w/o", "n/a"]);

/** True when text shows a filename or a repo path ("WelcomeReport.svelte", "northstar/desktop"). */
export function looksLikePath(text: string, repo?: string | null): boolean {
  const t = text.trim();
  if (!t) return false;
  const named = t.replace(LIBRARY, "");
  if (FILE.test(named) || DEEP_PATH.test(t) || CODE_DIR.test(t)) return true;
  if (BARE_PATH.test(t) && !PROSE.has(t.toLowerCase())) return true;
  const r = repo?.trim();
  return !!r && r.includes("/") && t.toLowerCase().includes(r.toLowerCase());
}

/** "Good morning, Alex." by the brief's local hour; no name, no comma. */
export function welcomeGreeting(now: Date, userName?: string | null): string {
  const h = now.getHours();
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const name = userName?.trim();
  return name ? `Good ${part}, ${name}.` : `Good ${part}.`;
}

/** A company slug as a name ("northstar" to "Northstar"); a label from the host wins. */
export function companyName(slug: string, labels: ReadonlyMap<string, string> = new Map()): string {
  const label = labels.get(slug.toLowerCase());
  if (label?.trim()) return label.trim();
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function launch(d: BriefDecision, prompts: Record<string, string>): WelcomeEditionAction {
  const prompt = (prompts[d.id] ?? d.prompt ?? "").trim() || d.title;
  return { kind: "launch", itemId: d.id, prompt };
}

/** A card or section title in plain words: never a filename or path. Falls back to the product, then the company. */
function plainTitle(d: BriefDecision, company: string): string {
  const repo = d.origin?.repo;
  const text = d.title.trim();
  if (text && !looksLikePath(text, repo)) return text;
  const product = d.origin?.product?.trim();
  if (product && !looksLikePath(product, repo)) return product;
  return company;
}

/** The lines under a title, with any filename or path line, or a repeat of the title, left out. */
function plainLines(d: BriefDecision, title: string): string[] {
  return [d.summary].filter((l) => l?.trim() && l.trim() !== title && !looksLikePath(l, d.origin?.repo));
}

/** The next event still ahead today, else the first of the day. */
function nextEvent(events: readonly BriefCalendarEvent[], now: Date): BriefCalendarEvent | null {
  const real = events.filter((e) => !e.busy && e.title.trim());
  const ahead = real.filter((e) => Date.parse(e.start) >= now.getTime());
  return ahead[0] ?? real[0] ?? null;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function calendarFailed(input: BriefInput): boolean {
  return (input.sourceNotes ?? []).some((n) => /calendar/i.test(n));
}

/**
 * The agenda card. A calendar that could not be read is never its headline (that is
 * the quiet note under the greeting); the card then counts what the page shows today,
 * under the priorities label, with no agenda link because there is no agenda to open.
 */
function dayCard(input: BriefInput, now: Date, shown: number, names: readonly string[]): WelcomeEditionCard {
  const event = nextEvent(input.calendarToday, now);
  if (event) {
    const who = (event.attendees ?? []).slice(0, 2);
    return {
      id: "day",
      pill: null,
      kicker: "Today · Personal",
      title: `${timeOf(event.start)} · ${event.title}`,
      lines: who.length ? [who.join(" and ")] : [],
      label: "Open the agenda",
      action: { kind: "meetings" },
    };
  }
  if (calendarFailed(input)) {
    return {
      id: "day",
      pill: null,
      kicker: WELCOME_EDITION_PRIORITIES,
      title: shown ? `${shown} ${shown === 1 ? "thing" : "things"} for you today.` : "Nothing is waiting on you.",
      lines: names.length ? [`Across ${listOf(names)}.`] : [],
      label: null,
      action: null,
    };
  }
  return {
    id: "day",
    pill: null,
    kicker: "Today · Personal",
    title: "Your calendar is clear.",
    lines: ["Nothing is booked today. The time is yours."],
    label: null,
    action: null,
  };
}

/** "Northstar", "Northstar and Studio", "Northstar, Fieldwork, and Studio". */
function listOf(names: readonly string[]): string {
  if (names.length < 3) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** The run stats the reveal ended on, then each source that could not be read. Shown once. */
function editionNote(input: BriefInput): string | null {
  const n = input.sessions.length;
  const stats = input.runStats?.trim() || (n ? `${n} ${n === 1 ? "session" : "sessions"} read` : "");
  const parts = [stats, ...(input.sourceNotes ?? []).map((l) => l.trim().replace(/\.$/, ""))].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}.` : null;
}

/**
 * The edition for this brief. The first open decision leads, the calendar
 * fills the day card and the last other decision is the work to pick up.
 * With no company the page is the getting-started edition (zero variant).
 */
export function welcomeEdition(
  input: BriefInput,
  prompts: Record<string, string> = {},
  labels: ReadonlyMap<string, string> = new Map(),
): WelcomeEdition {
  const now = new Date(input.now);
  const companies = input.companies.filter((c) => c.trim());
  if (!companies.length) {
    return {
      zero: true,
      headline: WELCOME_EDITION_ZERO_HEADLINE,
      sub: WELCOME_EDITION_ZERO_SUB,
      cards: [
        {
          id: "task",
          pill: null,
          kicker: "Personal · A useful first step",
          title: "Give your agent one small task.",
          lines: ["Ask it to organize your notes, review a file, or plan the next hour."],
          label: null,
          action: null,
        },
        {
          id: "context",
          pill: null,
          kicker: "Your context",
          title: "Start with the work you have.",
          lines: ["Connect a tool whenever you want a richer brief."],
          label: null,
          action: null,
        },
      ],
      sections: [
        { name: "A space for your team", lines: ["Start or join a company when you have work to share."] },
        { name: "Your brief belongs to you.", lines: ["No company is needed. Your personal work always has a place here."] },
      ],
      note: null,
    };
  }

  // A decision belongs to the company its origin names; one with no company is the lead company's.
  const owner = (d: BriefDecision) => companyName(d.origin?.companyUid?.trim() || companies[0]!, labels);
  const [first, ...rest] = input.decisions;
  const work = rest.length ? rest[rest.length - 1]! : null;
  const onCards = new Set([first?.id, work?.id].filter((id): id is string => !!id));

  // Each company lists its first item not on a card, in brief order, with its own line.
  const names = [...new Set(companies.map((slug) => companyName(slug, labels)))].slice(0, 3);
  const shown = new Set(onCards);
  const sections = names.map((name): WelcomeEditionSection => {
    const mine = input.decisions.filter((d) => owner(d) === name);
    const next = mine.find((d) => !onCards.has(d.id));
    if (next) {
      shown.add(next.id);
      return { name, lines: [plainTitle(next, name), ...plainLines(next, plainTitle(next, name))] };
    }
    if (mine.length) return { name, lines: ["On the cards above."] };
    return { name, lines: ["Nothing new for you today."] };
  });

  const cards: WelcomeEditionCard[] = [];
  if (first) {
    cards.push({
      id: "decision",
      pill: "Your decision",
      kicker: owner(first),
      title: plainTitle(first, owner(first)),
      lines: plainLines(first, plainTitle(first, owner(first))),
      label: "Review the decision",
      action: launch(first, prompts),
    });
  }
  // The agenda card counts the distinct things on this page: a decision card and a project
  // row about the same piece of work (one thread) are one thing. Named by their companies.
  const onPage = input.decisions.filter((d) => shown.has(d.id));
  const things = new Set(onPage.map((d) => d.thread?.trim() || `id:${d.id}`));
  const shownNames = [...new Set(onPage.map(owner))];
  cards.push(dayCard(input, now, things.size, shownNames));
  if (work) {
    cards.push({
      id: "work",
      pill: null,
      kicker: `Pick up your work · ${owner(work)}`,
      title: plainTitle(work, owner(work)),
      lines: plainLines(work, plainTitle(work, owner(work))),
      label: "Pick it up",
      action: launch(work, prompts),
    });
  }

  return {
    zero: false,
    headline: welcomeGreeting(now, input.userName),
    sub: WELCOME_EDITION_SUB,
    cards,
    sections,
    note: editionNote(input),
  };
}
