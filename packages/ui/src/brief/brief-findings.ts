/**
 * What a run has found so far (status.json `findings` and `samples`), shaped
 * for the counters and sample cards under the sunrise.
 *
 * Samples are proof of what the bot is finding, so they are held to the
 * brief's isolation rule here as well as in the skill: only the run's own
 * company, never another company's items, and never a DM body (the skill
 * sends a sender and a summary).
 */

import { humanTitle } from "./brief-distill.js";

export interface BriefFindings {
  signals: { decision: number; action_item: number; risk: number; commitment: number; key_point: number };
  sessions: number;
  meetings: number;
  dms: { total: number; need_you: number };
  prs: { merged: number; open: number; review_requested: number };
  ci_red: number;
  agents: { total: number; attention: number };
  integrations: Record<string, number>;
  /**
   * Counter keys the run has reported (see findingRows). A tile whose key is
   * missing has no value yet and shows "—". Absent: every count is known.
   */
  seen?: string[];
}

export interface BriefSample {
  kind: string;
  title: string;
  company: string;
  at: string;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** status.json `findings`, or null when the run has not reported any. */
export function parseFindings(raw: unknown): BriefFindings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = rec(raw);
  const s = rec(r.signals);
  const d = rec(r.dms);
  const p = rec(r.prs);
  const a = rec(r.agents);
  const integrations: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec(r.integrations))) if (n(v)) integrations[k] = n(v);
  const has = (o: Record<string, unknown>, k: string) => typeof o[k] === "number" && Number.isFinite(o[k]);
  const seen = [
    ...(["decision", "action_item", "risk", "commitment", "key_point"] as const).filter((k) => has(s, k)),
    ...(has(r, "meetings") ? ["meetings"] : []),
    ...(has(r, "sessions") ? ["sessions"] : []),
    ...(has(d, "total") ? ["dms"] : []),
    ...(has(p, "merged") ? ["prs"] : []),
    ...(has(p, "open") ? ["prs_open"] : []),
    ...(has(r, "ci_red") ? ["ci_red"] : []),
    ...(has(a, "total") ? ["agents"] : []),
  ];
  return {
    signals: { decision: n(s.decision), action_item: n(s.action_item), risk: n(s.risk), commitment: n(s.commitment), key_point: n(s.key_point) },
    sessions: n(r.sessions),
    meetings: n(r.meetings),
    dms: { total: n(d.total), need_you: n(d.need_you) },
    prs: { merged: n(p.merged), open: n(p.open), review_requested: n(p.review_requested) },
    ci_red: n(r.ci_red),
    agents: { total: n(a.total), attention: n(a.attention) },
    integrations,
    seen,
  };
}

const norm = (v: string) => v.trim().toLowerCase();

/**
 * status.json `samples`, kept only when they belong to the run's company.
 * Person mode (null) keeps personal samples and every company separately.
 * Newest last, at most eight per company; titles are cut to one short line.
 */
export function parseSamples(raw: unknown, company: string | null): BriefSample[] {
  if (!Array.isArray(raw)) return [];
  const own = company?.trim() ? norm(company) : null;
  const out: BriefSample[] = [];
  for (const item of raw) {
    const r = rec(item);
    const title = str(r.title).replace(/\s+/g, " ");
    const co = str(r.company);
    if (!title || (own !== null && norm(co) !== own)) continue;
    const clean = humanTitle(title).text;
    out.push({ kind: str(r.kind) || "item", title: clean.length > 90 ? `${clean.slice(0, 89).trimEnd()}…` : clean, company: co, at: str(r.at) });
  }
  if (own !== null) return out.slice(-8);
  const groups = new Map<string, BriefSample[]>();
  for (const sample of out) {
    const key = norm(sample.company);
    groups.set(key, [...(groups.get(key) ?? []), sample].slice(-8));
  }
  const retained = new Set([...groups.values()].flat());
  return out.filter(sample => retained.has(sample));
}

/** Meaning of a counter, which picks its color (the brief's widget tones). */
export type FindingTone = "decision" | "ok" | "warn" | "red" | "neutral" | "sun";

export interface FindingRow {
  key: string;
  label: string;
  /** null: the run has not reported this count yet; the tile shows "—". */
  value: number | null;
  tone: FindingTone;
  /** A second number in the row, e.g. "4 need you". */
  sub?: { value: number; label: string };
}

/**
 * The counters to show: a fixed set in a fixed order, so tiles never reorder
 * or reflow as counts arrive. A count not reported yet has a null value.
 * Integrations follow, in the order they first appear.
 */
export function findingRows(f: BriefFindings): FindingRow[] {
  const rows: FindingRow[] = [
    { key: "decision", label: "Decisions", value: f.signals.decision, tone: "decision" },
    { key: "action_item", label: "Action items", value: f.signals.action_item, tone: "ok" },
    { key: "risk", label: "Risks", value: f.signals.risk, tone: "red" },
    { key: "commitment", label: "Commitments", value: f.signals.commitment, tone: "sun" },
    { key: "key_point", label: "Key points", value: f.signals.key_point, tone: "neutral" },
    { key: "meetings", label: "Meetings", value: f.meetings, tone: "neutral" },
    { key: "sessions", label: "Sessions", value: f.sessions, tone: "neutral" },
    { key: "dms", label: "DMs", value: f.dms.total, tone: "neutral", ...(f.dms.need_you ? { sub: { value: f.dms.need_you, label: "need you" } } : {}) },
    {
      key: "prs",
      label: "PRs merged",
      value: f.prs.merged,
      tone: "ok",
      ...(f.prs.review_requested ? { sub: { value: f.prs.review_requested, label: "to review" } } : {}),
    },
    { key: "prs_open", label: "PRs open", value: f.prs.open, tone: "neutral" },
    { key: "ci_red", label: "CI red", value: f.ci_red, tone: "red" },
    {
      key: "agents",
      label: "Agents",
      value: f.agents.total,
      tone: "neutral",
      ...(f.agents.attention ? { sub: { value: f.agents.attention, label: "need attention" } } : {}),
    },
    ...Object.entries(f.integrations).map(([app, v]): FindingRow => ({ key: `int:${app}`, label: app, value: v, tone: "neutral" })),
  ];
  const seen = f.seen ? new Set(f.seen) : null;
  return rows.map((r) => (seen && !r.key.startsWith("int:") && !seen.has(r.key) ? { ...r, value: null, sub: undefined } : r));
}

/** Color of a sample card's kind tag. */
export function sampleTone(kind: string): FindingTone {
  const k = kind.toLowerCase();
  if (k.includes("decision") || k.includes("question")) return "decision";
  if (k.includes("risk") || k.includes("incident") || k.includes("ci")) return "red";
  if (k.includes("action") || k.includes("pr") || k.includes("ship")) return "ok";
  if (k.includes("commit")) return "sun";
  if (k.includes("dm") || k.includes("wait")) return "warn";
  return "neutral";
}
