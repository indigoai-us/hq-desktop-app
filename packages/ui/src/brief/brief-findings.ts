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
 * A sample with no company, or any other company, is dropped. Newest last,
 * at most eight; titles are cut to one short line.
 */
export function parseSamples(raw: unknown, company: string | null): BriefSample[] {
  if (!Array.isArray(raw) || !company?.trim()) return [];
  const own = norm(company);
  const out: BriefSample[] = [];
  for (const item of raw) {
    const r = rec(item);
    const title = str(r.title).replace(/\s+/g, " ");
    const co = str(r.company);
    if (!title || !co || norm(co) !== own) continue;
    const clean = humanTitle(title).text;
    out.push({ kind: str(r.kind) || "item", title: clean.length > 90 ? `${clean.slice(0, 89).trimEnd()}…` : clean, company: co, at: str(r.at) });
  }
  return out.slice(-8);
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

/**
 * Every counter before the run has reported anything: the same fixed tiles,
 * all without a value, so the bento holds its shape from the first frame.
 */
export function pendingFindingRows(): FindingRow[] {
  return findingRows({
    signals: { decision: 0, action_item: 0, risk: 0, commitment: 0, key_point: 0 },
    sessions: 0,
    meetings: 0,
    dms: { total: 0, need_you: 0 },
    prs: { merged: 0, open: 0, review_requested: 0 },
    ci_red: 0,
    agents: { total: 0, attention: 0 },
    integrations: {},
    seen: [],
  });
}

/** Where a counter tile is: no value yet, counted and empty, or counted with something in it. */
export type FindingState = "pending" | "zero" | "found";

export function findingState(row: Pick<FindingRow, "value">): FindingState {
  return row.value == null ? "pending" : row.value > 0 ? "found" : "zero";
}

/** The brief's colour fields a counter tile can wear (brief.css `.slot[data-field]`). */
export type FindingField = "violet" | "teal" | "pink" | "sunset" | "sky" | "mono";

/**
 * The colour field a counter fills with once it has something in it, by
 * meaning, as the finished brief colours the same things: decisions violet,
 * done work teal, risk and red CI pink, commitments sunset, DMs sky. Every
 * other count, and any count that came back empty, stays a monochrome tile in
 * page ink, so colour lands only on what the brief will be about.
 */
export function findingField(row: Pick<FindingRow, "key" | "tone" | "value">): FindingField {
  if (findingState(row) !== "found") return "mono";
  if (row.key === "dms") return "sky";
  switch (row.tone) {
    case "decision":
      return "violet";
    case "ok":
      return "teal";
    case "red":
      return "pink";
    case "sun":
      return "sunset";
    default:
      return "mono";
  }
}

export interface SampleCompany {
  /** Display name for CompanyLabel. */
  name: string;
  uid: string | null;
  iconUrl: string | null;
}

/**
 * The company a sample card names, matched against the companies the page
 * knows (by uid, slug or label, any case) so it shows the real label and
 * icon. A company the page does not know keeps its own name, made readable.
 */
export function sampleCompany(
  company: string,
  companies: readonly { uid: string; slug?: string | null; label: string; iconUrl?: string | null }[] = [],
): SampleCompany {
  const k = norm(company);
  const hit = companies.find((c) => [c.uid, c.slug ?? "", c.label].some((v) => v && norm(v) === k));
  if (hit) return { name: hit.label, uid: hit.uid, iconUrl: hit.iconUrl ?? null };
  const plain = company.trim().replace(/^cmp_/i, "").replace(/[_-]+/g, " ").trim();
  return { name: plain ? plain[0]!.toUpperCase() + plain.slice(1) : company, uid: company.trim() || null, iconUrl: null };
}

/** A sample's kind as a short label for its mono pill: "action_item" -> "action item". */
export function sampleKindLabel(kind: string): string {
  return kind.replace(/[_-]+/g, " ").trim() || "item";
}
