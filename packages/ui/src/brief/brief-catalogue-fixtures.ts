/**
 * Fixture days for the catalogue and picker tests: the real 2026-10-11 run
 * (a Sunday), a quiet Saturday, a catch-up Thursday, and an "everything" day
 * on which every entry has evidence. Pinned to real dates; not read in production.
 */

import type { BriefDecision, BriefInput, BriefOrigin, BriefRisk } from "./brief-types.js";

const INDIGO = "cmp_indigo";
export const origin = (repo: string, product?: string): BriefOrigin => ({ companyUid: INDIGO, repo, ...(product ? { product } : {}) });
export const hoursAgo = (now: string, h: number) => new Date(Date.parse(now) - h * 3_600_000).toISOString();

export function decision(id: string, title: string, extra: Partial<BriefDecision> = {}): BriefDecision {
  return { id, title, summary: title, action: "decide", origin: origin("indigoai-us/hq-desktop-app", "Desktop app"), ...extra };
}

export function watch(id: string, title: string): BriefRisk {
  return { id, title, summary: `${title}.`, severity: "watch", links: [], origin: origin("indigoai-us/hq-core", "HQ core") };
}

export function empty(now: string, today: string): BriefInput {
  return {
    now,
    today,
    userName: "Corey",
    companies: [INDIGO, "indigo"],
    calendarToday: [],
    meetingsYesterday: [],
    decisions: [],
    actionItems: [],
    risks: [],
    shipped: [],
    waitingOn: [],
    team: [],
    sessions: [],
    lastBriefAt: hoursAgo(now, 24),
  };
}

/** The real 2026-10-11 run (a Sunday), shaped as the spec's worked day. */
export function octoberEleven(): BriefInput {
  const now = "2026-10-11T14:54:00.000Z";
  const products = ["hq-desktop-app", "hq-cloud", "hq-core-staging", "hq-pro", "hq-pro-agents", "hq-cli", "hq-deploy"];
  return {
    ...empty(now, "2026-10-11"),
    decisions: [
      decision("d1", "Close out the $20-cap SAFE allotment", { ageHours: 44, revenue: true, peopleWaiting: 3 }),
      decision("d2", "Answer Geoff on the pricing page", { ageHours: 20, source: "dms" }),
      decision("d3", "Decide what to do about the red release gate", { ageHours: 8, source: "main_health", origin: origin("indigoai-us/hq-core-staging", "HQ core") }),
      decision("d4", "Pick which signup fixes ship this week", { ageHours: 30, revenue: true }),
      decision("d5", "Approve the Ramen Bae proposal", { ageHours: 5 }),
    ],
    risks: [
      {
        id: "p1",
        title: "HQ Cloud nightly sync is red",
        summary: "The nightly sync workflow has failed for two days.",
        severity: "incident",
        links: [],
        origin: origin("indigoai-us/hq-cloud", "HQ Cloud"),
        ci: { repo: "hq-cloud", workflow: "nightly sync", job: null, since: null, ageHours: 48, note: null },
      },
      {
        id: "p2",
        title: "Unstick five fleet agents in setup",
        summary: "Five agents have sat in setup for three days.",
        severity: "incident",
        measure: { healthy: 90, total: 95, unit: "agents", cause: "setup phase" },
        links: [],
        origin: origin("indigoai-us/hq-pro-agents", "Fleet"),
      },
      watch("w1", "Staging can merge green and still break main"),
      watch("w2", "Three open changes of yours have sat for a day"),
      watch("w3", "The docs build warns on every run"),
      watch("w4", "Sync retries climbed overnight"),
    ],
    shipped: products.map((repo, i) => ({
      id: `ship:${repo}`,
      title: repo,
      status: `${i === 0 ? 11 : 2} merged`,
      note: "nothing open",
      origin: origin(`indigoai-us/${repo}`),
      lines: Array.from({ length: i === 0 ? 11 : 2 }, (_, k) => ({ label: `change ${k}`, state: "MERGED", tone: "ok" as const })),
      ...(i === 1 ? { first: true } : {}),
    })),
    merged: 23,
    opened: 9,
    team: [
      { id: "prs_geoff", name: "Geoff", doing: "Needs your call on pricing", tone: "decision" },
      { id: "prs_jonathan", name: "Jonathan", doing: "Waiting on the signup fixes", tone: "decision" },
      { id: "agt_izzy", name: "Izzy", doing: "Agent", tone: "neutral", isAgent: true },
    ],
    waitingOn: [],
    meetingsYesterday: [
      { id: "m1", title: "HQ Dev Standup", startTime: "2026-10-09T15:00:00.000Z", companyUid: INDIGO, decisions: 2, actions: 1, risks: 0, questions: 0 },
      { id: "m2", title: "Jacob / Corey", startTime: "2026-10-09T16:30:00.000Z", companyUid: INDIGO, decisions: 1, actions: 3, risks: 0, questions: 0 },
      { id: "m3", title: "Investor call", startTime: "2026-10-09T19:00:00.000Z", companyUid: INDIGO, decisions: 0, actions: 2, risks: 1, questions: 0 },
    ],
    recentSessions: Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      startedAt: hoursAgo(now, 2 + i * 3),
      workstream: "Work",
      company: INDIGO,
      product: ["Desktop app", "HQ Cloud", "HQ core"][i % 3],
    })),
    priorities: [
      { n: 1, text: "Close out the $20-cap SAFE allotment", because: "Investors and the round close wait on it", itemId: "d1" },
      { n: 2, text: "Pick which signup fixes ship this week", because: "Jonathan and Geoff are waiting on you", itemId: "d4" },
      { n: 3, text: "Approve the Ramen Bae proposal", because: "Revenue lands when you say go", itemId: "d5" },
      { n: 4, text: "Answer Geoff on the pricing page", because: "Geoff asked twice", itemId: "d2" },
      { n: 5, text: "Unstick five fleet agents in setup", because: "They have sat in setup for three days", itemId: "p2" },
    ],
  };
}

/** A quiet Saturday: two merges, one unchanged watch, two sessions. */
export function quietSaturday(): BriefInput {
  const now = "2026-10-17T14:00:00.000Z";
  const base = empty(now, "2026-10-17");
  return {
    ...base,
    shipped: [{ id: "ship:hq-cli", title: "hq-cli", status: "2 merged", note: "nothing open", origin: origin("indigoai-us/hq-cli", "CLI"), lines: [] }],
    merged: 2,
    risks: [watch("w1", "Staging can merge green and still break main")],
    recentSessions: [
      { id: "s1", title: "Weekend fix", startedAt: hoursAgo(now, 3), workstream: "Work", company: INDIGO },
      { id: "s2", title: "Reading", startedAt: hoursAgo(now, 6), workstream: "Work", company: INDIGO },
    ],
    previous: { runId: "brief-20261016", hashes: { risk: "w1" } },
  };
}

/** Catch-up Thursday after four days away. */
export function catchUpThursday(): BriefInput {
  const now = "2026-10-15T13:00:00.000Z";
  const base = empty(now, "2026-10-15");
  return {
    ...base,
    lastBriefAt: hoursAgo(now, 4 * 24),
    decisions: [decision("d1", "Approve the Q4 plan"), decision("d2", "Pick the launch date")],
    priorities: [
      { n: 1, text: "Approve the Q4 plan", because: "The team plans around it", itemId: "d1" },
      { n: 2, text: "Pick the launch date", because: "Marketing waits", itemId: "d2" },
    ],
    meetingsYesterday: Array.from({ length: 9 }, (_, i) => ({
      id: `m${i}`,
      title: `Meeting ${i}`,
      startTime: hoursAgo(now, 10 + i * 8),
      companyUid: INDIGO,
      decisions: 1,
      actions: 1,
      risks: 0,
      questions: 0,
      decided: [`Decision from meeting ${i}`],
      todo: i < 2 ? [{ text: `Follow up ${i}`, mine: true }] : [],
    })),
    carry: [
      { id: "c1", title: "Reply to the auditor", why: "Still open", origin: origin("Indigo"), carriedFrom: "brief-20261010", carriedSince: "2026-10-10", briefs: 2, itemId: null },
    ],
    days: [
      { date: "2026-10-11", sessions: 6, meetings: 0, merged: 23, opened: 9, beat: { kind: "push", label: "Sunday push" } },
      { date: "2026-10-12", sessions: 4, meetings: 3, merged: 10, opened: 4 },
      { date: "2026-10-13", sessions: 5, meetings: 2, merged: 8, opened: 3, beat: { kind: "turn", label: "Pricing turn" } },
      { date: "2026-10-14", sessions: 3, meetings: 4, merged: 4, opened: 2 },
    ],
    shipped: [{ id: "ship:hq-pro", title: "hq-pro", status: "4 merged", note: "nothing open", origin: origin("indigoai-us/hq-pro", "HQ Pro"), lines: [] }],
    merged: 45,
  };
}

/** Every entry has evidence: the not-built kinds too, so their facts and reasons get linted. */
export function everything(): BriefInput {
  const base = octoberEleven();
  const now = "2026-10-14T13:00:00.000Z";
  return {
    ...base,
    now,
    today: "2026-10-14",
    lastBriefAt: hoursAgo(now, 24),
    decisions: [
      ...base.decisions.map((d) => ({ ...d, blocks: d.id === "d1" ? [{ who: "Jonathan", what: "the round close", kind: "person" as const }] : d.blocks })),
      decision("d6", "Cut the Desktop app release", { action: "cut", source: "prs", detail: { why: "Pending changes", unlocks: [{ label: "Users get the fix", state: "" }], source: "prs" } }),
    ],
    calendarToday: [
      { id: "c1", title: "Standup", start: hoursAgo(now, -1), end: hoursAgo(now, -1.5), kind: "team" },
      { id: "c2", title: "Investor call", start: hoursAgo(now, -4), end: hoursAgo(now, -4.5), kind: "ext" },
      { id: "c3", title: "Advisory", start: hoursAgo(now, -6), end: hoursAgo(now, -6.5), kind: "ext" },
    ],
    waitingOn: [{ id: "wt1", who: "Jacob", what: "to take the memo folder", ageHours: 30 }],
    meetingsYesterday: [
      { id: "m1", title: "HQ Dev Standup", startTime: hoursAgo(now, 20), companyUid: INDIGO, decisions: 2, actions: 1, risks: 0, questions: 0, decided: ["Ship Friday", "Drop the old flow"] },
      { id: "m2", title: "Jacob / Corey", startTime: hoursAgo(now, 18), companyUid: INDIGO, decisions: 1, actions: 3, risks: 0, questions: 0, decided: ["Hire a closer"], todo: [{ text: "Write the FAQ", mine: true }] },
    ],
    carry: [
      { id: "c1", title: "Reply to the auditor", why: "Still open", origin: origin("Indigo"), carriedFrom: "brief-20261010", carriedSince: "2026-10-10", briefs: 2, itemId: null },
      { id: "c2", title: "Pricing page", why: "Linked", origin: origin("Indigo"), carriedFrom: "brief-20261013", carriedSince: "2026-10-13", briefs: 1, itemId: "d2" },
    ],
    handoffs: [
      { id: "h1", object: "the billing fix", from: "Corey", to: "Hassaan", me: true, production: true, since: hoursAgo(now, 6), receipts: { access: true, ack: null, active: null }, origin: origin("indigoai-us/hq-pro", "HQ Pro") },
    ],
    releases: [
      { product: "Desktop app", version: "1.4", origin: origin("indigoai-us/hq-desktop-app", "Desktop app"), releasedAt: hoursAgo(now, 70), pending: [{ day: "2026-10-13", count: 4, theme: "fixes" }], pendingCount: 4, held: [], light: "warn" },
    ],
    recovered: [{ id: "r1", title: "Staging main is green again", what: "The release gate passed", at: hoursAgo(now, 5), source: "main_health", origin: origin("indigoai-us/hq-core-staging", "HQ core") }],
    fleetIncident: {
      id: "fi1",
      series: [{ at: hoursAgo(now, 48), stuck: 9 }, { at: hoursAgo(now, 2), stuck: 3 }],
      incidentStart: hoursAgo(now, 72),
      incidentEnd: null,
      verdict: "healing",
      stillStuck: [{ name: "scout", reason: "setup", since: hoursAgo(now, 40) }],
      fixes: [],
    },
    days: catchUpThursday().days,
    reminders: [{ id: "rm1", text: "call the bank before Thursday", saidAt: hoursAgo(now, 30), where: "HQ Dev Standup", dueAt: hoursAgo(now, -6) }],
    recentSessions: Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      startedAt: hoursAgo(now, 1 + i),
      workstream: "Work",
      company: INDIGO,
      product: ["Desktop app", "HQ Cloud", "HQ core", "CLI"][i % 4],
    })),
  };
}

