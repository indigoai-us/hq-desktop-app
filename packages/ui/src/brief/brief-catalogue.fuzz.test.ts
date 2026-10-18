/**
 * Seeded fuzz over generated days (spec section 14). A mulberry32 stream
 * builds 300 BriefInputs with every list the catalogue reads, from empty
 * weekends to catch-up days with everything on fire, and asserts the picker's
 * invariants on each: hero in slot a, no holes, every placed pair coexists,
 * density 1..8 equal to the widgets placed, hidden kinds never shown, every
 * widget fits its slot (or widens into it), every priority with a decision or
 * incident id hosted by a card, no fleet or other-company kind, every reason
 * passing the lint, and the same plan under key-order and list shuffles.
 *
 * Names and titles are invented. Changing the seed or the generator changes
 * which days run; the invariants must hold for all of them.
 */

import { describe, expect, it } from "vitest";
import {
  CATALOGUE,
  CATCH_UP_DENSITY,
  MAX_DENSITY,
  PAIRS,
  QUIET_TEMPLATES,
  TEMPLATES,
  VARIANTS,
  buildContext,
  digest,
  entryOf,
  fitsSlot,
  lintReason,
  reasonFor,
  type Placed,
} from "./brief-catalogue.js";
import { generateBrief, type BriefPlan } from "./brief-generate.js";
import { briefPriorities } from "./brief-peeks.js";
import type {
  BriefCalendarEvent,
  BriefCarry,
  BriefDecision,
  BriefHandoff,
  BriefInput,
  BriefMeeting,
  BriefOrigin,
  BriefPrefs,
  BriefPriority,
  BriefRecovered,
  BriefRelease,
  BriefReminder,
  BriefRisk,
  BriefSession,
  BriefShipped,
  BriefTeammate,
  BriefWaiting,
  BriefWidgetKind,
} from "./brief-types.js";

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** mulberry32: a small, well-distributed 32-bit PRNG. Same seed, same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Uniform float in [0, 1). */
  f(): number {
    return this.next();
  }
  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.f() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.f() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.f() * xs.length)]!;
  }
  /** Up to n distinct items of xs, in a random order. */
  some<T>(xs: readonly T[], n: number): T[] {
    return this.shuffle(xs).slice(0, Math.min(n, xs.length));
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.f() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}

// ---------------------------------------------------------------------------
// Invented vocabulary (no slashes, no numbers with #, no sentence-ending periods)
// ---------------------------------------------------------------------------

const COMPANY = "cmp_northwind";
const PEOPLE = ["Avery", "Blake", "Casey", "Devon", "Emery", "Finley", "Harper", "Jordan", "Morgan", "Quinn"];
const PRODUCTS = ["Ledger", "Beacon", "Compass", "Dispatch", "Ember", "Forge", "Grove", "Harbor"];
const DECISION_TITLES = [
  "Approve the budget line",
  "Pick the launch date",
  "Answer the pricing question",
  "Clear the red release gate",
  "Sign the vendor renewal",
  "Choose the onboarding fixes",
  "Approve the pilot proposal",
  "Decide on the second region",
  "Reply to the auditor",
  "Cut the next release",
  "Keep the no-self-merge rule?",
  "Pick a date for the offsite",
];
const INCIDENT_TITLES = ["Nightly sync is red", "Checkout webhooks are failing", "Four worker agents are stalled", "The login page times out"];
const WATCH_TITLES = [
  "Two of your open changes have waited since Thursday",
  "The docs build prints a warning on every run",
  "Sync retries doubled overnight",
  "One release gate check is not marked required",
  "Trial signups dipped this week",
  "The staging database is nearly full",
];
const WORKFLOWS = ["nightly sync", "release gate", "webhook relay", "smoke tests"];
const MEETING_TITLES = ["Weekly product review", "Design review", "Partner check-in", "Support review", "Hiring sync", "Finance check-in", "Monday planning", "Launch sync"];
const DECIDED = ["Ship the welcome page this week", "Hold the pricing change", "Open the designer role", "Move billing to monthly", "Keep the two-column layout"];
const TODOS = ["Write the quarter memo", "Send the layout notes", "Draft the launch post", "Book the offsite venue"];
const EVENTS = ["Standup", "Investor update", "Advisory call", "Customer demo", "Board prep", "Lunch with the team"];
const WAITS = ["to review the pricing page", "to send the memo folder", "to confirm the launch date", "to reply to your note"];
const BLOCKED_WORK = ["the renewal paperwork", "the onboarding plan", "the launch post", "the second region rollout"];
const REMINDERS = ["call the bank on Thursday", "send the deck before the demo", "ask about the venue deposit"];
const RECOVERED = ["The build gate is green again", "Checkout webhooks recovered", "All worker agents are back"];
const SOURCES = ["meeting_signals", "dms", "main_health", "prs", "fleet"];
const KINDS = CATALOGUE.map((e) => e.id);
/** Kinds the owner may hide in the fuzz. The heroes and Needs you can never be hidden; hiding Incident is the one owner
 *  choice that un-hosts an incident priority by design, covered by its own test in brief-standing-rules.test.ts. */
const HIDEABLE = KINDS.filter((k) => !["sunrise", "catchup", "needs", "incident"].includes(k));

const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const origin = (product: string): BriefOrigin => ({ companyUid: COMPANY, repo: `northwind/${product.toLowerCase()}`, product });

// ---------------------------------------------------------------------------
// Day generator
// ---------------------------------------------------------------------------

export function randomDay(seed: number): BriefInput {
  const r = new Rng(seed);
  // Dates across six weeks of October and November 2026 so every weekday and both weekend days come up.
  const dayIndex = r.int(0, 41);
  const dayMs = Date.UTC(2026, 9, 5 + dayIndex);
  const today = iso(dayMs).slice(0, 10);
  const nowMs = dayMs + r.int(12, 17) * HOUR;
  const now = iso(nowMs);
  const away = r.f();
  const lastBriefAt = away < 0.15 ? null : away < 0.7 ? iso(nowMs - DAY) : away < 0.85 ? iso(nowMs - 2 * DAY) : iso(nowMs - r.int(3, 7) * DAY - r.int(0, 5) * HOUR);
  // One day in twelve is quiet: nothing happened but a session or two, so the hero stands alone.
  const quiet = r.chance(0.08);
  const count = (xs: readonly number[]) => (quiet ? 0 : r.pick(xs));

  const nDecisions = count([0, 0, 1, 2, 2, 3, 4, 5, 5, 6, 7, 8]);
  const decisions: BriefDecision[] = Array.from({ length: nDecisions }, (_, i) => {
    const product = r.pick(PRODUCTS);
    const action = r.pick(["cut", "go", "decide", "reply", "prep"] as const);
    const unlocks = Array.from({ length: r.int(0, 3) }, (__, k) => ({ label: `${r.pick(BLOCKED_WORK)} ${k + 1}`, state: "" }));
    const blocks = Array.from({ length: r.chance(0.35) ? r.int(1, 3) : 0 }, () =>
      r.chance(0.6) ? { who: r.pick(PEOPLE), what: r.pick(BLOCKED_WORK), kind: "person" as const } : { who: r.pick(BLOCKED_WORK), what: r.pick(BLOCKED_WORK), kind: "work" as const },
    );
    const source = r.pick(SOURCES);
    return {
      id: `d${i + 1}`,
      title: r.pick(DECISION_TITLES),
      summary: "Why it matters today",
      action,
      ...(action === "decide" ? { choices: ["Yes", "No"] as [string, string] } : {}),
      origin: origin(product),
      detail: { why: "Why it matters today", unlocks, source: r.chance(0.3) ? r.pick(MEETING_TITLES) : source },
      ...(r.chance(0.8) ? { ageHours: r.int(0, 80) } : {}),
      ...(r.chance(0.5) ? { peopleWaiting: r.int(0, 4) } : {}),
      ...(r.chance(0.4) ? { revenue: true } : {}),
      ...(blocks.length ? { blocks } : {}),
      ...(r.chance(0.8) ? { source } : {}),
      ...(r.chance(0.2) ? { effort: r.pick(["quick", "medium", "large"] as const) } : {}),
    };
  });

  const nIncidents = count([0, 0, 0, 1, 1, 2, 3]);
  const incidents: BriefRisk[] = Array.from({ length: nIncidents }, (_, i) => {
    const product = r.pick(PRODUCTS);
    const ci = r.chance(0.6);
    return {
      id: `p${i + 1}`,
      title: r.pick(INCIDENT_TITLES),
      summary: "It has been failing since last night.",
      severity: "incident",
      links: [],
      origin: origin(product),
      ...(ci
        ? { ci: { repo: product.toLowerCase(), workflow: r.chance(0.8) ? r.pick(WORKFLOWS) : null, job: null, since: r.chance(0.3) ? iso(nowMs - r.int(1, 90) * HOUR) : null, ageHours: r.chance(0.7) ? r.int(1, 90) : null, note: null } }
        : {}),
      ...(r.chance(0.3) ? { measure: { healthy: 44, total: 48, unit: "agents", cause: "setup phase" } } : {}),
    };
  });
  const watches: BriefRisk[] = Array.from({ length: count([0, 0, 1, 2, 3, 4, 5, 6]) }, (_, i) => {
    const product = r.pick(PRODUCTS);
    return {
      id: `w${i + 1}`,
      title: r.pick(WATCH_TITLES),
      summary: "Worth a look.",
      severity: "watch",
      links: [],
      origin: origin(product),
      ...(r.chance(0.2) ? { ci: { repo: product.toLowerCase(), workflow: r.pick(WORKFLOWS), job: null, since: null, ageHours: r.int(1, 30), note: null } } : {}),
    };
  });

  const shippedProducts = r.some(PRODUCTS, count([0, 0, 1, 2, 3, 4, 6, 8]));
  const shipped: BriefShipped[] = shippedProducts.map((product) => {
    const n = r.int(1, 12);
    return {
      id: `ship:${product.toLowerCase()}`,
      title: product,
      status: `${n} merged`,
      note: "nothing open",
      origin: origin(product),
      lines: Array.from({ length: n }, (_, k) => ({ label: `Change ${k + 1}`, state: "MERGED", tone: "ok" as const })),
      ...(r.chance(0.25) ? { first: true } : {}),
    };
  });
  const linesMerged = shipped.reduce((n, s) => n + s.lines.length, 0);
  const merged = r.chance(0.3) ? undefined : r.chance(0.7) ? linesMerged : linesMerged + r.int(0, 20);

  const meetingsYesterday: BriefMeeting[] = Array.from({ length: count([0, 0, 1, 2, 3, 4, 6, 9, 10]) }, (_, i) => {
    const decided = r.some(DECIDED, r.int(0, 4));
    const todo = Array.from({ length: r.int(0, 3) }, () => ({ text: r.pick(TODOS), owner: r.pick(PEOPLE), mine: r.chance(0.3) }));
    const attended = r.f();
    return {
      id: `m${i + 1}`,
      title: r.pick(MEETING_TITLES),
      startTime: iso(nowMs - r.int(1, 100) * HOUR),
      companyUid: COMPANY,
      decisions: decided.length,
      actions: todo.length,
      risks: 0,
      questions: 0,
      ...(decided.length ? { decided } : {}),
      ...(todo.length ? { todo } : {}),
      ...(attended < 0.2 ? { attended: false } : attended < 0.5 ? { attended: true } : {}),
    };
  });

  const team: BriefTeammate[] = r.some(PEOPLE, count([0, 0, 1, 2, 3, 4, 6])).map((name, i) => {
    const agent = r.chance(0.2);
    return {
      id: agent ? `agt_${name.toLowerCase()}` : `prs_${name.toLowerCase()}`,
      name,
      doing: agent ? "Agent" : r.pick(["Needs your call", "Shipping the fixes", "Waiting on a review"]),
      tone: agent ? "neutral" : r.pick(["ok", "warn", "decision", "decision", "neutral"] as const),
      ...(agent ? { isAgent: true } : {}),
      ...(r.chance(0.2) ? { thanks: "for the launch weekend" } : {}),
      ...(i === 0 && r.chance(0.3) ? { dmCount: r.int(1, 5) } : {}),
    };
  });

  const waitingOn: BriefWaiting[] = r.some(PEOPLE, count([0, 0, 0, 1, 2, 3, 4])).map((who, i) => ({
    id: `wt${i + 1}`,
    who,
    what: r.pick(WAITS),
    ...(r.chance(0.7) ? { ageHours: r.int(0, 60) } : {}),
    ...(r.chance(0.5) ? { kind: r.pick(["dm", "review", "handoff", "other"] as const) } : {}),
  }));

  const itemIds = [...decisions.map((d) => d.id), ...incidents.map((p) => p.id)];
  const carry: BriefCarry[] = Array.from({ length: count([0, 0, 0, 1, 1, 2, 3, 4]) }, (_, i) => ({
    id: `c${i + 1}`,
    title: r.pick(DECISION_TITLES),
    why: "Still open",
    origin: origin(r.pick(PRODUCTS)),
    carriedFrom: "brief-20261001-070000",
    carriedSince: "2026-10-01",
    briefs: r.int(1, 4),
    itemId: itemIds.length && r.chance(0.5) ? r.pick(itemIds) : null,
  }));

  const handoffs: BriefHandoff[] = Array.from({ length: count([0, 0, 0, 1, 1, 2, 3]) }, (_, i) => ({
    id: `h${i + 1}`,
    object: r.pick(BLOCKED_WORK),
    from: r.pick(PEOPLE),
    to: r.pick(PEOPLE),
    me: r.chance(0.5),
    production: r.chance(0.4),
    since: iso(nowMs - r.int(1, 40) * HOUR),
    receipts: { access: r.pick([true, false, null]), ack: r.pick([true, false, null]), active: r.pick([true, false, null]) },
    origin: origin(r.pick(PRODUCTS)),
  }));

  const releases: BriefRelease[] = r.some(PRODUCTS, count([0, 0, 0, 1, 1, 2])).map((product) => ({
    product,
    version: r.chance(0.5) ? "1.4" : null,
    origin: origin(product),
    releasedAt: r.chance(0.7) ? iso(nowMs - r.int(5, 80) * HOUR) : null,
    pending: [{ day: today, count: r.int(0, 5), theme: "fixes" }],
    pendingCount: r.int(0, 8),
    held: Array.from({ length: r.int(0, 2) }, () => ({ title: r.pick(BLOCKED_WORK), why: "waits on your answer" })),
    light: r.pick(["ok", "warn", "red"] as const),
  }));

  const recovered: BriefRecovered[] = Array.from({ length: count([0, 0, 0, 1, 1, 2, 3]) }, (_, i) => ({
    id: `r${i + 1}`,
    title: r.pick(RECOVERED),
    what: "It passed again on its own",
    at: iso(nowMs - r.int(1, 30) * HOUR),
    source: r.pick(["main_health", "fleet", "session"] as const),
    origin: origin(r.pick(PRODUCTS)),
  }));

  const fleetIncident = !quiet && r.chance(0.3)
    ? {
        // The writer's fleet incident carries the id of the incident row a priority can point at, as applyRunItems does.
        id: incidents.length ? r.pick(incidents).id : `fleet:${COMPANY}`,
        series: [{ at: iso(nowMs - 48 * HOUR), stuck: r.int(1, 9) }, { at: iso(nowMs - 2 * HOUR), stuck: r.int(0, 6) }],
        incidentStart: iso(nowMs - 72 * HOUR),
        incidentEnd: r.chance(0.7) ? null : r.chance(0.5) ? iso(nowMs - 5 * HOUR) : iso(nowMs - 40 * HOUR),
        verdict: r.pick(["healing", "healed", "plateaued", "relapsing"] as const),
        stillStuck: Array.from({ length: r.int(0, 6) }, (_, k) => ({ name: `agent-${k + 1}`, reason: "setup", since: iso(nowMs - 40 * HOUR) })),
        fixes: [],
      }
    : undefined;

  const nDays = quiet || r.chance(0.5) ? 0 : r.int(2, 7);
  const days = Array.from({ length: nDays }, (_, i) => ({
    date: iso(dayMs - (nDays - i) * DAY).slice(0, 10),
    sessions: r.int(0, 8),
    meetings: r.int(0, 5),
    merged: r.int(0, 25),
    opened: r.int(0, 10),
    ...(r.chance(0.35) ? { beat: { kind: r.pick(["turn", "crisis", "resolution", "push"] as const), label: r.pick(["Sunday push", "Pricing turn", "Gate crisis", "Sync resolved"]) } } : {}),
  }));

  const reminders: BriefReminder[] = Array.from({ length: count([0, 0, 0, 1, 2, 3]) }, (_, i) => ({
    id: `rm${i + 1}`,
    text: r.pick(REMINDERS),
    saidAt: iso(nowMs - r.int(10, 80) * HOUR),
    where: r.pick(MEETING_TITLES),
    dueAt: r.chance(0.8) ? iso(nowMs + r.int(-30, 80) * HOUR) : null,
  }));

  const calendarToday: BriefCalendarEvent[] = Array.from({ length: count([0, 0, 1, 2, 3, 4, 6]) }, (_, i) => {
    const start = nowMs + r.int(-3, 6) * HOUR + r.pick([0, 15, 30, 45]) * 60_000;
    return {
      id: `c${i + 1}`,
      title: r.pick(EVENTS),
      start: iso(start),
      end: iso(start + r.pick([15, 30, 60]) * 60_000),
      kind: r.pick(["team", "ext", "learn"] as const),
      ...(r.chance(0.15) ? { busy: true } : {}),
    };
  });

  const sessions: BriefSession[] = Array.from({ length: r.pick([0, 1, 2, 3, 4, 6, 8, 12, 14]) }, (_, i) => {
    const inside = r.chance(0.8);
    const kind = r.pick(["you", "you", "you", "agent", "lane"]);
    return {
      id: `s${i + 1}`,
      title: r.chance(0.8) ? r.pick(TODOS) : "",
      startedAt: iso(nowMs - r.int(0, 23) * HOUR),
      workstream: "Work",
      company: inside ? COMPANY : "cmp_other",
      ...(kind !== "you" ? { kind } : {}),
      ...(r.chance(0.6) ? { product: r.pick(PRODUCTS) } : {}),
    };
  });

  // Priorities: mostly calls, sometimes the incident, a handoff or a carry row, sometimes nothing linked.
  const candidates = r.shuffle([
    ...decisions.map((d) => ({ text: d.title, itemId: d.id })),
    ...incidents.map((p) => ({ text: p.title, itemId: p.id })),
    ...handoffs.slice(0, 1).map((h) => ({ text: `Chase the receipt for ${h.object}`, itemId: h.id })),
    ...carry.filter((c) => !c.itemId).slice(0, 1).map((c) => ({ text: c.title, itemId: c.id })),
    ...(r.chance(0.3) ? [{ text: "Write the quarter memo", itemId: null }] : []),
  ]);
  const nPriorities = r.chance(0.2) ? 0 : Math.min(5, candidates.length, r.int(1, 5));
  const priorities: BriefPriority[] = candidates.slice(0, nPriorities).map((c, i) => ({
    n: i + 1,
    text: c.text,
    because: r.chance(0.2) ? null : r.chance(0.5) ? `${r.pick([...team.map((t) => t.name), ...waitingOn.map((w) => w.who), ...PEOPLE.slice(0, 2)])} is waiting on you` : "The team plans around it",
    itemId: c.itemId,
    ...(r.chance(0.5) ? { score: r.int(1, 9) } : {}),
  }));

  const prefs: BriefPrefs | undefined = r.chance(0.6)
    ? undefined
    : {
        density: r.pick(["auto", "calm", "full"] as const),
        pinned: r.some(KINDS, r.int(0, 3)),
        hidden: r.some(HIDEABLE, r.int(0, 3)),
        weights: Object.fromEntries(r.some(KINDS, r.int(0, 3)).map((k) => [k, r.int(-3, 3)])) as Partial<Record<BriefWidgetKind, number>>,
      };

  const input: BriefInput = {
    now,
    today,
    userName: "Sam",
    companies: [COMPANY, "northwind"],
    calendarToday,
    meetingsYesterday,
    decisions,
    actionItems: [],
    risks: r.shuffle([...incidents, ...watches]),
    shipped,
    ...(merged !== undefined ? { merged, opened: r.int(0, 10) } : {}),
    waitingOn,
    team,
    sessions,
    ...(r.chance(0.8) ? { recentSessions: sessions } : {}),
    lastBriefAt,
    ...(r.chance(0.08) ? { catchUp: true } : {}),
    ...(r.chance(0.3) ? { leadHint: "Start with the budget line." } : {}),
    priorities,
    ...(prefs ? { prefs } : {}),
    ...(carry.length ? { carry } : {}),
    ...(handoffs.length ? { handoffs } : {}),
    ...(releases.length ? { releases } : {}),
    ...(recovered.length ? { recovered } : {}),
    ...(fleetIncident ? { fleetIncident } : {}),
    ...(days.length ? { days } : {}),
    ...(reminders.length ? { reminders } : {}),
  };
  // Rotation: the previous run saw some of today's cards unchanged.
  if (r.chance(0.4)) {
    const hashes = digest(input);
    for (const k of Object.keys(hashes) as BriefWidgetKind[]) if (r.chance(0.5)) delete hashes[k];
    input.previous = { runId: "brief-20261001-070000", hashes };
  }
  return input;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

const DAYS = 300;
const SEED = 20261011;

interface Checked {
  input: BriefInput;
  plan: BriefPlan;
}

const evOf = (plan: BriefPlan, kind: BriefWidgetKind) => plan.scored.find((s) => s.kind === kind)!.ev;

function placedOf(plan: BriefPlan): Placed[] {
  return plan.widgets.map((w) => ({ kind: w.kind, rows: w.rows, size: w.size }));
}

/** The same day with its priorities pinned (an empty list derives them from the decisions' order), lists shuffled and keys reordered. */
function shuffled(input: BriefInput, r: Rng): BriefInput {
  const x: BriefInput = {
    ...input,
    decisions: r.shuffle(input.decisions),
    risks: r.shuffle(input.risks),
    shipped: r.shuffle(input.shipped),
    team: r.shuffle(input.team),
    meetingsYesterday: r.shuffle(input.meetingsYesterday),
  };
  return Object.fromEntries(r.shuffle(Object.entries(x))) as unknown as BriefInput;
}

describe(`seeded fuzz: ${DAYS} generated days (mulberry32, seed ${SEED})`, () => {
  const days: Checked[] = [];
  const rng = new Rng(SEED);
  for (let i = 0; i < DAYS; i += 1) {
    const input = randomDay(rng.int(1, 0x7fffffff));
    days.push({ input, plan: generateBrief(input) });
  }
  const label = (d: Checked, i: number) => `day ${i} (${d.input.today}, ${d.plan.dayType}, ${d.plan.template})`;

  it("covers the space: every day type, every density, both heroes, weekends with calls, prefs and rotation", () => {
    const dayTypes = new Set(days.map((d) => d.plan.dayType));
    expect([...dayTypes].sort()).toEqual(["catch-up", "friday", "midweek", "monday", "post-incident", "weekend"]);
    const densities = new Set(days.map((d) => d.plan.density));
    for (let n = 1; n <= MAX_DENSITY; n += 1) expect(densities.has(n), `some day has ${n} widgets`).toBe(true);
    expect(days.some((d) => d.plan.widgets[0]!.kind === "catchup")).toBe(true);
    expect(days.some((d) => d.plan.dayType === "weekend" && d.plan.widgets.some((w) => w.kind === "needs"))).toBe(true);
    expect(days.some((d) => (d.input.prefs?.hidden.length ?? 0) > 0)).toBe(true);
    expect(days.some((d) => d.plan.scored.some((s) => s.parts.rotation > 0))).toBe(true);
    const shown = new Set(days.flatMap((d) => d.plan.widgets.map((w) => w.kind)));
    for (const e of CATALOGUE) expect(shown.has(e.id), `${e.id} is shown on some day`).toBe(true);
    expect(new Set(days.map((d) => d.plan.template)).size).toBeGreaterThanOrEqual(8);
  });

  it("hero in slot a: sunrise, or catchup on a catch-up day, always tier 1", () => {
    days.forEach((d, i) => {
      const hero = d.plan.widgets[0]!;
      expect(hero.slot, label(d, i)).toBe("a");
      expect(hero.tier, label(d, i)).toBe(1);
      expect(hero.kind, label(d, i)).toBe(d.plan.dayType === "catch-up" ? "catchup" : "sunrise");
      expect(d.plan.areas[0]!.startsWith(hero.kind), label(d, i)).toBe(true);
    });
  });

  it("no '.' in areas when QUIET_TEMPLATES: six cells per row, two or three rows, exactly the placed kinds", () => {
    expect(QUIET_TEMPLATES).toBe(true);
    days.forEach((d, i) => {
      const { areas, widgets } = d.plan;
      expect(areas.length, label(d, i)).toBeGreaterThanOrEqual(2);
      expect(areas.length, label(d, i)).toBeLessThanOrEqual(3);
      for (const row of areas) {
        expect(row, label(d, i)).not.toContain(".");
        expect(row.split(" "), label(d, i)).toHaveLength(6);
      }
      const cells = new Set(areas.flatMap((r) => r.split(" ")));
      expect([...cells].sort(), label(d, i)).toEqual(widgets.map((w) => w.kind).sort());
      expect(new Set(widgets.map((w) => w.kind)).size, label(d, i)).toBe(widgets.length);
      expect(new Set(widgets.map((w) => w.slot)).size, label(d, i)).toBe(widgets.length);
      expect(areas, label(d, i)).toEqual(TEMPLATES[d.plan.template]!.areas.map((row) => row.split(" ").map((slot) => widgets.find((w) => w.slot === slot)!.kind).join(" ")));
    });
  });

  it("no forbidden pair without coexist, with rows and sizes known", () => {
    days.forEach((d, i) => {
      const ctx = buildContext(d.input);
      const placed = placedOf(d.plan);
      for (const rule of PAIRS) {
        const a = placed.find((p) => p.kind === rule.pair[0]);
        const b = placed.find((p) => p.kind === rule.pair[1]);
        if (a && b) expect(rule.coexist(ctx, placed), `${label(d, i)}: ${rule.pair.join(" / ")} placed together`).toBe(true);
      }
    });
  });

  it("density 1..8 equals the widgets placed; a catch-up or calm day never exceeds five; the template belongs to that density", () => {
    days.forEach((d, i) => {
      const { density, widgets, template } = d.plan;
      expect(density, label(d, i)).toBeGreaterThanOrEqual(1);
      expect(density, label(d, i)).toBeLessThanOrEqual(MAX_DENSITY);
      expect(density, label(d, i)).toBe(widgets.length);
      expect(VARIANTS[density], label(d, i)).toContain(template);
      if (d.plan.dayType === "catch-up" || d.input.prefs?.density === "calm") expect(density, label(d, i)).toBeLessThanOrEqual(CATCH_UP_DENSITY);
    });
  });

  it("hidden never shown, and always listed as 'hidden by you'; sunrise, catchup and needs cannot be hidden", () => {
    days.forEach((d, i) => {
      const kinds = d.plan.widgets.map((w) => w.kind);
      for (const k of d.input.prefs?.hidden ?? []) {
        expect(kinds, `${label(d, i)}: ${k} hidden`).not.toContain(k);
        expect(d.plan.scored.map((s) => s.kind), `${label(d, i)}: ${k} hidden`).not.toContain(k);
        expect(d.plan.dropped, `${label(d, i)}: ${k} hidden`).toContainEqual({ kind: k, why: "hidden by you" });
      }
      const hero = d.plan.widgets[0]!.kind;
      const ctx = buildContext({ ...d.input, prefs: { density: "auto", pinned: [], hidden: ["sunrise", "catchup", "needs"], weights: {} } });
      expect(ctx.prefs.hidden).toEqual([]);
      expect(generateBrief({ ...d.input, prefs: ctx.prefs }).widgets[0]!.kind).toBe(hero);
    });
  });

  it("fits or WIDEN respected: every widget's size is one its entry fits (or widens into); no full-height single column", () => {
    days.forEach((d, i) => {
      for (const w of d.plan.widgets) {
        expect(fitsSlot(entryOf(w.kind), w.size), `${label(d, i)}: ${w.kind} at ${w.size}`).toBe(true);
        expect(w.cols >= 1 && w.rows >= 1, label(d, i)).toBe(true);
        expect(w.cols === 1 && w.rows > 1, `${label(d, i)}: ${w.kind} is a full-height column`).toBe(false);
        expect(w.size, label(d, i)).toBe(TEMPLATES[d.plan.template]!.cls[w.slot]);
      }
    });
  });

  it("every priority with a decision or incident itemId is hosted by a placed card (needs and incident are ready), never listed as 'priority-N has no card'", () => {
    expect(entryOf("needs").ready && entryOf("incident").ready).toBe(true);
    let checked = 0;
    days.forEach((d, i) => {
      const ctx = buildContext(d.input);
      const hosted = new Set(d.plan.widgets.flatMap((w) => evOf(d.plan, w.kind).items));
      for (const p of ctx.priorities) {
        if (p.kind !== "decision" && p.kind !== "incident") continue;
        checked += 1;
        expect(hosted.has(p.itemId!), `${label(d, i)}: priority ${p.rank} (${p.kind} ${p.itemId}) hosted`).toBe(true);
        expect(d.plan.dropped.find((x) => x.kind === `priority-${p.rank}`), `${label(d, i)}: priority ${p.rank}`).toBeUndefined();
      }
      // The dropped list is consistent the other way too: a 'priority-N' row means that priority's item has no card.
      for (const x of d.plan.dropped) {
        const m = /^priority-(\d+)$/.exec(String(x.kind));
        if (!m) continue;
        const p = ctx.priorities[Number(m[1]) - 1]!;
        expect(p.itemId && !hosted.has(p.itemId), `${label(d, i)}: ${x.kind} is really unhosted`).toBe(true);
      }
    });
    expect(checked).toBeGreaterThan(200);
  });

  it("no fleet or otherWork kind anywhere: catalogue, widgets, scored, dropped", () => {
    expect(KINDS).not.toContain("fleet");
    expect(KINDS).not.toContain("otherWork");
    days.forEach((d, i) => {
      const all = [...d.plan.widgets.map((w) => w.kind), ...d.plan.scored.map((s) => s.kind), ...d.plan.dropped.map((x) => String(x.kind))];
      expect(all, label(d, i)).not.toContain("fleet");
      expect(all, label(d, i)).not.toContain("otherWork");
    });
  });

  it("every reason passes the lint: shown cards, and every scored entry under its own why", () => {
    days.forEach((d, i) => {
      const ctx = buildContext(d.input);
      for (const w of d.plan.widgets) {
        expect(lintReason(w.reason), `${label(d, i)}: ${w.kind}: ${w.reason}`).toBeNull();
        expect(w.reason.startsWith(w.tier === 1 ? "Always first: " : "Shown "), `${label(d, i)}: ${w.kind}: ${w.reason}`).toBe(true);
      }
      for (const s of d.plan.scored) {
        const r = reasonFor(s.entry, s.ev, s.why, ctx);
        expect(lintReason(r), `${label(d, i)}: ${s.kind} (${s.why.kind}): ${r}`).toBeNull();
      }
      expect(d.plan.explain, label(d, i)).toHaveLength(d.plan.widgets.length + d.plan.dropped.length);
    });
  });

  it("dropped and shown are disjoint; pinned cards sit below the cards that contain a priority; weekend keeps Needs you when a priority is a call", () => {
    days.forEach((d, i) => {
      const kinds = new Set(d.plan.widgets.map((w) => w.kind));
      for (const x of d.plan.dropped) expect(kinds.has(x.kind as BriefWidgetKind), `${label(d, i)}: ${x.kind} both dropped and shown`).toBe(false);
      const pool = d.plan.scored.filter((s) => s.entry.ready);
      const lastContainer = pool.map((s) => s.tier === 2 && s.serves.some((x) => x.role === "contains")).lastIndexOf(true);
      pool.forEach((s, at) => {
        if (s.why.kind === "pref") expect(at, `${label(d, i)}: pinned ${s.kind} above a priority container`).toBeGreaterThan(lastContainer);
      });
      const ctx = buildContext(d.input);
      if (d.plan.dayType === "weekend" && ctx.priorities.some((p) => p.kind === "decision")) expect(kinds.has("needs"), label(d, i)).toBe(true);
    });
  });

  it("generateBrief deep-equals itself: across runs, under key-order shuffles of the input and list shuffles of decisions, risks, shipped, team and meetings", () => {
    const r = new Rng(SEED ^ 0x5bd1e995);
    days.forEach((d, i) => {
      expect(generateBrief(d.input), label(d, i)).toEqual(d.plan);
      // An empty priorities list derives them from the decisions' order, so pin them before shuffling.
      const pinned: BriefInput = { ...d.input, priorities: briefPriorities(d.input) };
      const reference = generateBrief(pinned);
      for (let k = 0; k < 2; k += 1) expect(generateBrief(shuffled(pinned, r)), `${label(d, i)} shuffle ${k}`).toEqual(reference);
    });
  });
});
