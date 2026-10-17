import { briefCompanyUid, scopeBriefCompanyData, type BriefCompanyScope } from "./brief-company.js";
/**
 * Parsers for a run's synthesized files: `brief.json` (items with launch
 * prompts, today's priorities, the owner's widget prefs, the week) and
 * `housekeeping.json` (cleanup results and proposals). Both are written by a
 * model, so every field is optional: a missing list is empty, a bad item is
 * dropped, nothing is guessed at. Field names follow the writer (snake_case in
 * JSON) and land camelCase on `BriefInput`.
 */

import { CATALOGUE } from "./brief-catalogue.js";
import { humanTitle } from "./brief-distill.js";
import { productName } from "./brief-origin.js";
import type {
  BriefBlocked,
  BriefCarry,
  BriefDay,
  BriefDecision,
  BriefDecisionAction,
  BriefHandoff,
  BriefMeeting,
  BriefOrigin,
  BriefPrefs,
  BriefPriority,
  BriefRecovered,
  BriefRelease,
  BriefReminder,
  BriefRisk,
  BriefShipped,
  BriefTeammate,
  BriefTodo,
  BriefTone,
  BriefWaiting,
  BriefWidgetKind,
} from "./brief-types.js";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string | null => (DAY_RE.test(str(v)) ? str(v) : null);
/** A list of plain strings; objects contribute their `text` or `label`. */
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : str(rec(x).text) || str(rec(x).label))).filter(Boolean) : [];
const oneOf = <T extends string>(options: readonly T[], v: unknown): T | undefined => options.find((o) => o === str(v));

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Widget kinds the picker knows; anything else in prefs is dropped. */
const KINDS: ReadonlySet<string> = new Set(CATALOGUE.map((e) => e.id));
const isKind = (k: string): k is BriefWidgetKind => KINDS.has(k);

/** The hero and the needs card can never be muted; the writer refuses too. */
export const NEVER_HIDDEN: readonly BriefWidgetKind[] = ["sunrise", "catchup", "needs"];

export const DEFAULT_PREFS: BriefPrefs = { density: "auto", pinned: [], hidden: [], weights: {} };

/**
 * `prefs_applied.widgets`: `{ pinned, muted, weights, density }` copied by the
 * writer from brief-prefs.yaml. Unknown kinds are dropped, weights are clamped
 * to -2..2, and sunrise, catchup and needs are never hidden. Absent = defaults.
 */
export function parsePrefs(raw: unknown): BriefPrefs {
  const w = rec(raw);
  const kinds = (v: unknown): BriefWidgetKind[] => [...new Set(strings(v).filter(isKind))];
  const weights: Partial<Record<BriefWidgetKind, number>> = {};
  for (const [k, v] of Object.entries(rec(w.weights ?? w.widget_weights))) {
    const n = num(v);
    if (isKind(k) && n != null) weights[k] = Math.max(-2, Math.min(2, Math.round(n)));
  }
  return {
    density: oneOf(["calm", "full"] as const, w.density) ?? "auto",
    pinned: kinds(w.pinned ?? w.pinned_widgets),
    hidden: kinds(w.muted ?? w.hidden ?? w.muted_widgets).filter((k) => !NEVER_HIDDEN.includes(k)),
    weights,
  };
}

export interface BriefRunItems {
  runId: string | null;
  generatedAt: string | null;
  /** Root `today`, YYYY-MM-DD local; null in older briefs. */
  today: string | null;
  leadHint: string | null;
  catchUp: boolean;
  /** Always set: defaults when `prefs_applied.widgets` is absent. */
  prefs: BriefPrefs;
  decisions: BriefDecision[];
  waiting: BriefWaiting[];
  incidents: BriefRisk[];
  /** Standing risks (`items.watch`), severity "watch". */
  watch: BriefRisk[];
  /** The incident the writer sourced from the fleet, so the fleet-recovery card can host its priority. */
  fleetIncidentId: string | null;
  /** Today's priorities, at most five, as the writer ranked them; empty in older briefs. */
  priorities: BriefPriority[];
  /** The writer's meetings with what they decided and left to do; matched to the sweep's by title or start. */
  meetings: BriefMeeting[];
  /** The writer's people rows (`items.people`), as teammates. */
  people: BriefTeammate[];
  /** The writer's shipped rows, one per product or named ship; merged onto the sweep rollups by product. */
  shipped: BriefShipped[];
  carry: BriefCarry[];
  handoffs: BriefHandoff[];
  recovered: BriefRecovered[];
  releases: BriefRelease[];
  reminders: BriefReminder[];
  /** `week`, oldest first, at most seven. */
  days: BriefDay[];
  /** `landed_days`, newest last. */
  landedDays: string[];
  timeToClearMin: number | null;
  learnedNotes: string[];
}

const ACTIONS: readonly BriefDecisionAction[] = ["cut", "go", "decide", "reply", "prep"];
const EFFORTS = ["quick", "medium", "large"] as const;
const WAIT_KINDS = ["dm", "review", "handoff", "other"] as const;
const LOADS = ["clear", "steady", "heavy", "storm"] as const;
const RECOVERED_SOURCES = ["main_health", "fleet", "session"] as const;
const LIGHTS = ["ok", "warn", "red"] as const;
const BEATS = ["turn", "crisis", "resolution", "push"] as const;
/** A status line that says the person waits on the owner. */
const NEEDS_ME = /\b(waiting (on|for) your?|needs? your?|your (call|sign-?off|review|answer|go|ok)|asked you|blocked on your?)\b/i;

/** `items` may be `{ decisions: [...] }` or a flat list tagged with `kind`. */
function itemGroup(items: unknown, key: string, singular = key.replace(/s$/, "")): Record<string, unknown>[] {
  if (Array.isArray(items)) return list(items).filter((i) => str(i.kind) === key || str(i.kind) === singular);
  return list(rec(items)[key]);
}

/** The item's origin: `repo` and `product` on the item, or inside its `origin`. */
function originOf(i: Record<string, unknown>, scope: BriefCompanyScope): BriefOrigin {
  const o = rec(i.origin);
  const companyUid = briefCompanyUid("company" in i ? i.company : "company" in o ? o.company : o.companyUid, scope);
  const repo = str(i.repo) || str(o.repo) || null;
  const product = str(i.product) || str(o.product);
  return { companyUid, repo, ...(product ? { product } : {}) };
}

/** A red-main-CI item: from the main_health sweep, or naming a workflow. */
function isCi(r: Record<string, unknown>): boolean {
  return str(r.source) === "main_health" || str(r.kind) === "ci" || !!str(r.workflow);
}

/** Repo, workflow, job and how long it has been red, from the item or its title. */
function ciDetail(r: Record<string, unknown>, title: string): NonNullable<BriefRisk["ci"]> {
  const quoted = title.match(/['"‘“]([^'"’”]+)['"’”]/)?.[1] ?? null;
  const prefix = title.includes(":") ? title.split(":")[0]!.trim() : "";
  const merges = num(r.merges_on_top);
  return {
    repo: str(r.repo) || str(rec(r.origin).repo) || prefix || str(r.product),
    workflow: str(r.workflow) || quoted,
    job: str(r.job) || null,
    since: str(r.red_since) || str(r.since) || null,
    ageHours: num(r.age_hours),
    note: str(r.why) || str(r.summary) || null,
    ...(merges != null ? { mergesOnTop: merges } : {}),
  };
}

/** The writer's `risk` when it is a phrase; a single level word (low, medium, high) is dropped. */
function riskSentence(raw: unknown): string {
  const text = str(raw).trim();
  return text.split(/\s+/).length >= 2 ? text : "";
}

function parseBlocks(raw: unknown, companyUid: BriefCompanyScope): BriefBlocked[] {
  return list(raw)
    .map((b): BriefBlocked => {
      const hasOrigin = !!(str(b.repo) || str(rec(b.origin).repo) || str(b.product) || str(rec(b.origin).product));
      const kind = str(b.kind) === "person" ? "person" : "work";
      const origin = hasOrigin ? originOf(b, companyUid) : null;
      // A blocked piece of work named only by its product ("the Desktop app release waits") keeps the product as its name.
      const who = str(b.who) || str(b.name) || (kind === "work" && origin ? productName(origin.repo, origin.product) : "");
      return {
        who,
        what: str(b.what),
        kind,
        ...(origin ? { origin } : {}),
      };
    })
    .filter((b) => b.who);
}

function parseTodo(raw: unknown): BriefTodo[] {
  return (Array.isArray(raw) ? raw : [])
    .map((t): BriefTodo => (typeof t === "string" ? { text: t.trim() } : { text: str(rec(t).text), owner: str(rec(t).owner) || null, mine: rec(t).mine === true }))
    .filter((t) => t.text);
}

/** `brief.json`, or null when invalid. legacyCompany is only the paired non-person sweep's root company. */
export function parseBriefItems(text: string, scope: BriefCompanyScope, legacyCompany: string | null = null): BriefRunItems | null {
  let root = parseJson(text);
  if (!root) return null;
  if (root.mode === "person") {
    const base = parseBriefItems(JSON.stringify({ ...root, company: null, mode: "personal", companies: undefined, personal: undefined, items: undefined }), scope)!;
    const sections = [[null, root.personal], ...Object.entries(rec(root.companies))] as [string | null, unknown][];
    for (const [company, raw] of sections) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      if (company && Array.isArray(scope) && !briefCompanyUid(company, scope)) continue;
      // The section is authoritative; an item cannot move to another company.
      const tag = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(tag);
        if (!value || typeof value !== "object") return value;
        const row = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tag(v)]));
        return { ...row, company };
      };
      const child = parseBriefItems(JSON.stringify({ ...rec(tag(raw)), mode: "company" }), scope)!;
      const prefix = (id: string) => (company ?? "personal") + ":" + id;
      for (const key of ["decisions", "waiting", "incidents", "watch", "meetings", "shipped", "carry", "handoffs", "recovered", "reminders"] as const) {
        for (const item of child[key]) item.id = prefix(item.id);
      }
      for (const priority of child.priorities) if (priority.itemId) priority.itemId = prefix(priority.itemId);
      for (const carried of child.carry) if (carried.itemId) carried.itemId = prefix(carried.itemId);

      for (const key of ["decisions", "waiting", "incidents", "watch", "priorities", "meetings", "people", "shipped", "carry", "handoffs", "recovered", "releases", "reminders"] as const) {
        // Each key names an array in both shapes; appending preserves its element type.
        (base[key] as unknown[]).push(...child[key]);
      }
      base.landedDays = [...new Set([...base.landedDays, ...child.landedDays])].sort();
      if (child.timeToClearMin != null) base.timeToClearMin = (base.timeToClearMin ?? 0) + child.timeToClearMin;
    }
    return base;
  }
  root = scopeBriefCompanyData(root, scope, legacyCompany) as typeof root;
  if (!root) return null;
  const items = root.items;
  const companyUid = briefCompanyUid(root.company, scope);
  const origin = (i: Record<string, unknown>) => originOf(i, scope);

  // Carry first: a decision it continues gets `carriedBriefs`.
  const carry: BriefCarry[] = [];
  for (const [n, c] of itemGroup(items, "carry", "carry").entries()) {
    const title = humanTitle(str(c.title)).text;
    if (!title) continue;
    const prompt = str(c.prompt);
    const briefs = num(c.briefs);
    carry.push({
      id: str(c.id) || `brief-carry-${n}`,
      title,
      why: str(c.why) || title,
      origin: origin(c),
      carriedFrom: str(c.carried_from),
      carriedSince: str(c.carried_since) || null,
      briefs: briefs != null && briefs >= 1 ? Math.round(briefs) : 1,
      itemId: str(c.item_id) || null,
      ...(prompt ? { prompt } : {}),
    });
  }
  const carriedBriefs = new Map<string, number>();
  for (const c of carry) if (c.itemId && !carriedBriefs.has(c.itemId)) carriedBriefs.set(c.itemId, c.briefs);

  const decisions: BriefDecision[] = [];
  for (const [n, d] of itemGroup(items, "decisions").entries()) {
    // A to-do, not a PR: "<repo> #12: feat(x): ..." loses its reference and prefix.
    const { text: title, ref } = humanTitle(str(d.title));
    if (!title) continue;
    const id = str(d.id) || `brief-decision-${n}`;
    const action = ACTIONS.find((a) => a === str(d.action)) ?? "decide";
    const prompt = str(d.prompt);
    const ageHours = num(d.age_hours);
    const effort = oneOf(EFFORTS, d.effort);
    const peopleWaiting = num(d.people_waiting);
    const revenue = bool(d.revenue);
    const blocks = parseBlocks(d.blocks, scope);
    const source = str(d.source);
    const rawChoices = Array.isArray(d.choices) ? d.choices.map((c) => str(c)).filter(Boolean) : [];
    const choices: [string, string] | null = rawChoices.length >= 2 ? [rawChoices[0]!, rawChoices[1]!] : null;
    const carried = carriedBriefs.get(id);
    decisions.push({
      id,
      title,
      summary: str(d.summary) || str(d.why) || title,
      action,
      ...(choices ? { choices } : {}),
      origin: origin(d),
      ...(prompt ? { prompt } : {}),
      detail: {
        why: str(d.why) || title,
        unlocks: (Array.isArray(d.unlocks) ? d.unlocks : [])
          .map((u) => (typeof u === "string" ? u.trim() : str(rec(u).label)))
          .filter(Boolean)
          .map((label) => ({ label, state: "" })),
        // The app reads `risk` as a sentence ("First check: …", the Watch section); a bare level word ("high") is not one.
        ...(riskSentence(d.risk) ? { risk: riskSentence(d.risk) } : {}),
        source: [ref, source || "Daily brief"].filter(Boolean).join(" · "),
      },
      ...(ageHours != null ? { ageHours } : {}),
      ...(effort ? { effort } : {}),
      ...(peopleWaiting != null ? { peopleWaiting: Math.max(0, Math.round(peopleWaiting)) } : {}),
      ...(revenue != null ? { revenue } : {}),
      ...(blocks.length ? { blocks } : {}),
      ...(source ? { source } : {}),
      ...(carried != null ? { carriedBriefs: carried } : {}),
    });
  }

  // The contract (SKILL.md "waiting"): `who` (first name or agent) and `what` (the thing waited for,
  // plain). Older names for the same two fields are read too; a row that names nobody is not a wait
  // the card can show and is dropped (brief_rank --check reports it on the writer's side).
  const waiting: BriefWaiting[] = [];
  for (const [n, w] of itemGroup(items, "waiting", "waiting").entries()) {
    const who = str(w.who) || str(w.person) || str(w.from) || str(w.name);
    const what = humanTitle(str(w.what) || str(w.title)).text;
    if (!who || !what) continue;
    const prompt = str(w.prompt);
    const ageHours = num(w.age_hours);
    const kind = oneOf(WAIT_KINDS, w.kind);
    const hasOrigin = !!((Array.isArray(scope) && origin(w).companyUid) || str(w.repo) || str(rec(w.origin).repo) || str(w.product) || str(rec(w.origin).product));
    waiting.push({
      id: str(w.id) || `brief-waiting-${n}`,
      who,
      what,
      ...(prompt ? { prompt } : {}),
      ...(ageHours != null ? { ageHours } : {}),
      ...(kind ? { kind } : {}),
      ...(hasOrigin ? { origin: origin(w) } : {}),
    });
  }

  const incidents: BriefRisk[] = [];
  let fleetIncidentId: string | null = null;
  for (const [n, r] of itemGroup(items, "incidents").entries()) {
    const title = str(r.title);
    if (!title) continue;
    const id = str(r.id) || `brief-incident-${n}`;
    const prompt = str(r.prompt);
    const rawLinks: unknown[] = Array.isArray(r.fixes) ? r.fixes : Array.isArray(r.links) ? r.links : [];
    const links = rawLinks
      .map((x) => {
        if (typeof x === "string") return { label: x.trim(), origin: { companyUid, repo: null } };
        const l = rec(x);
        const number = typeof l.number === "number" ? `#${l.number}` : "";
        return { label: str(l.label) || str(l.title) || `${str(l.repo)} ${number}`.trim(), origin: origin(l) };
      })
      .filter((l) => l.label);
    if (str(r.source) === "fleet" && !fleetIncidentId) fleetIncidentId = id;
    incidents.push({
      id,
      title,
      summary: str(r.summary) || str(r.why) || "",
      severity: str(r.severity) === "watch" ? "watch" : "incident",
      links,
      origin: origin(r),
      ...(prompt ? { prompt } : {}),
      ...(isCi(r) ? { ci: ciDetail(r, title) } : {}),
    });
  }

  const watch: BriefRisk[] = [];
  for (const [n, w] of itemGroup(items, "watch", "watch").entries()) {
    const title = humanTitle(str(w.title)).text;
    if (!title) continue;
    const prompt = str(w.prompt);
    watch.push({
      id: str(w.id) || `brief-watch-${n}`,
      title,
      summary: str(w.why) || str(w.summary) || "",
      severity: "watch",
      links: [],
      origin: origin(w),
      ...(prompt ? { prompt } : {}),
      ...(isCi(w) ? { ci: ciDetail(w, title) } : {}),
    });
  }

  const priorities: BriefPriority[] = list(root.priorities)
    .map((p, i) => {
      const score = num(p.score);
      return {
        ...(Array.isArray(scope) && origin(p).companyUid ? { companyUid: origin(p).companyUid } : {}),
        n: num(p.n) ?? num(p.rank) ?? i + 1,
        text: str(p.text) || str(p.title),
        because: str(p.because) || null,
        itemId: str(p.item_id) || null,
        ...(score != null ? { score } : {}),
      };
    })
    .filter((p) => p.text)
    .sort((a, b) => a.n - b.n)
    .slice(0, 5);

  const meetings: BriefMeeting[] = [];
  for (const [n, m] of itemGroup(items, "meetings").entries()) {
    const title = str(m.title) || str(m.meeting) || str(m.name);
    if (!title) continue;
    const decided = strings(m.decided);
    const todo = parseTodo(m.todo);
    const sig = rec(m.signals);
    const attended = bool(m.attended);
    const durationMin = num(m.duration_min);
    const withWho = str(m.with);
    meetings.push({
      id: str(m.id) || `brief-meeting-${n}`,
      title,
      startTime: str(m.start) || str(m.start_time),
      companyUid: origin(m).companyUid,
      decisions: num(sig.decision) ?? num(sig.decisions) ?? decided.length,
      actions: num(sig.action_item) ?? num(sig.actions) ?? todo.length,
      risks: num(sig.risk) ?? num(sig.risks) ?? 0,
      questions: num(sig.question) ?? num(sig.questions) ?? 0,
      ...(decided.length ? { decided } : {}),
      ...(todo.length ? { todo } : {}),
      ...(attended != null ? { attended } : {}),
      ...(durationMin != null ? { durationMin } : {}),
      ...(withWho ? { with: withWho } : {}),
    });
  }

  const people: BriefTeammate[] = [];
  for (const p of itemGroup(items, "people", "person")) {
    const full = str(p.name);
    if (!full) continue;
    const uid = str(p.uid);
    const agent = p.agent === true || uid.startsWith("agt_");
    const status = str(p.status);
    const load = oneOf(LOADS, p.load);
    const owes = strings(p.owes);
    const thanks = str(p.thanks);
    const tone: BriefTone = load === "storm" ? "red" : NEEDS_ME.test(status) ? "decision" : owes.length ? "warn" : agent ? "neutral" : "ok";
    people.push({
      id: uid || full,
      ...(Array.isArray(scope) && origin(p).companyUid ? { companyUid: origin(p).companyUid } : {}),
      name: full.split(/\s+/)[0]!,
      doing: status || (agent ? "Agent" : "On the team"),
      tone,
      isAgent: agent,
      ...(load ? { load } : {}),
      ...(owes.length ? { owes } : {}),
      ...(thanks ? { thanks } : {}),
    });
  }

  const shipped: BriefShipped[] = [];
  for (const [n, s] of itemGroup(items, "shipped", "shipped").entries()) {
    const title = humanTitle(str(s.title)).text;
    const product = str(s.product) || str(rec(s.origin).product);
    if (!title && !product) continue;
    const why = str(s.why);
    const highlights = strings(s.highlights).map((h) => humanTitle(h).text).slice(0, 5);
    const median = num(s.merge_hours_median);
    shipped.push({
      id: str(s.id) || `brief-ship-${n}`,
      title: title || product,
      status: str(s.status) || "",
      note: str(s.note) || "",
      origin: origin(s),
      lines: [],
      ...(s.first === true ? { first: true } : {}),
      ...(why ? { why } : {}),
      ...(highlights.length ? { highlights } : {}),
      ...(median != null ? { mergeHoursMedian: median } : {}),
    });
  }

  const handoffs: BriefHandoff[] = [];
  for (const [n, h] of itemGroup(items, "handoffs").entries()) {
    const object = humanTitle(str(h.object) || str(h.title)).text;
    if (!object) continue;
    const receipts = rec(h.receipts);
    const note = str(h.note);
    const prompt = str(h.prompt);
    handoffs.push({
      id: str(h.id) || `brief-handoff-${n}`,
      object,
      from: str(h.from),
      to: str(h.to),
      me: h.me === true,
      production: h.production === true,
      since: str(h.since),
      receipts: { access: bool(receipts.access), ack: bool(receipts.ack), active: bool(receipts.active) },
      ...(note ? { note } : {}),
      origin: origin(h),
      ...(prompt ? { prompt } : {}),
    });
  }

  const recovered: BriefRecovered[] = [];
  for (const [n, r] of itemGroup(items, "recovered", "recovered").entries()) {
    const title = humanTitle(str(r.title)).text;
    if (!title) continue;
    const timeline = list(r.timeline)
      .map((t) => ({ at: str(t.at), text: str(t.text) }))
      .filter((t) => t.text);
    const pi = rec(r.post_incident);
    const postIncident = { broke: str(pi.broke), did: str(pi.did), changes: str(pi.changes) };
    recovered.push({
      id: str(r.id) || `brief-recovered-${n}`,
      title,
      what: str(r.what) || str(r.why) || title,
      at: str(r.at) || null,
      source: oneOf(RECOVERED_SOURCES, r.source) ?? "session",
      origin: origin(r),
      ...(timeline.length ? { timeline } : {}),
      ...(postIncident.broke || postIncident.did || postIncident.changes ? { postIncident } : {}),
    });
  }

  const releases: BriefRelease[] = [];
  for (const r of itemGroup(items, "releases")) {
    const product = str(r.product) || str(rec(r.origin).product);
    if (!product) continue;
    const pending = list(r.pending)
      .map((p) => ({ day: day(p.day) ?? str(p.day).slice(0, 10), count: Math.max(0, Math.round(num(p.count) ?? 0)), theme: str(p.theme) }))
      .filter((p) => DAY_RE.test(p.day));
    const held = list(r.held)
      .map((h) => ({ title: humanTitle(str(h.title)).text, why: str(h.why) }))
      .filter((h) => h.title);
    const pendingCount = num(r.pending_count);
    const prompt = str(r.prompt);
    releases.push({
      product,
      version: str(r.version) || null,
      origin: { ...origin(r), product },
      releasedAt: str(r.released_at) || null,
      pending,
      pendingCount: pendingCount != null ? Math.max(0, Math.round(pendingCount)) : pending.reduce((n, p) => n + p.count, 0),
      held,
      light: oneOf(LIGHTS, r.light) ?? "ok",
      ...(prompt ? { prompt } : {}),
    });
  }

  const reminders: BriefReminder[] = [];
  for (const [n, r] of itemGroup(items, "reminders").entries()) {
    const text = str(r.text);
    if (!text) continue;
    const prompt = str(r.prompt);
    reminders.push({
      id: str(r.id) || `brief-reminder-${n}`,
      ...(Array.isArray(scope) && origin(r).companyUid ? { companyUid: origin(r).companyUid } : {}),
      text,
      saidAt: str(r.said_at),
      where: str(r.where),
      dueAt: str(r.due_at) || null,
      ...(prompt ? { prompt } : {}),
    });
  }

  const byDate = new Map<string, BriefDay>();
  for (const w of list(root.week)) {
    const date = day(w.date);
    if (!date) continue;
    const b = rec(w.beat);
    const kind = oneOf(BEATS, b.kind);
    const label = str(b.label);
    const evidence = str(b.evidence);
    byDate.set(date, {
      date,
      sessions: Math.max(0, Math.round(num(w.sessions) ?? 0)),
      meetings: Math.max(0, Math.round(num(w.meetings) ?? 0)),
      merged: Math.max(0, Math.round(num(w.merged) ?? 0)),
      opened: Math.max(0, Math.round(num(w.opened) ?? 0)),
      ...(kind && label ? { beat: { kind, label, ...(evidence ? { evidence } : {}) } } : {}),
    });
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-7);

  const landedDays = [...new Set(strings(root.landed_days).filter((d) => DAY_RE.test(d)))].sort();
  const timeToClearMin = num(root.time_to_clear_min);

  return {
    runId: str(root.run_id) || null,
    generatedAt: str(root.generated_at) || null,
    today: day(root.today),
    leadHint: str(root.lead_hint) || null,
    catchUp: root.catch_up === true,
    prefs: parsePrefs(rec(root.prefs_applied).widgets),
    decisions,
    waiting,
    incidents,
    watch,
    fleetIncidentId,
    priorities,
    meetings,
    people,
    shipped,
    carry,
    handoffs,
    recovered,
    releases,
    reminders,
    days,
    landedDays,
    timeToClearMin: timeToClearMin != null ? Math.max(0, Math.round(timeToClearMin)) : null,
    learnedNotes: (Array.isArray(root.learned_notes) ? root.learned_notes : []).map((n) => str(n)).filter(Boolean),
  };
}

export interface HousekeepingTask {
  name: string;
  ok: boolean;
  summary: string;
  error: string | null;
}

export interface HousekeepingProposal {
  id: string;
  title: string;
  /** What it frees or fixes. */
  frees: string;
  risk: string;
  prompt: string;
}

export interface BriefHousekeeping {
  tasks: HousekeepingTask[];
  proposals: HousekeepingProposal[];
}

/**
 * `housekeeping.json`. Tasks may be a map (`{ "hq doctor": {ok, summary} }`)
 * or a list with `name`. A proposal without a prompt is dropped: the card's
 * only action is launching it.
 */
export function parseHousekeeping(text: string): BriefHousekeeping | null {
  const root = parseJson(text);
  if (!root) return null;
  const tasks: HousekeepingTask[] = [];
  const rawTasks = root.tasks;
  const entries: [string, Record<string, unknown>][] = Array.isArray(rawTasks)
    ? list(rawTasks).map((t) => [str(t.name) || str(t.id), t])
    : Object.entries(rec(rawTasks)).map(([k, v]) => [k, rec(v)]);
  for (const [name, t] of entries) {
    if (!name) continue;
    tasks.push({ name, ok: t.ok === true, summary: str(t.summary), error: str(t.error) || null });
  }
  const proposals: HousekeepingProposal[] = [];
  for (const [n, p] of list(root.proposals).entries()) {
    const prompt = str(p.prompt);
    const title = str(p.title) || str(p.summary);
    if (!prompt || !title) continue;
    proposals.push({
      id: str(p.id) || `housekeeping-${n}`,
      title,
      frees: str(p.frees) || str(p.fixes) || str(p.impact) || "",
      risk: str(p.risk),
      prompt,
    });
  }
  return { tasks, proposals };
}
