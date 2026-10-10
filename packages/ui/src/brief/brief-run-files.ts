/**
 * Parsers for a run's synthesized files: `brief.json` (items with launch
 * prompts) and `housekeeping.json` (cleanup results and proposals). Both are
 * written by a model, so every field is optional and a bad item is dropped,
 * never guessed at.
 */

import { humanTitle } from "./brief-distill.js";
import type { BriefDecision, BriefDecisionAction, BriefPriority, BriefRisk, BriefTodo, BriefWaiting } from "./brief-types.js";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface BriefRunItems {
  runId: string | null;
  generatedAt: string | null;
  catchUp: boolean;
  decisions: BriefDecision[];
  waiting: BriefWaiting[];
  incidents: BriefRisk[];
  /** Today's priorities, at most five, as the writer ranked them; empty in older briefs. */
  priorities: BriefPriority[];
  /** What each meeting decided and left to do, matched to meetings by title. */
  meetings: { title: string; decided: string[]; todo: BriefTodo[] }[];
  learnedNotes: string[];
}

const ACTIONS: readonly BriefDecisionAction[] = ["cut", "go", "decide", "reply", "prep"];

/** `items` may be `{ decisions: [...] }` or a flat list tagged with `kind`. */
function itemGroup(items: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(items)) {
    const singular = key.replace(/s$/, "");
    return list(items).filter((i) => str(i.kind) === key || str(i.kind) === singular);
  }
  return list(rec(items)[key]);
}

/** A red-main-CI incident: from the main_health sweep, or naming a workflow. */
function isCi(r: Record<string, unknown>): boolean {
  return str(r.source) === "main_health" || str(r.kind) === "ci" || !!str(r.workflow);
}

/** Repo, workflow, job and how long it has been red, from the item or its title. */
function ciDetail(r: Record<string, unknown>, title: string): NonNullable<BriefRisk["ci"]> {
  const quoted = title.match(/['"‘“]([^'"’”]+)['"’”]/)?.[1] ?? null;
  const age = r.age_hours;
  return {
    repo: str(r.repo) || title.split(":")[0]!.trim(),
    workflow: str(r.workflow) || quoted,
    job: str(r.job) || null,
    since: str(r.red_since) || str(r.since) || null,
    ageHours: typeof age === "number" && Number.isFinite(age) ? age : null,
    note: str(r.why) || str(r.summary) || null,
  };
}

/** `brief.json`, or null when it is not a JSON object. */
export function parseBriefItems(text: string, companyUid: string | null): BriefRunItems | null {
  const root = parseJson(text);
  if (!root) return null;
  const items = root.items;
  const origin = (i: Record<string, unknown>) => ({ companyUid, repo: str(i.repo) || null, ...(str(i.product) ? { product: str(i.product) } : {}) });

  const decisions: BriefDecision[] = [];
  for (const [n, d] of itemGroup(items, "decisions").entries()) {
    // A to-do, not a PR: "<repo> #12: feat(x): ..." loses its reference and prefix.
    const { text: title, ref } = humanTitle(str(d.title));
    if (!title) continue;
    const action = ACTIONS.find((a) => a === str(d.action)) ?? "decide";
    const prompt = str(d.prompt);
    decisions.push({
      id: str(d.id) || `brief-decision-${n}`,
      title,
      summary: str(d.summary) || str(d.why) || title,
      action,
      origin: origin(d),
      ...(prompt ? { prompt } : {}),
      detail: {
        why: str(d.why) || title,
        unlocks: (Array.isArray(d.unlocks) ? d.unlocks : [])
          .map((u) => (typeof u === "string" ? u.trim() : str(rec(u).label)))
          .filter(Boolean)
          .map((label) => ({ label, state: "" })),
        ...(str(d.risk) ? { risk: str(d.risk) } : {}),
        source: [ref, str(d.source) || "Daily brief"].filter(Boolean).join(" · "),
      },
    });
  }

  const waiting: BriefWaiting[] = [];
  for (const [n, w] of itemGroup(items, "waiting").entries()) {
    const who = str(w.who) || str(w.person);
    const what = str(w.what) || str(w.title);
    if (!who || !what) continue;
    const prompt = str(w.prompt);
    waiting.push({ id: str(w.id) || `brief-waiting-${n}`, who, what, ...(prompt ? { prompt } : {}) });
  }

  const incidents: BriefRisk[] = [];
  for (const [n, r] of itemGroup(items, "incidents").entries()) {
    const title = str(r.title);
    if (!title) continue;
    const prompt = str(r.prompt);
    const rawLinks: unknown[] = Array.isArray(r.fixes) ? r.fixes : Array.isArray(r.links) ? r.links : [];
    const links = rawLinks
      .map((x) => {
        if (typeof x === "string") return { label: x.trim(), origin: { companyUid, repo: null } };
        const l = rec(x);
        const num = typeof l.number === "number" ? `#${l.number}` : "";
        return { label: str(l.label) || str(l.title) || `${str(l.repo)} ${num}`.trim(), origin: { companyUid, repo: str(l.repo) || null } };
      })
      .filter((l) => l.label);
    incidents.push({
      id: str(r.id) || `brief-incident-${n}`,
      title,
      summary: str(r.summary) || str(r.why) || "",
      severity: str(r.severity) === "watch" ? "watch" : "incident",
      links,
      origin: origin(r),
      ...(prompt ? { prompt } : {}),
      ...(isCi(r) ? { ci: ciDetail(r, title) } : {}),
    });
  }

  const priorities: BriefPriority[] = list(root.priorities)
    .map((p, i) => ({
      n: typeof p.n === "number" && Number.isFinite(p.n) ? p.n : i + 1,
      text: str(p.text) || str(p.title),
      because: str(p.because) || null,
      itemId: str(p.item_id) || null,
    }))
    .filter((p) => p.text)
    .sort((a, b) => a.n - b.n)
    .slice(0, 5);

  const meetings = itemGroup(items, "meetings")
    .map((m) => ({
      title: str(m.title) || str(m.meeting) || str(m.name),
      decided: (Array.isArray(m.decided) ? m.decided : []).map((d) => (typeof d === "string" ? d.trim() : str(rec(d).text))).filter(Boolean),
      todo: (Array.isArray(m.todo) ? m.todo : [])
        .map((t): BriefTodo => (typeof t === "string" ? { text: t.trim() } : { text: str(rec(t).text), owner: str(rec(t).owner) || null, mine: rec(t).mine === true }))
        .filter((t) => t.text),
    }))
    .filter((m) => m.title);

  return {
    runId: str(root.run_id) || null,
    generatedAt: str(root.generated_at) || null,
    catchUp: root.catch_up === true,
    decisions,
    waiting,
    incidents,
    priorities,
    meetings,
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
