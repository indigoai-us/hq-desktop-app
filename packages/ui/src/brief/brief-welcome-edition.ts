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

/** The next event still ahead today, else the first of the day. */
function nextEvent(events: readonly BriefCalendarEvent[], now: Date): BriefCalendarEvent | null {
  const real = events.filter((e) => !e.busy && e.title.trim());
  const ahead = real.filter((e) => Date.parse(e.start) >= now.getTime());
  return ahead[0] ?? real[0] ?? null;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function dayCard(input: BriefInput, now: Date): WelcomeEditionCard {
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
  const failed = (input.sourceNotes ?? []).some((n) => /calendar/i.test(n));
  if (failed) {
    return {
      id: "day",
      pill: null,
      kicker: "Today · Personal",
      title: "Your calendar can wait.",
      lines: ["Calendar could not be read. Your brief uses the other sources."],
      label: "Open Meetings",
      action: { kind: "meetings" },
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
    };
  }

  const lead = companyName(companies[0]!, labels);
  const [first, ...rest] = input.decisions;
  const work = rest.length ? rest[rest.length - 1]! : null;
  const cards: WelcomeEditionCard[] = [];
  if (first) {
    cards.push({
      id: "decision",
      pill: "Your decision",
      kicker: lead,
      title: first.title,
      lines: [first.summary].filter((l) => l.trim()),
      label: "Review the decision",
      action: launch(first, prompts),
    });
  }
  cards.push(dayCard(input, now));
  if (work) {
    cards.push({
      id: "work",
      pill: null,
      kicker: `Pick up your work · ${lead}`,
      title: work.title,
      lines: [work.summary].filter((l) => l.trim()),
      label: "Pick it up",
      action: launch(work, prompts),
    });
  }

  // Items not on a card, in brief order, go under the first company.
  const onCards = new Set([first?.id, work?.id]);
  const others = input.decisions.filter((d) => !onCards.has(d.id));
  const open = input.decisions.length;
  const sections = companies.slice(0, 3).map((slug, i): WelcomeEditionSection => {
    const name = companyName(slug, labels);
    if (i > 0) return { name, lines: ["Nothing new for you today."] };
    const lines = others.slice(0, 1).map((d) => d.title);
    lines.push(`${open} open item${open === 1 ? "" : "s"} for you`);
    return { name, lines };
  });

  return {
    zero: false,
    headline: welcomeGreeting(now, input.userName),
    sub: WELCOME_EDITION_SUB,
    cards,
    sections,
  };
}
