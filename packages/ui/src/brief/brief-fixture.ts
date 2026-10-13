/**
 * The preview day: Oct 8, 2026, built from a REAL morning sweep
 * (`fixtures/sweep-2026-10-08.json`, generated from brief-data.json by
 * `scripts/brief-sweep-fixture.mjs`). Shipped, PR totals, meetings and their
 * signal counts, fleet, main CI and DM senders are real. Decision text,
 * waits, the standing risk and today's calendar have no sweep source yet, so
 * they are illustrative and carry `sample: true` (shown as SAMPLE).
 * Used by the dev harness and tests. Not read in production.
 */

import type { BriefInput, BriefOrigin } from "./brief-types.js";
import { sweepToInput, type BriefSweep } from "./brief-sweep.js";
import sweepJson from "./fixtures/sweep-2026-10-08.json";

export const FIXTURE_DAY = "2026-10-08";
const INDIGO = "cmp_indigo";
const LIVERECOVER = "cmp_liverecover";
const indigo = (repo: string): BriefOrigin => ({ companyUid: INDIGO, repo });

/** Today at hh:mm local, as ISO, relative to `now`. */
function at(now: Date, hh: number, mm: number): string {
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

export function octoberEightBrief(now: Date = new Date()): BriefInput {
  const real = sweepToInput(sweepJson as unknown as BriefSweep, { day: FIXTURE_DAY, companyUid: INDIGO, selfName: "Corey Epstein" });
  return {
    ...real,
    calendarSample: true,
    now: now.toISOString(),
    userName: "Corey",
    companies: [INDIGO, LIVERECOVER, "indigo", "liverecover"],
    // Copied from the owner's real Oct 9 calendar (Meetings day view), with the
    // free/busy holds the feed sends alongside: two cover named events and are
    // dropped by the strip, one stands alone.
    calendarToday: [
      { id: "c1", title: "VYG Standup", start: at(now, 7, 30), end: at(now, 8, 0), kind: "team" },
      { id: "c2", title: "HQ Dev Standup", start: at(now, 9, 0), end: at(now, 10, 0), kind: "team" },
      { id: "b1", title: "Busy", start: at(now, 9, 0), end: at(now, 10, 0), kind: "team", busy: true },
      { id: "c3", title: "Jacob / Corey", start: at(now, 9, 30), end: at(now, 10, 0), kind: "team" },
      { id: "c4", title: "HQ Training Series", start: at(now, 11, 0), end: at(now, 11, 45), kind: "learn" },
      { id: "c5", title: "HQ Founder Office Hours", start: at(now, 12, 0), end: at(now, 13, 0), kind: "learn" },
      { id: "b2", title: "Busy", start: at(now, 12, 0), end: at(now, 13, 0), kind: "team", busy: true },
      { id: "c6", title: "Jordan Menard / Corey Epstein", start: at(now, 13, 15), end: at(now, 13, 30), kind: "ext", tentative: true },
      { id: "c7", title: "Lizzie / Corey Epstein – HQ Advisory", start: at(now, 14, 0), end: at(now, 14, 30), kind: "ext", attendees: ["Lizzie"] },
      { id: "c8", title: "30 Min Video/Phone Meeting w/ Rachel Bell", start: at(now, 15, 30), end: at(now, 16, 0), kind: "ext", joinUrl: "https://zoom.us/j/000" },
      { id: "b3", title: "Busy", start: at(now, 16, 30), end: at(now, 17, 0), kind: "team", busy: true },
    ],
    decisions: [
      {
        id: "d1",
        sample: true,
        title: "Cut the hq-core release",
        summary: "Carries staging main 703ed75 and the planning merge",
        action: "cut",
        actionLabel: "Cut it",
        origin: indigo("indigoai-us/hq-core"),
        detail: {
          why: "The release carries staging main 703ed7563: the planning merge (PRs 1150 to 1167) and the check repairs from 1171.",
          unlocks: [
            { label: "Docs PR 64 can merge", state: "NEXT", tone: "decision" },
            { label: "Glossary rename reaches users", state: "RELEASE", tone: "ok" },
          ],
          risk: "Stefan flagged the red skill-metadata check on staging main. Confirm it is non-required.",
          source: "Signal · action item · Oct 7 staging run",
        },
      },
      {
        id: "d2",
        sample: true,
        title: "Release indigo-docs PR 64",
        summary: "Held until that release ships, on your go",
        action: "go",
        actionLabel: "Go",
        origin: indigo("indigoai-us/indigo-docs"),
        detail: {
          why: "indigo-docs PR 64 documents the planning merge. It was held so docs never describe unreleased commands.",
          unlocks: [{ label: "Docs match the shipped release", state: "AFTER CUT", tone: "ok" }],
          risk: "Merging before the release cut would document /grill-me before users have it.",
          source: "Signal · decision · Oct 7",
        },
      },
      {
        id: "d3",
        sample: true,
        title: "Keep the no-self-merge rule?",
        summary: "Open question from the staging run",
        action: "decide",
        choices: ["Keep", "Retire"],
        origin: indigo("indigoai-us/hq-core-staging"),
        detail: {
          why: "Item 4 of the staging PR rules says no self-merge and review required. The owner has since said teams merge and release themselves.",
          unlocks: [{ label: "Rule matches how the team works", state: "POLICY", tone: "ok" }],
          risk: "Keeping it slows every staging PR.",
          source: "Signal · question · Oct 7",
        },
      },
      {
        id: "d4",
        sample: true,
        title: "Reply to 1 X mention",
        summary: "Flagged by Izzy's mentions dry run",
        action: "reply",
        origin: { companyUid: INDIGO, repo: "Indigo on X" },
        detail: {
          why: "Izzy's X mentions dry run found 3 mentions. One asks a question and needs a human reply.",
          unlocks: [{ label: "Mentions bot can go live", state: "IZZY", tone: "ok" }],
          risk: "Low. It ages after a day.",
          source: "DM · Izzy",
        },
      },
    ],
    actionItems: [
      { id: "a1", title: "Confirm the red staging check is non-required", origin: indigo("indigoai-us/hq-core-staging") },
      { id: "a2", title: "Thank Jacob for the traction deck", origin: indigo("Indigo") },
    ],
    risks: [
      ...real.risks,
      {
        id: "r2",
        sample: true,
        title: "Staging can merge green and still break main.",
        summary: "Required checks can pass while a non-required check is red on main.",
        severity: "watch",
        links: [],
        origin: indigo("indigoai-us/hq-core-staging"),
      },
    ],
    waitingOn: [
      { id: "w1", sample: true, who: "Jacob", what: "to take the memo folder" },
      { id: "w2", sample: true, who: "Hassaan", what: "to review PR 1201" },
    ],
    lastBriefAt: new Date(now.getTime() - 86_400_000).toISOString(),
  };
}
