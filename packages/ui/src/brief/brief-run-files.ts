/**
 * Parsers for a run's synthesized files: `brief.json` (items with launch
 * prompts) and `housekeeping.json` (cleanup results and proposals). Both are
 * written by a model, so every field is optional and a bad item is dropped,
 * never guessed at.
 */

import type { BriefDecision, BriefDecisionAction, BriefRisk, BriefWaiting } from "./brief-types.js";

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

/** `brief.json`, or null when it is not a JSON object. */
export function parseBriefItems(text: string, companyUid: string | null): BriefRunItems | null {
  const root = parseJson(text);
  if (!root) return null;
  const items = root.items;
  const origin = (i: Record<string, unknown>) => ({ companyUid, repo: str(i.repo) || null });

  const decisions: BriefDecision[] = [];
  for (const [n, d] of itemGroup(items, "decisions").entries()) {
    const title = str(d.title);
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
        source: str(d.source) || "Daily brief",
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
    incidents.push({
      id: str(r.id) || `brief-incident-${n}`,
      title,
      summary: str(r.summary) || str(r.why) || "",
      severity: str(r.severity) === "watch" ? "watch" : "incident",
      links: [],
      origin: origin(r),
      ...(prompt ? { prompt } : {}),
    });
  }

  return {
    runId: str(root.run_id) || null,
    generatedAt: str(root.generated_at) || null,
    catchUp: root.catch_up === true,
    decisions,
    waiting,
    incidents,
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
