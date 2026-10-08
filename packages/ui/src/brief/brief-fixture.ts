/**
 * The approved mockup's Oct 8 day as a `BriefInput`. Used by the dev harness
 * (`pnpm dev:preview`) and by tests. Not read in production.
 */

import type { BriefInput, BriefOrigin } from "./brief-types.js";

const INDIGO = "cmp_indigo";
const LIVERECOVER = "cmp_liverecover";
const indigo = (repo: string): BriefOrigin => ({ companyUid: INDIGO, repo });

/** Today at hh:mm local, as ISO, relative to `now`. */
function at(now: Date, hh: number, mm: number, dayOffset = 0): string {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

export function octoberEightBrief(now: Date = new Date()): BriefInput {
  return {
    now: now.toISOString(),
    userName: "Corey",
    companies: [INDIGO, LIVERECOVER, "indigo", "liverecover"],
    calendarToday: [
      { id: "c1", title: "Dev standup", start: at(now, 9, 0), end: at(now, 9, 30), kind: "team" },
      { id: "c2", title: "HQ and Sales sync", start: at(now, 9, 0), end: at(now, 9, 45), kind: "team" },
      { id: "c3", title: "Zach and Jeff onboarding", start: at(now, 10, 0), end: at(now, 11, 0), kind: "ext" },
      { id: "c4", title: "Cut30 office hours", start: at(now, 13, 0), end: at(now, 14, 0), kind: "learn" },
      { id: "c5", title: "Getting started with HQ", start: at(now, 16, 0), end: at(now, 17, 0), kind: "learn", projected: true },
    ],
    meetingsYesterday: [
      { id: "m1", title: "Onboarding", with: "Zach and Jeff", startTime: at(now, 10, 0, -1), companyUid: INDIGO, decisions: 3, actions: 2, risks: 0, questions: 1, summary: "A customer onboarding call you ran. Its decisions and the summary are in HQ meeting notes." },
      { id: "m2", title: "Sales sync", startTime: at(now, 9, 0, -1), companyUid: INDIGO, decisions: 3, actions: 1, risks: 1, questions: 0, summary: "Weekly pipeline sync with Jacob. Key points and decisions were captured as signals." },
      { id: "m3", title: "Dev standup", startTime: at(now, 9, 0, -1), companyUid: INDIGO, decisions: 3, actions: 0, risks: 1, questions: 0, summary: "Daily dev standup. Decisions and a summary were captured as signals." },
    ],
    decisions: [
      {
        id: "d1",
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
      {
        id: "r1",
        title: "Fleet boxes stuck",
        summary: "Disks are full.",
        severity: "incident",
        measure: { healthy: 9, total: 95, unit: "boxes", cause: "STUCK · DISK FULL" },
        links: [
          { label: "hq-cloud/913", origin: indigo("indigoai-us/hq-cloud") },
          { label: "hq-pro-agents/1132", origin: indigo("indigoai-us/hq-pro-agents") },
        ],
        origin: indigo("indigoai-us/hq-cloud"),
      },
      {
        id: "r2",
        title: "Staging can merge green and still break main.",
        summary: "18 required checks. One is red on main since 1156 and is not required.",
        severity: "watch",
        links: [],
        origin: indigo("indigoai-us/hq-core-staging"),
      },
    ],
    shipped: [
      {
        id: "s1",
        title: "Desktop beta",
        status: "3 PRs merged",
        note: "1501, 1502, 1504 open",
        origin: indigo("indigoai-us/hq-desktop-app"),
        lines: [
          { label: "1499 Desktop beta fix", state: "MERGED", tone: "ok" },
          { label: "1500 Desktop beta fix", state: "MERGED", tone: "ok" },
          { label: "1477 Desktop beta fix", state: "MERGED", tone: "ok" },
          { label: "1501, 1502, 1504", state: "OPEN", tone: "warn" },
        ],
      },
      {
        id: "s2",
        title: "Staging",
        status: "3 merges landed",
        note: "Bot parity measured",
        origin: indigo("indigoai-us/hq-core-staging"),
        lines: [
          { label: "1173 Staging merge", state: "MERGED", tone: "ok" },
          { label: "1177 Staging merge", state: "MERGED", tone: "ok" },
          { label: "1174 Staging merge", state: "MERGED", tone: "ok" },
          { label: "HP-11 bot parity", state: "MEASURED", tone: "ok" },
        ],
      },
      {
        id: "s3",
        title: "Investor memo",
        status: "Live, company-gated",
        note: "Comment loop on",
        origin: indigo("Indigo · deploy"),
        lines: [
          { label: "Company access on", state: "LIVE", tone: "ok" },
          { label: "Comment loop", state: "ON", tone: "ok" },
        ],
      },
      {
        id: "s4",
        title: "Conduct v16",
        status: "On by default",
        note: "PR 1217 open",
        origin: indigo("indigoai-us/hq-core-staging"),
        lines: [
          { label: "1217 Conduct on by default in v16", state: "OPEN", tone: "warn" },
          { label: "Bot and fleet gate", state: "DESIGNED", tone: "ok" },
        ],
      },
      {
        id: "s5",
        title: "Grok hooks",
        status: "1.0.40 contract",
        note: "PR 1204 open",
        origin: indigo("indigoai-us/hq-core-staging"),
        lines: [{ label: "1204 Grok 1.0.40 hook contract", state: "OPEN", tone: "warn" }],
      },
      {
        id: "s6",
        title: "Pluto",
        status: "Now yours",
        note: "Live in prod, dark",
        origin: { companyUid: LIVERECOVER, repo: "LiveRecover Supply" },
        lines: [
          { label: "Pluto handed from Yousuf", state: "YOURS", tone: "decision" },
          { label: "LiveRecover Supply", state: "LIVE · DARK", tone: "warn" },
        ],
      },
    ],
    merged: 6,
    opened: 8,
    waitingOn: [
      { id: "w1", who: "Jacob", what: "to take the memo folder" },
      { id: "w2", who: "Hassaan", what: "to review PR 1201" },
    ],
    team: [
      { id: "t1", name: "Izzy", doing: "X mentions ready, 1 needs you", tone: "decision", detail: { status: "Needs one thing from you", between: [{ label: "Reply to 1 X mention", state: "YOU", tone: "decision" }, { label: "Investor memo folder moved to Jacob", state: "DONE", tone: "ok" }], owns: ["X mentions dry run (3 found)", "Investor memo distribution"], next: "Send the X reply, then Izzy can run the mentions bot for real." } },
      { id: "t2", name: "Hassaan", doing: "Reviewing your handoff PR", tone: "warn", detail: { status: "You are waiting on him", between: [{ label: "Review of PR 1201, self-improving handoff", state: "HIS", tone: "warn" }], owns: ["HQ 16 staging cleanup", "Liveops and support decisions"], next: "Ping if 1201 is still in review by noon." } },
      { id: "t3", name: "Jacob", doing: "Traction deck is live", tone: "ok", detail: { status: "Shipped yesterday", between: [{ label: "Acknowledge memo folder ownership", state: "HIS", tone: "warn" }], owns: ["HQ traction deck, live"], next: "Worth a thank-you for the deck." } },
      { id: "t4", name: "Stefan", doing: "Took over liveops", tone: "ok", detail: { status: "New role", between: [{ label: "Skill-metadata check red on staging main since 1156", state: "RISK", tone: "red" }], owns: ["Liveops (took over yesterday)", "New-bot sunrise animation in the desktop app"], next: "Ask whether the red check blocks the release you are about to cut." } },
      { id: "t5", name: "Yousuf", doing: "Handed you Pluto, live and dark", tone: "decision", detail: { status: "Handed you work", between: [{ label: "Pluto advocacy graph is now yours", state: "YOU", tone: "decision" }], owns: ["Advocacy graph, live for LiveRecover Supply, dark"], next: "Decide when Pluto turns on for the customer." } },
      { id: "t6", name: "Shawon", doing: "Testing the mobile build", tone: "ok", detail: { status: "Heads down", between: [], owns: ["Mobile build testing"], next: "Nothing needs you." } },
    ],
    sessions: [
      ["13:40", "Bot parity + staging merges", "HQ core"],
      ["14:22", "Self-improving handoff", "HQ core"],
      ["14:30", "Grok hook contract", "HQ core"],
      ["14:48", "Fleet rescue", "Fleet"],
      ["16:07", "Daily brief design", "Design"],
      ["19:03", "Investor memo", "Investors"],
      ["19:46", "Conduct on by default", "HQ core"],
      ["20:30", "Desktop beta fixes", "Desktop"],
    ].map(([time, title, workstream], i) => {
      const [h, m] = time!.split(":").map(Number);
      return { id: `sess-${i}`, title: title!, workstream: workstream!, startedAt: at(now, h!, m!, -1), company: INDIGO };
    }),
    lastBriefAt: new Date(now.getTime() - 86_400_000).toISOString(),
    dmCount: 6,
  };
}
