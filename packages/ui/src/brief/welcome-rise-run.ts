/**
 * The captured welcome rise and the brief it hands off to.
 * One run: the same findings, the same session counts, Saturday 17 October 2026.
 * Not sample data. The harness and the handoff test both read this module.
 */

import type { BriefDecision, BriefInput, BriefSession } from "./brief-types.js";
import type { RiseSource } from "./brief-rise.js";

export const WELCOME_RISE_TODAY = "2026-10-17";
export const WELCOME_RISE_FINDING_CLAUDE = "Keep the offline installer in the first release.";
export const WELCOME_RISE_FINDING_CODEX = "PR #248 · Restore offline install is ready for review.";
export const WELCOME_RISE_FINDING_REPOS = "WelcomeReport.svelte still needs the new empty state.";
export const WELCOME_RISE_CALENDAR_LINE = "Calendar could not be read.";
/** Distinct from the failure line, so a priority row does not repeat it. */
export const WELCOME_RISE_CALENDAR_DETAIL = "This brief has no calls.";

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

/** Local 9:00 so the weekday stays Saturday, October 17 in any timezone. */
export function welcomeRiseNow(): Date {
  return new Date(2026, 9, 17, 9, 0, 0);
}

function sessionsFor(sourceId: "claude" | "codex", n: number, now: Date): BriefSession[] {
  const start = now.getTime() - 48 * 3_600_000;
  const title = sourceId === "claude" ? "Claude Code" : "Codex";
  return Array.from({ length: n }, (_, i) => ({
    id: `${sourceId}-${i}`,
    title,
    startedAt: new Date(start + i * 1000).toISOString(),
    workstream: title,
    company: COMPANY,
  }));
}

/** The brief after this rise. Findings are the rise quotes. Nothing is marked sample. */
export function welcomeRiseBriefInput(now: Date = welcomeRiseNow()): BriefInput {
  const origin = { companyUid: COMPANY, repo: "northstar/desktop", product: "Desktop app" };
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
      summary: "northstar/desktop",
      action: "go",
      origin,
    },
    {
      id: "rise-repos",
      title: WELCOME_RISE_FINDING_REPOS,
      summary: "apps/desktop/src/brief",
      action: "go",
      origin,
    },
    {
      id: "rise-calendar",
      title: WELCOME_RISE_CALENDAR_LINE,
      summary: WELCOME_RISE_CALENDAR_DETAIL,
      action: "go",
      origin: { companyUid: COMPANY, repo: "Calendar" },
    },
  ];
  return {
    now: now.toISOString(),
    today: WELCOME_RISE_TODAY,
    userName: "Alex",
    companies: [COMPANY],
    calendarToday: [],
    meetingsYesterday: [],
    decisions,
    actionItems: [],
    risks: [],
    shipped: [],
    waitingOn: [],
    team: [],
    sessions: [...sessionsFor("claude", 168, now), ...sessionsFor("codex", 244, now)],
    lastBriefAt: null,
    calendarSample: false,
    priorities: decisions.map((item, index) => ({
      n: index + 1,
      text: item.title,
      because: item.summary,
      itemId: item.id,
    })),
  };
}
