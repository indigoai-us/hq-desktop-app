/**
 * The captured welcome rise and the brief it hands off to.
 * One run: the same findings, the same session counts, Saturday 17 October 2026.
 * Not sample data. The harness and the handoff test both read this module.
 */

import type { BriefDecision, BriefInput, BriefSession } from "./brief-types.js";
import { riseFrame, riseRevealAt, type RiseSource } from "./brief-rise.js";

export const WELCOME_RISE_TODAY = "2026-10-17";
export const WELCOME_RISE_FINDING_CLAUDE = "Keep the offline installer in the first release.";
export const WELCOME_RISE_FINDING_CODEX = "PR #248 · Restore offline install is ready for review.";
export const WELCOME_RISE_FINDING_REPOS = "WelcomeReport.svelte still needs the new empty state.";
export const WELCOME_RISE_CALENDAR_LINE = "Calendar could not be read.";
/** The pick-up card's plain title for the repos finding. A filename is never a headline. */
export const WELCOME_RISE_WORK_TITLE = "Finish the welcome state.";
export const WELCOME_RISE_FIELDWORK_TITLE = "Monday's research plan";
export const WELCOME_RISE_STUDIO_TITLE = "Homepage copy · revision 4";

export const WELCOME_RISE_SOURCES: RiseSource[] = [
  {
    id: "claude",
    label: "Claude Code",
    icon: "claude",
    counts: { sessions: 168 },
    finding: WELCOME_RISE_FINDING_CLAUDE,
    detail: "Session · Yesterday, 4:42 PM",
  },
  {
    id: "codex",
    label: "Codex",
    icon: "codex",
    counts: { sessions: 244, repos: 3 },
    finding: WELCOME_RISE_FINDING_CODEX,
    detail: "northstar/desktop",
  },
  {
    id: "calendar",
    label: "Calendar",
    counts: {},
    finding: "",
    failed: true,
    failureLine: WELCOME_RISE_CALENDAR_LINE,
  },
  {
    id: "repos",
    label: "Repos",
    counts: { repos: 3 },
    finding: WELCOME_RISE_FINDING_REPOS,
    detail: "apps/desktop/src/brief",
  },
];

const COMPANY = "northstar";
/** The run's projects, as the mockup's project row shows them. */
export const WELCOME_RISE_COMPANIES = [COMPANY, "fieldwork", "studio"];

/** The count line the reveal ends on, once every source has been read ("412 sessions read · 6 repos"). */
export function welcomeRiseRunStats(): string {
  return riseFrame(riseRevealAt(WELCOME_RISE_SOURCES.length - 1), WELCOME_RISE_SOURCES).countText;
}

function sourceSessions(id: "claude" | "codex"): number {
  return WELCOME_RISE_SOURCES.find((s) => s.id === id)?.counts.sessions ?? 0;
}

/** Local 9:00 so the weekday stays Saturday, October 17 in any timezone. */
export function welcomeRiseNow(): Date {
  return new Date(2026, 9, 17, 9, 0, 0);
}

function sessionsFor(sourceId: "claude" | "codex", n: number, now: Date): BriefSession[] {
  // Spread across the last 24 hours, so the sunrise card counts the same sessions the rise read.
  const start = now.getTime() - 20 * 3_600_000;
  const title = sourceId === "claude" ? "Claude Code" : "Codex";
  return Array.from({ length: n }, (_, i) => ({
    id: `${sourceId}-${i}`,
    title,
    startedAt: new Date(start + i * 360_000).toISOString(),
    workstream: title,
    company: COMPANY,
  }));
}

/** The brief after this rise. Findings are the rise quotes. Nothing is marked sample. */
export function welcomeRiseBriefInput(now: Date = welcomeRiseNow()): BriefInput {
  // The welcome edition belongs to the person, so its rows carry no company badge (no "NO" initials).
  const origin = { companyUid: null, repo: "northstar/desktop", product: "Desktop app" };
  const decisions: BriefDecision[] = [
    {
      id: "rise-claude",
      title: WELCOME_RISE_FINDING_CLAUDE,
      summary: "Session, yesterday at 4:42 PM.",
      action: "go",
      origin,
    },
    {
      id: "rise-codex",
      title: WELCOME_RISE_FINDING_CODEX,
      summary: "Review ready · 1 decision",
      action: "go",
      origin,
    },
    {
      id: "rise-fieldwork",
      title: WELCOME_RISE_FIELDWORK_TITLE,
      summary: "Maya added 3 interview notes.",
      action: "go",
      origin: { companyUid: "fieldwork", repo: null, product: "Research" },
    },
    {
      id: "rise-studio",
      title: WELCOME_RISE_STUDIO_TITLE,
      summary: "Jordan's wording is ready to read.",
      action: "go",
      origin: { companyUid: "studio", repo: null, product: "Homepage" },
    },
    {
      // The repos finding names a file; the card says what the work is.
      id: "rise-repos",
      title: WELCOME_RISE_WORK_TITLE,
      summary: "The zero-company view is the last open item.",
      action: "go",
      origin,
    },
  ];
  return {
    now: now.toISOString(),
    today: WELCOME_RISE_TODAY,
    userName: "Alex",
    companies: [...WELCOME_RISE_COMPANIES],
    calendarToday: [],
    meetingsYesterday: [],
    decisions,
    actionItems: [],
    risks: [],
    shipped: [],
    waitingOn: [],
    team: [],
    // The brief counts every session the reveal ends on, so the handoff never jumps (round 3).
    sessions: [...sessionsFor("claude", sourceSessions("claude"), now), ...sessionsFor("codex", sourceSessions("codex"), now)],
    runStats: welcomeRiseRunStats(),
    lastBriefAt: null,
    calendarSample: false,
    // A source that could not be read is a quiet note, never a priority or a decision.
    sourceNotes: [WELCOME_RISE_CALENDAR_LINE],
    priorities: decisions.map((item, index) => ({
      n: index + 1,
      text: item.title,
      because: item.summary,
      itemId: item.id,
    })),
  };
}
