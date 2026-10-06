/**
 * OWNER-R4: the Atlas "People & agents" list, from the same read the web
 * Atlas uses (hq-pro `GET /v1/telemetry/company`, last 30 days): one row per
 * member or agent with tokens, sessions, stories, top skill and a daily trend,
 * sorted by tokens like the web pane (hq-console atlas-people.ts).
 *
 * The web also matches each person to projects and repos through the Console
 * work-mesh lens, which this app does not read. Here a person lights up the
 * skills they ran (`totals.skills.bySkill`), which the read does carry.
 */

import type { AtlasNode } from "./atlas-model.js";

export interface AtlasPerson {
  id: string;
  name: string;
  bot: boolean;
  tokens: number;
  sessions: number;
  stories: number;
  topSkill: string;
  trend: number[];
  skills: string[];
}

export type AtlasPeopleState =
  | { status: "idle" | "loading" }
  | { status: "ok"; people: AtlasPerson[]; names?: ReadonlyMap<string, string> }
  | { status: "failed"; forbidden: boolean };

export const ATLAS_PEOPLE_DAYS = 30;

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Token total from either wire shape: per-model rows, or one totals object. */
function tokenTotal(rows: unknown, flat?: unknown): number {
  const one = (row: unknown): number => {
    const r = rec(row);
    return (
      num(r.input ?? r.inputTokens) +
      num(r.output ?? r.outputTokens) +
      num(r.cacheCreation ?? r.cacheCreationTokens) +
      num(r.cacheRead ?? r.cacheReadTokens)
    );
  };
  const flatTotal = one(flat);
  if (flatTotal > 0) return flatTotal;
  const list = Array.isArray(rows) ? rows : Object.values(rec(rows));
  return list.reduce<number>((sum, row) => sum + one(row), 0);
}

/** Skill counts from `{ bySkill: [{ skill, count }] }` or a plain `{ skill: count }` map. */
function skillCounts(raw: unknown): { skill: string; count: number }[] {
  const skills = rec(raw);
  const rows = Array.isArray(skills.bySkill)
    ? skills.bySkill.map((s) => ({ skill: String(rec(s).skill ?? ""), count: num(rec(s).count) }))
    : Object.entries(skills).map(([skill, v]) => ({ skill, count: typeof v === "number" ? num(v) : num(rec(v).count) }));
  return rows.filter((s) => s.skill && s.count > 0).sort((a, b) => b.count - a.count);
}

/**
 * Display names by person or agent uid from the telemetry `identities` block.
 * It names every member and agent, including ones with no activity in the
 * window, so the live list can show a name where presence only has an id.
 */
export function atlasNamesFromTelemetry(body: unknown): Map<string, string> {
  const identities = rec(rec(body).identities);
  const out = new Map<string, string>();
  for (const group of [identities.persons, identities.agents]) {
    for (const [uid, raw] of Object.entries(rec(group))) {
      const name = rec(raw).name;
      if (typeof name === "string" && name.trim() && !/^(prs|agt)_/.test(name.trim())) out.set(uid, name.trim());
    }
  }
  return out;
}

/** One trend point: a number, or a daily row carrying events or tokens. */
function trendPoint(raw: unknown): number {
  if (typeof raw === "number") return num(raw);
  const r = rec(raw);
  return num(r.events) || tokenTotal(r.tokensByModel, r.tokens) || num(r.sessions ?? r.distinctSessions);
}

/**
 * Parse the company telemetry body. hq-pro has sent two shapes: the rollup
 * (`perMember[]` with `totals` and a label on each row) and the current one
 * (`members[]` with the totals on the row and names in `identities`). Both
 * are read; anything else throws.
 */
export function atlasPeopleFromTelemetry(body: unknown): AtlasPerson[] {
  const root = rec(body);
  const rows = Array.isArray(root.perMember) ? root.perMember : Array.isArray(root.members) ? root.members : null;
  if (!rows) throw new Error("company telemetry: perMember and members both missing");
  const identities = rec(root.identities);
  const named = { ...rec(identities.persons), ...rec(identities.agents) };
  const out: AtlasPerson[] = [];
  for (const raw of rows) {
    const m = rec(raw);
    const id = String(m.personUid ?? m.agentUid ?? "");
    if (!id) continue;
    const totals = m.totals ? rec(m.totals) : m;
    const identity = rec(named[id]);
    const bot = id.startsWith("agt_") || m.kind === "agent" || identity.type === "agent";
    const label = [m.label, m.displayName, identity.displayName, identity.name].find((v): v is string => typeof v === "string" && !!v.trim())?.trim() ?? "";
    const email =
      (typeof m.email === "string" ? m.email.trim() : "") ||
      (typeof identity.email === "string" ? identity.email.trim() : "");
    // Never an id on screen.
    const name = label && !/^(prs|agt)_/.test(label) ? label : email || (bot ? "Unknown bot" : "Unnamed member");
    const bySkill = skillCounts(totals.skills);
    const tokens = tokenTotal(totals.tokensByModel, totals.tokens);
    const sessions = num(totals.distinctSessions);
    if (tokens === 0 && sessions === 0 && bySkill.length === 0) continue;
    out.push({
      id,
      name,
      bot,
      tokens,
      sessions,
      stories: num(rec(rec(m.outcomes ?? totals.outcomes).byType).storyCompleted),
      topSkill: bySkill[0]?.skill ?? "",
      trend: arr(m.trend).map(trendPoint),
      skills: bySkill.map((s) => s.skill),
    });
  }
  return out.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

const skillKey = (s: string) => {
  const k = s.trim().replace(/^\/+/, "").toLowerCase();
  const i = k.lastIndexOf(":");
  return i >= 0 ? k.slice(i + 1) : k;
};

/** Skill objects on the map that this person ran in the window. */
export function atlasPersonNodeIds(person: AtlasPerson, nodes: readonly AtlasNode[]): Set<string> {
  const keys = new Set(person.skills.map(skillKey));
  return new Set(nodes.filter((n) => n.type === "skill" && keys.has(skillKey(n.label))).map((n) => n.id));
}


/** A failed read is "forbidden" when the caller is not an owner or admin. */
export function isForbidden(err: unknown): boolean {
  const text = err instanceof Error ? `${(err as Error & { code?: string }).code ?? ""} ${err.message}` : String(err);
  return /403|forbidden|not.?allowed|permission/i.test(text);
}
